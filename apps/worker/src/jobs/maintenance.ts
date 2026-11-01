/** Outbox dispatch marker, backup trigger, retention cleanup and heartbeat. */
import { execFile } from 'node:child_process';
import type pg from 'pg';
import { withInstallation, withTenant } from '@blackbox/connectors';
import type { Clock } from './../clock.js';
import type { Logger } from './../logger.js';
import type { StorageState } from './../storage.js';

/** Marks outbox rows as dispatched (observed by the worker) in sequence order per tenant and notifies the engine. */
export async function dispatchOutbox(pool: pg.Pool, logger: Logger, batch = 500): Promise<number> {
  const tenants = await withInstallation(pool, async (c) => (await c.query<{ tenant_id: string }>('SELECT tenant_id FROM tenants')).rows.map((r) => r.tenant_id));
  let total = 0;
  for (const tenant_id of tenants) {
    const n = await withTenant(pool, tenant_id, async (client) => {
      const r = await client.query<{ journal_sequence: string }>(
        `UPDATE outbox SET dispatched_at = now() WHERE outbox_id IN (SELECT outbox_id FROM outbox WHERE dispatched_at IS NULL ORDER BY journal_sequence LIMIT $1) RETURNING journal_sequence`, [batch]);
      if (r.rowCount) await client.query('SELECT pg_notify($1, $2)', ['journal_dispatched', `${tenant_id}:${r.rows[r.rows.length - 1]!.journal_sequence}`]);
      return r.rowCount ?? 0;
    });
    if (n) logger.log('debug', 'outbox.dispatched', 'outbox rows marked dispatched', { tenant_id, record_count: n });
    total += n;
  }
  return total;
}

/** Runs the configured backup command (BACKUP_COMMAND, e.g. the wrapper's blackbox-backup script). Never a shell string. */
export async function runBackup(pool: pg.Pool, logger: Logger, instance_id: string, command: string | null, clock: Clock, storage: StorageState): Promise<{ outcome: string; detail: Record<string, unknown> }> {
  const started = clock.now();
  if (!command) {
    await logJob(pool, instance_id, 'backups.due', started, 'skipped', { reason: 'BACKUP_COMMAND not configured' });
    logger.log('info', 'backup.skipped', 'no backup command configured; backups.due is a no-op', { action_code: 'configure_backup' });
    return { outcome: 'skipped', detail: { reason: 'not_configured' } };
  }
  if (storage.state === 'critical') {
    await logJob(pool, instance_id, 'backups.due', started, 'skipped', { reason: 'storage_critical' });
    logger.log('warn', 'backup.skipped', 'storage critical; backup not started', { error_code: 'storage_critical' });
    return { outcome: 'skipped', detail: { reason: 'storage_critical' } };
  }
  const [file, ...args] = command.split(/\s+/);
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    execFile(file!, args, { timeout: 60 * 60 * 1000, env: { ...process.env } }, (err, _stdout, stderr) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stderr: String(stderr).slice(0, 500) }));
  });
  const outcome = result.code === 0 ? 'completed' : 'failed';
  await logJob(pool, instance_id, 'backups.due', started, outcome, { exit_code: result.code, duration_ms: clock.now().getTime() - started.getTime() });
  logger.log(outcome === 'completed' ? 'info' : 'error', `backup.${outcome}`, `backup command ${outcome}`, { error_code: outcome === 'failed' ? `exit_${result.code}` : undefined, duration_ms: clock.now().getTime() - started.getTime() });
  return { outcome, detail: { exit_code: result.code } };
}

/** Hourly retention: bounded operational tables only. The journal and evidence are never touched here. */
export async function retentionCleanup(pool: pg.Pool, logger: Logger, instance_id: string, clock: Clock): Promise<Record<string, number>> {
  const started = clock.now();
  const deleted: Record<string, number> = {};
  deleted.worker_job_log = (await withInstallation(pool, (c) => c.query("DELETE FROM worker_job_log WHERE started_at < now() - interval '30 days'"))).rowCount ?? 0;
  const tenants = await withInstallation(pool, async (c) => (await c.query<{ tenant_id: string }>('SELECT tenant_id FROM tenants')).rows.map((r) => r.tenant_id));
  deleted.worker_dead_letters = 0;
  for (const tenant_id of tenants) {
    deleted.worker_dead_letters += (await withTenant(pool, tenant_id, (c) => c.query("DELETE FROM worker_dead_letters WHERE resolved_at IS NOT NULL AND resolved_at < now() - interval '90 days'"))).rowCount ?? 0;
  }
  await logJob(pool, instance_id, 'retention.cleanup', started, 'completed', deleted);
  logger.log('info', 'retention.completed', 'operational retention cleanup completed', { record_count: Object.values(deleted).reduce((a, b) => a + b, 0) });
  return deleted;
}

export async function heartbeat(pool: pg.Pool, p: { instance_id: string; service_version: string; started_at: Date; clock: Clock; storage: StorageState; queues: Record<string, unknown>; suspension?: { at: Date; gap_ms: number } | null; stopped?: boolean }): Promise<void> {
  await withInstallation(pool, (c) => c.query(
    `INSERT INTO worker_heartbeat (instance_id, service_version, started_at, last_beat_at, wall_clock_at, monotonic_ms, suspension_detected_at, suspension_gap_ms, storage_state, storage_detail, queues, stopped_at)
     VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
     ON CONFLICT (instance_id) DO UPDATE SET last_beat_at = now(), wall_clock_at = EXCLUDED.wall_clock_at, monotonic_ms = EXCLUDED.monotonic_ms,
       suspension_detected_at = COALESCE(EXCLUDED.suspension_detected_at, worker_heartbeat.suspension_detected_at), suspension_gap_ms = COALESCE(EXCLUDED.suspension_gap_ms, worker_heartbeat.suspension_gap_ms),
       storage_state = EXCLUDED.storage_state, storage_detail = EXCLUDED.storage_detail, queues = EXCLUDED.queues, stopped_at = EXCLUDED.stopped_at`,
    [p.instance_id, p.service_version, p.started_at, p.clock.now(), p.clock.monotonicMs(), p.suspension?.at ?? null, p.suspension?.gap_ms ?? null, p.storage.state, JSON.stringify({ volumes: p.storage.volumes, thresholds: p.storage.thresholds, observed_at: p.storage.observed_at }), JSON.stringify(p.queues), p.stopped ? p.clock.now() : null]));
}

async function logJob(pool: pg.Pool, instance_id: string, job: string, started: Date, outcome: string, detail: Record<string, unknown>): Promise<void> {
  await withInstallation(pool, (c) => c.query('INSERT INTO worker_job_log (instance_id, job_name, started_at, finished_at, outcome, detail) VALUES ($1, $2, $3, now(), $4, $5::jsonb)', [instance_id, job, started, outcome, JSON.stringify(detail)]));
}
