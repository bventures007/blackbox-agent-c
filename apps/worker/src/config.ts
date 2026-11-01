/** Worker configuration from the environment. No secrets on the command line; nothing is logged. */
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface WorkerConfig {
  database_url: string;
  instance_id: string;
  service_version: string;
  scheduler_tick_ms: number;
  max_concurrent_polls: number;
  /** Spread between coalesced overdue jobs after wake (ms). */
  wake_spread_ms: number;
  /** Wall-clock vs monotonic drift that counts as a suspension (ms). */
  suspension_threshold_ms: number;
  lease_seconds: number;
  max_pages_per_job: number;
  evidence_dir: string;
  storage_paths: string[];
  storage_check_ms: number;
  backup_command: string | null;
  backup_cron: string;
  retention_cron: string;
  outbox_interval_ms: number;
  heartbeat_ms: number;
  log_level: string;
  pgboss_schema: string;
  /** Hard cap on retries before a job is dead-lettered (visible). */
  job_retry_limit: number;
  /** Shared logs directory (LOGS_DIR / LOG_DIR); null = stderr only. */
  logs_dir: string | null;
  /** Host-wrapper fence directory (FENCE_DIR): writers.paused.json pauses all provider work. */
  fence_dir: string | null;
}

/** Compose release convention: PGHOST/PGPORT/PGDATABASE + PGUSER + PGPASSWORD_FILE (never a password in env/argv). */
export function databaseUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const user = env.PGUSER;
  const file = env.PGPASSWORD_FILE;
  if (!user || !file) return undefined;
  let password: string;
  try { password = readFileSync(file, 'utf8').trim(); } catch { return undefined; }
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${env.PGHOST ?? '127.0.0.1'}:${env.PGPORT ?? '5432'}/${env.PGDATABASE ?? 'blackbox'}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const url = env.DATABASE_URL_WORKER ?? env.WORKER_DATABASE_URL ?? databaseUrlFromEnv(env);
  if (!url) throw new Error('DATABASE_URL_WORKER (bb_worker role) or PGHOST/PGUSER/PGPASSWORD_FILE is required');
  const num = (name: string, def: number, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const v = env[name] === undefined ? def : Number(env[name]);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
    return v;
  };
  return {
    database_url: url,
    instance_id: env.WORKER_INSTANCE_ID ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`,
    service_version: env.SERVICE_VERSION ?? env.BLACKBOX_VERSION ?? '0.1.0-dev',
    scheduler_tick_ms: num('SCHEDULER_TICK_MS', 5000, 250, 600_000),
    max_concurrent_polls: num('MAX_CONCURRENT_POLLS', 2, 1, 16),
    wake_spread_ms: num('WAKE_SPREAD_MS', 15_000, 0, 3_600_000),
    suspension_threshold_ms: num('SUSPENSION_THRESHOLD_MS', 60_000, 1000, 86_400_000),
    lease_seconds: num('LEASE_SECONDS', 300, 30, 3600),
    max_pages_per_job: num('MAX_PAGES_PER_JOB', 200, 1, 100_000),
    evidence_dir: env.EVIDENCE_DIR ?? './data/evidence',
    storage_paths: (env.STORAGE_PATHS ?? env.EVIDENCE_DIR ?? './data').split(':').filter(Boolean),
    storage_check_ms: num('STORAGE_CHECK_MS', 30_000, 1000, 3_600_000),
    backup_command: env.BACKUP_COMMAND || null,
    backup_cron: env.BACKUP_CRON ?? '0 3 * * *',
    retention_cron: env.RETENTION_CRON ?? '15 * * * *',
    outbox_interval_ms: num('OUTBOX_INTERVAL_MS', 2000, 250, 600_000),
    heartbeat_ms: num('HEARTBEAT_MS', 10_000, 1000, 600_000),
    log_level: env.LOG_LEVEL ?? 'info',
    pgboss_schema: env.PGBOSS_SCHEMA ?? 'pgboss',
    job_retry_limit: num('JOB_RETRY_LIMIT', 5, 0, 50),
    logs_dir: env.LOGS_DIR ?? env.LOG_DIR ?? null,
    fence_dir: env.FENCE_DIR ?? null,
  };
}
