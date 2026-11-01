-- 0003_operations.sql — mutable operational tables: import plans/runs, capability health,
-- review cases/actions, debug sessions, backup status, retention/storage settings and the
-- evidence redaction ledger (IMPORT-ONBOARDING-AND-DATA-READINESS.md §3, PILOT-OPERATIONS §1/§3/§5,
-- SYSTEM-AND-DIAGNOSTICS.md). None of these tables is a business track.

-- Owner-editable workspace settings (locale, display preferences); one row per tenant.
CREATE TABLE workspace_settings (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(tenant_id),
  locale      text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','de')),
  timezone    text NOT NULL DEFAULT 'Europe/Berlin',
  history_start timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_plans (
  plan_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(tenant_id),
  connection_id        uuid NOT NULL REFERENCES connections(connection_id),
  plan_revision        int NOT NULL DEFAULT 1,
  preset               text NOT NULL CHECK (preset IN ('last_30_days','this_year','last_12_months','custom','from_now')),
  timezone             text NOT NULL,
  requested_from       timestamptz,
  initial_cutoff       timestamptz NOT NULL,
  include_open_context boolean NOT NULL DEFAULT true,
  include_opening_state boolean NOT NULL DEFAULT true,
  strict_from_now      boolean NOT NULL DEFAULT false,
  local_from_label     text,
  local_cutoff_label   text,
  restrictions         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  superseded_at        timestamptz,
  UNIQUE (connection_id, plan_revision)
);
CREATE INDEX import_plans_connection_idx ON import_plans(tenant_id, connection_id, plan_revision);

CREATE TABLE import_runs (
  run_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(tenant_id),
  connection_id   uuid NOT NULL REFERENCES connections(connection_id),
  plan_id         uuid REFERENCES import_plans(plan_id),
  kind            text NOT NULL CHECK (kind IN ('backfill','incremental','reconcile','check','history_expansion','demo')),
  phase           text NOT NULL DEFAULT 'check_connection' CHECK (phase IN ('check_connection','import_records','link_and_process','ready','failed','cancelled','paused')),
  state           text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','paused','completed','completed_with_gaps','failed','cancelled')),
  requested       bigint NOT NULL DEFAULT 0,
  loaded          bigint NOT NULL DEFAULT 0,
  committed       bigint NOT NULL DEFAULT 0,
  applied         bigint NOT NULL DEFAULT 0,
  failed          bigint NOT NULL DEFAULT 0,
  duplicates      bigint NOT NULL DEFAULT 0,
  totals_known    boolean NOT NULL DEFAULT false,
  checkpoint      jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt         int NOT NULL DEFAULT 1,
  started_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  outcome         text,
  error_code      text,
  next_action     text,
  committed_cursor bigint
);
CREATE INDEX import_runs_connection_idx ON import_runs(tenant_id, connection_id, started_at DESC);

CREATE TABLE capability_health (
  tenant_id               uuid NOT NULL REFERENCES tenants(tenant_id),
  connection_id           uuid NOT NULL REFERENCES connections(connection_id),
  capability_id           text NOT NULL,
  observed_at             timestamptz NOT NULL DEFAULT now(),
  status                  text NOT NULL DEFAULT 'unknown' CHECK (status IN ('healthy','working','degraded','unavailable','unknown','paused')),
  last_attempt_at         timestamptz,
  last_successful_check_at timestamptz,
  last_new_event_at       timestamptz,
  last_journal_commit_at  timestamptz,
  next_check_at           timestamptz,
  next_check_reason       text,
  coverage_from           timestamptz,
  coverage_to             timestamptz,
  history_kind            text NOT NULL DEFAULT 'unknown' CHECK (history_kind IN ('event_history','snapshot_only','mixed','unknown')),
  coverage_state          text NOT NULL DEFAULT 'unknown' CHECK (coverage_state IN ('complete_for_declared_scope','partial','unknown','unavailable')),
  limitations             jsonb NOT NULL DEFAULT '[]'::jsonb,
  schedule_seconds        int,
  pending_count           int NOT NULL DEFAULT 0,
  failed_count            int NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, capability_id)
);
CREATE INDEX capability_health_tenant_idx ON capability_health(tenant_id);

CREATE TABLE review_cases (
  case_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(tenant_id),
  connection_id  uuid REFERENCES connections(connection_id),
  run_id         uuid,
  type           text NOT NULL,
  state          text NOT NULL DEFAULT 'open' CHECK (state IN ('open','in_progress','resolved')),
  revision       int NOT NULL DEFAULT 1,
  reason         text NOT NULL,
  refs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  history        jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolution_entry_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);
CREATE INDEX review_cases_tenant_idx ON review_cases(tenant_id, state, created_at DESC);
CREATE UNIQUE INDEX review_cases_open_identity_idx ON review_cases(tenant_id, type, (refs->>'identity')) WHERE state <> 'resolved' AND refs ? 'identity';

CREATE TABLE review_actions (
  action_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(tenant_id),
  case_id       uuid NOT NULL REFERENCES review_cases(case_id),
  action        text NOT NULL CHECK (action IN ('retry','confirm_link','reject_link','append_correction','leave_open')),
  from_revision int NOT NULL,
  actor_id      uuid,
  reason        text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  entry_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_actions_case_idx ON review_actions(case_id, created_at);

CREATE TABLE debug_sessions (
  debug_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(tenant_id),
  component     text NOT NULL,
  connection_id uuid,
  run_id        uuid,
  started_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  stopped_at    timestamptz,
  stop_reason   text,
  actor_id      uuid
);
CREATE INDEX debug_sessions_active_idx ON debug_sessions(tenant_id) WHERE stopped_at IS NULL;

CREATE TABLE backup_status (
  tenant_id             uuid PRIMARY KEY REFERENCES tenants(tenant_id),
  status                text NOT NULL DEFAULT 'not_configured' CHECK (status IN ('not_configured','scheduled','running','failed','overdue')),
  destination_label     text,
  same_device           boolean,
  last_attempt_at       timestamptz,
  last_completed_at     timestamptz,
  last_cutoff           timestamptz,
  next_due_at           timestamptz,
  retention_daily       int NOT NULL DEFAULT 7,
  retention_weekly      int NOT NULL DEFAULT 4,
  last_restore_test_at  timestamptz,
  last_error_code       text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE retention_policies (
  tenant_id      uuid NOT NULL REFERENCES tenants(tenant_id),
  evidence_class text NOT NULL,
  days           int NOT NULL CHECK (days > 0 AND days <= 3650),
  source         text NOT NULL DEFAULT 'default',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, evidence_class)
);

CREATE TABLE storage_thresholds (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(tenant_id),
  warn_percent         int NOT NULL DEFAULT 10 CHECK (warn_percent BETWEEN 1 AND 90),
  warn_min_bytes       bigint NOT NULL DEFAULT 5368709120 CHECK (warn_min_bytes > 0),
  critical_percent     int NOT NULL DEFAULT 2 CHECK (critical_percent BETWEEN 1 AND 50),
  critical_min_bytes   bigint NOT NULL DEFAULT 1073741824 CHECK (critical_min_bytes > 0),
  log_cap_bytes        bigint NOT NULL DEFAULT 104857600 CHECK (log_cap_bytes BETWEEN 1048576 AND 104857600),
  log_retention_days   int NOT NULL DEFAULT 7 CHECK (log_retention_days BETWEEN 1 AND 7),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Redaction ledger: append-only record of evidence restrictions (included in backups).
CREATE TABLE evidence_redactions (
  redaction_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(tenant_id),
  evidence_id   uuid NOT NULL REFERENCES journal_evidence(evidence_id),
  action        text NOT NULL CHECK (action IN ('redacted','expired','restricted')),
  reason        text NOT NULL,
  actor_id      uuid,
  policy_ref    text,
  audit_entry_id uuid,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX evidence_redactions_evidence_idx ON evidence_redactions(tenant_id, evidence_id);
CREATE TRIGGER evidence_redactions_no_update BEFORE UPDATE OR DELETE ON evidence_redactions FOR EACH ROW EXECUTE FUNCTION journal_reject_mutation();
CREATE TRIGGER evidence_redactions_no_truncate BEFORE TRUNCATE ON evidence_redactions FOR EACH STATEMENT EXECUTE FUNCTION journal_reject_mutation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_settings','import_plans','import_runs','capability_health','review_cases','review_actions','debug_sessions','backup_status','retention_policies','storage_thresholds','evidence_redactions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I FOR ALL TO bb_api, bb_worker USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON workspace_settings, import_plans, import_runs, capability_health, review_cases, review_actions, debug_sessions, backup_status, retention_policies, storage_thresholds TO bb_api, bb_worker;
GRANT SELECT, INSERT ON evidence_redactions TO bb_api, bb_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON evidence_redactions FROM bb_api, bb_worker, bb_engine, PUBLIC;
-- Unresolved-count view used by the engine health probe and the API (no cross-tenant counts: RLS applies).
GRANT SELECT ON review_cases TO bb_engine;
CREATE POLICY engine_read_all ON review_cases FOR SELECT TO bb_engine USING (true);
