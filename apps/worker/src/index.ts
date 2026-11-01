#!/usr/bin/env node
/**
 * Blackbox worker entry point. Binds no listener. PostgreSQL via DATABASE_URL_WORKER (role bb_worker).
 * pg-boss queues: source.run (per-connection/poll-group singleton), outbox.dispatch, backups.due, retention.cleanup.
 */
import { PgBoss } from 'pg-boss';
import { createWorkerPool, FileEvidenceStore, loadKeyring, withInstallation } from '@blackbox/connectors';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { systemClock } from './clock.js';
import { DEFAULT_THRESHOLDS, observeStorage, type StorageState } from './storage.js';
import { SyncEngine } from './sync.js';
import { Scheduler, type ScheduledJob } from './scheduler.js';
import { dispatchOutbox, heartbeat, retentionCleanup, runBackup } from './jobs/maintenance.js';

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ component: 'worker', service_version: config.service_version, instance_id: config.instance_id, level: config.log_level });
  const pool = createWorkerPool(config.database_url, 6);
  const clock = systemClock;
  const startedAt = clock.now();
  let storage: StorageState = { state: 'unknown', observed_at: startedAt.toISOString(), volumes: [], thresholds: DEFAULT_THRESHOLDS };
  let suspension: { at: Date; gap_ms: number } | null = null;

  const refreshStorage = async () => {
    const thresholds = await withInstallation(pool, async (c) => { const r = await c.query<{ warn_percent: number; warn_min_bytes: string; critical_percent: number; critical_min_bytes: string }>('SELECT warn_percent, warn_min_bytes, critical_percent, critical_min_bytes FROM storage_thresholds ORDER BY updated_at DESC LIMIT 1').catch(() => ({ rows: [] })); const t = r.rows[0]; return t ? { warn_percent: t.warn_percent, warn_min_bytes: Number(t.warn_min_bytes), critical_percent: t.critical_percent, critical_min_bytes: Number(t.critical_min_bytes) } : DEFAULT_THRESHOLDS; });
    const next = await observeStorage(config.storage_paths, thresholds);
    if (next.state !== storage.state) logger.log(next.state === 'critical' ? 'error' : next.state === 'warning' ? 'warn' : 'info', 'storage.state_changed', `storage ${next.state}`, { action_code: next.state === 'critical' ? 'free_disk_space' : undefined });
    storage = next;
    return next;
  };
  await refreshStorage();

  const engine = new SyncEngine({ pool, logger, clock, evidence: new FileEvidenceStore(config.evidence_dir), keyring: loadKeyring(), storage: refreshStorage, lease_seconds: config.lease_seconds, max_pages_per_job: config.max_pages_per_job, instance_id: config.instance_id });

  const boss = new PgBoss({ connectionString: config.database_url, schema: config.pgboss_schema, application_name: 'blackbox-worker-boss', max: 3 });
  boss.on('error', () => { logger.log('error', 'worker.boss_error', 'pg-boss error', { error_code: 'pgboss', retryable: true }); });
  await boss.start();
  await boss.createQueue('source.dead'); // dead-letter queue must exist before the queue that references it
  await boss.createQueue('source.run', { policy: 'singleton', retryLimit: config.job_retry_limit, retryBackoff: true, retryDelay: 30, expireInSeconds: 3600, deadLetter: 'source.dead' });
  await boss.createQueue('outbox.dispatch', { policy: 'singleton' });
  await boss.createQueue('backups.due', { policy: 'singleton', retryLimit: 0 });
  await boss.createQueue('retention.cleanup', { policy: 'singleton', retryLimit: 0 });

  const dispatch = async (job: ScheduledJob) => {
    await boss.send('source.run', job, { singletonKey: `${job.connection_id}:${job.poll_group}`, startAfter: Math.ceil(job.start_after_ms / 1000), retryLimit: config.job_retry_limit, retryBackoff: true, retryDelay: 30, expireInSeconds: 3600 });
  };
  const scheduler = new Scheduler({ pool, engine, logger, clock, dispatch, max_per_tick: config.max_concurrent_polls * 2, wake_spread_ms: config.wake_spread_ms, suspension_threshold_ms: config.suspension_threshold_ms, lease_seconds: config.lease_seconds, storageCritical: () => storage.state === 'critical' });

  await boss.work<ScheduledJob>('source.run', { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    const result = await engine.executeRun(job.data.tenant_id, job.data.run_id, { attempt: job.retryCount + 1 });
    if (result.state === 'queued' && result.error_code) throw Object.assign(new Error(`run ${result.error_code}`), { code: result.error_code });
  });
  await boss.work<ScheduledJob>('source.dead', async ([job]) => {
    logger.log('error', 'source.dead_letter', 'run exhausted retries; visible in import_runs/worker_dead_letters', { tenant_id: job.data.tenant_id, connection_id: job.data.connection_id, run_id: job.data.run_id, action_code: 'inspect_dead_letter' });
  });
  await boss.work('outbox.dispatch', async () => { await dispatchOutbox(pool, logger); });
  await boss.work('backups.due', async () => { await runBackup(pool, logger, config.instance_id, config.backup_command, clock, storage); });
  await boss.work('retention.cleanup', async () => { await retentionCleanup(pool, logger, config.instance_id, clock); });
  await boss.schedule('backups.due', config.backup_cron, null, { tz: 'UTC' });
  await boss.schedule('retention.cleanup', config.retention_cron, null, { tz: 'UTC' });

  const timers: NodeJS.Timeout[] = [];
  const guard = (name: string, fn: () => Promise<unknown>) => async () => { try { await fn(); } catch (err) { logger.log('error', `${name}.failed`, (err as Error).message, { error_code: (err as { code?: string }).code ?? 'unexpected', retryable: true }); } };
  timers.push(setInterval(guard('scheduler.tick', async () => { const r = await scheduler.tick(); if (r.suspended) suspension = { at: clock.now(), gap_ms: r.gap_ms }; }), config.scheduler_tick_ms));
  timers.push(setInterval(guard('outbox.dispatch', () => dispatchOutbox(pool, logger)), config.outbox_interval_ms));
  timers.push(setInterval(guard('storage.check', refreshStorage), config.storage_check_ms));
  const beat = guard('worker.heartbeat', async () => heartbeat(pool, { instance_id: config.instance_id, service_version: config.service_version, started_at: startedAt, clock, storage, queues: { source_run: (await boss.getQueues(['source.run'])).map((q) => ({ name: q.name, policy: q.policy })) }, suspension }));
  timers.push(setInterval(beat, config.heartbeat_ms));
  await beat();
  logger.log('info', 'worker.started', 'worker started', { action_code: undefined });

  const shutdown = async (signal: string) => {
    logger.log('info', 'worker.stopping', `received ${signal}`);
    for (const t of timers) clearInterval(t);
    await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
    await heartbeat(pool, { instance_id: config.instance_id, service_version: config.service_version, started_at: startedAt, clock, storage, queues: {}, suspension, stopped: true }).catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) main().catch((err) => { process.stderr.write(JSON.stringify({ schema_version: 1, level: 'ERROR', event_name: 'worker.fatal', message: String((err as Error).message).slice(0, 512), component: 'worker' }) + '\n'); process.exit(1); });
