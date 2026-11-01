-- 0100_worker.sql — worker-owned operational state (apps/worker). Extends 0003_operations.sql; no
-- business track lives here. Cursors, leases, dead letters, heartbeat and the pg-boss job schema.

-- Per-capability synchronization state next to its health row (SOURCE-SYNCHRONIZATION.md "mutable
-- synchronization tables"): provider cursors, backfill checkpoint, lease/fencing, backoff, reconciliation.
ALTER TABLE capability_health
  ADD COLUMN IF NOT EXISTS poll_group            text,
  ADD COLUMN IF NOT EXISTS mode                  text NOT NULL DEFAULT 'local_standalone',
  ADD COLUMN IF NOT EXISTS method                text,
  ADD COLUMN IF NOT EXISTS incremental_cursor    jsonb,
  ADD COLUMN IF NOT EXISTS backfill_cursor       jsonb,
  ADD COLUMN IF NOT EXISTS backfill_run_id       uuid,
  ADD COLUMN IF NOT EXISTS last_reconciliation_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_reconciliation_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciliation_cursor jsonb,
  ADD COLUMN IF NOT EXISTS lease_token           text,
  ADD COLUMN IF NOT EXISTS lease_expires_at      timestamptz,
  ADD COLUMN IF NOT EXISTS consecutive_failures  int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_code       text,
  ADD COLUMN IF NOT EXISTS last_error_at         timestamptz,
  ADD COLUMN IF NOT EXISTS retry_after_until     timestamptz,
  ADD COLUMN IF NOT EXISTS throttle_status       jsonb,
  ADD COLUMN IF NOT EXISTS missing_grants        jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS next_action           text,
  ADD COLUMN IF NOT EXISTS updated_at            timestamptz NOT NULL DEFAULT now();

ALTER TABLE import_runs
  ADD COLUMN IF NOT EXISTS capability_scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS conflicts        bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rejected         bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pages            int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_token      text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS coverage_from    timestamptz,
  ADD COLUMN IF NOT EXISTS coverage_to      timestamptz,
  ADD COLUMN IF NOT EXISTS errors           jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Visible dead letters: poison input or exhausted retries. Mutable; sanitized payload only.
CREATE TABLE IF NOT EXISTS worker_dead_letters (
  dead_letter_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(tenant_id),
  connection_id  uuid REFERENCES connections(connection_id),
  capability_id  text,
  run_id         uuid,
  job_name       text NOT NULL,
  reason_code    text NOT NULL,
  detail         text NOT NULL,
  provider_ref   text,
  attempts       int NOT NULL DEFAULT 1,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolution     text
);
CREATE INDEX IF NOT EXISTS worker_dead_letters_open_idx ON worker_dead_letters(tenant_id, created_at DESC) WHERE resolved_at IS NULL;

-- Installation-scoped heartbeat for the diagnostics health card (no tenant data).
CREATE TABLE IF NOT EXISTS worker_heartbeat (
  instance_id        text PRIMARY KEY,
  service_version    text NOT NULL,
  started_at         timestamptz NOT NULL,
  last_beat_at       timestamptz NOT NULL,
  wall_clock_at      timestamptz NOT NULL,
  monotonic_ms       bigint NOT NULL,
  suspension_detected_at timestamptz,
  suspension_gap_ms  bigint,
  storage_state      text NOT NULL DEFAULT 'unknown',
  storage_detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  queues             jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_backup_result jsonb,
  stopped_at         timestamptz
);

-- Bounded audit of worker-run maintenance jobs (backups, retention, outbox dispatch).
CREATE TABLE IF NOT EXISTS worker_job_log (
  job_log_id  bigserial PRIMARY KEY,
  instance_id text NOT NULL,
  job_name    text NOT NULL,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  outcome     text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS worker_job_log_idx ON worker_job_log(job_name, started_at DESC);

ALTER TABLE worker_dead_letters ENABLE ROW LEVEL SECURITY; ALTER TABLE worker_dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON worker_dead_letters FOR ALL TO bb_api, bb_worker USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The worker schedules every workspace from one process: it may enumerate tenant ids (display names
-- only) and then opens one tenant-scoped transaction per workspace. No other tenant table is widened.
CREATE POLICY worker_enumerate ON tenants FOR SELECT TO bb_worker USING (true);

GRANT SELECT, INSERT, UPDATE ON worker_dead_letters TO bb_api, bb_worker;
GRANT SELECT, INSERT, UPDATE ON worker_heartbeat, worker_job_log TO bb_worker;
GRANT SELECT ON worker_heartbeat, worker_job_log TO bb_api;
GRANT DELETE ON worker_job_log, worker_dead_letters TO bb_worker;
GRANT USAGE, SELECT ON SEQUENCE worker_job_log_job_log_id_seq TO bb_worker;

-- pg-boss job storage: owned by the worker role inside its own schema; never a business table.
-- pg-boss issues CREATE SCHEMA IF NOT EXISTS on start, which PostgreSQL only permits with CREATE on
-- the database even when the schema already exists; bb_migrate owns the database and grants it here.
-- This lets bb_worker create schemas in this database only; public-schema objects stay owned by bb_migrate.
CREATE SCHEMA IF NOT EXISTS pgboss;
GRANT USAGE, CREATE ON SCHEMA pgboss TO bb_worker;
DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO bb_worker', current_database()); END $$;
