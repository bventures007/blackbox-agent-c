-- 0001_journal.sql — canonical five-track journal, tenant sequences, outbox, engine checkpoints.
-- Run as the migration role (bb_migrate, table owner). Runtime roles bb_api, bb_worker, bb_engine
-- are created by 0000_roles.sql and must be LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE.
-- This file is the binding base layout (ADR-0003); later migrations only add tables/columns/policies.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE journal_track AS ENUM ('source','fact','commitment','movement','reservation');

CREATE TABLE tenants (
  tenant_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_sequences (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(tenant_id),
  last_sequence bigint NOT NULL DEFAULT 0
);

-- Mutable operational table: provider connections (credentials encrypted by the application).
CREATE TABLE connections (
  connection_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(tenant_id),
  provider      text NOT NULL,
  account_ref   text,
  display_name  text NOT NULL,
  status        text NOT NULL DEFAULT 'configured',
  config_json   jsonb NOT NULL DEFAULT '{}',
  secret_ciphertext bytea,
  secret_key_version int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz
);
CREATE INDEX connections_tenant_idx ON connections(tenant_id, provider);

-- Canonical append-only journal (JOURNAL-AND-MCP.md §2).
CREATE TABLE journal_entries (
  entry_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(tenant_id),
  journal_sequence  bigint NOT NULL,
  track             journal_track NOT NULL,
  record_id         text NOT NULL,
  event_type        text NOT NULL,
  schema_version    int NOT NULL DEFAULT 1,
  connection_id     uuid REFERENCES connections(connection_id),
  provider          text,
  account_ref       text,
  provider_event_id text,
  occurred_at       timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_time       timestamptz,
  entity_refs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload           jsonb NOT NULL,
  payload_hash      text NOT NULL,
  evidence_refs     jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_entry_ids   uuid[] NOT NULL DEFAULT '{}',
  derivation_rule   text,
  derivation_version int,
  supersedes_entry_id uuid REFERENCES journal_entries(entry_id),
  correlation_id    text,
  causation_id      text,
  CONSTRAINT journal_entries_tenant_sequence_key UNIQUE (tenant_id, journal_sequence),
  CONSTRAINT journal_entries_record_key UNIQUE (tenant_id, record_id, journal_sequence)
);
CREATE INDEX journal_entries_record_idx   ON journal_entries(tenant_id, record_id, journal_sequence);
CREATE INDEX journal_entries_event_idx    ON journal_entries(tenant_id, event_type, journal_sequence);
CREATE INDEX journal_entries_occurred_idx ON journal_entries(tenant_id, occurred_at);
CREATE INDEX journal_entries_recorded_idx ON journal_entries(tenant_id, recorded_at);
CREATE INDEX journal_entries_provider_idx ON journal_entries(tenant_id, connection_id, provider_event_id);
CREATE INDEX journal_entries_entity_idx   ON journal_entries USING gin (entity_refs jsonb_path_ops);
CREATE INDEX journal_entries_supersedes_idx ON journal_entries(supersedes_entry_id) WHERE supersedes_entry_id IS NOT NULL;

-- Immutable evidence metadata; content lives in the evidence volume (opaque storage_ref).
CREATE TABLE journal_evidence (
  evidence_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(tenant_id),
  connection_id uuid REFERENCES connections(connection_id),
  kind          text NOT NULL,
  media_type    text NOT NULL,
  byte_size     bigint NOT NULL,
  content_hash  text NOT NULL,
  storage_ref   text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  evidence_class text NOT NULL DEFAULT 'provider_payload'
);
CREATE INDEX journal_evidence_tenant_idx ON journal_evidence(tenant_id, received_at);

-- Mutable delivery audit and deduplication boundary.
CREATE TABLE deliveries (
  delivery_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(tenant_id),
  connection_id     uuid NOT NULL REFERENCES connections(connection_id),
  provider_event_id text NOT NULL,
  content_hash      text NOT NULL,
  status            text NOT NULL,  -- accepted | duplicate | conflict | rejected
  attempts          int NOT NULL DEFAULT 1,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  entry_ids         uuid[] NOT NULL DEFAULT '{}',
  run_id            uuid,
  CONSTRAINT deliveries_identity_key UNIQUE (tenant_id, connection_id, provider_event_id)
);

-- Transactional outbox; consumed by cursor (tenant_id, journal_sequence).
CREATE TABLE outbox (
  outbox_id        bigserial PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(tenant_id),
  journal_sequence bigint NOT NULL,
  entry_id         uuid NOT NULL REFERENCES journal_entries(entry_id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  dispatched_at    timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox(tenant_id, journal_sequence) WHERE dispatched_at IS NULL;

CREATE TABLE engine_checkpoints (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(tenant_id),
  applied_sequence bigint NOT NULL DEFAULT 0,
  reducer_version  int NOT NULL,
  state_hash       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE engine_snapshots (
  tenant_id        uuid NOT NULL REFERENCES tenants(tenant_id),
  reducer_version  int NOT NULL,
  format_version   int NOT NULL,
  applied_sequence bigint NOT NULL,
  checksum         text NOT NULL,
  blob             bytea NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, reducer_version)
);

-- Append-only enforcement below the application layer.
CREATE FUNCTION journal_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'journal is append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER journal_entries_no_update  BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION journal_reject_mutation();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries FOR EACH STATEMENT EXECUTE FUNCTION journal_reject_mutation();
CREATE TRIGGER journal_evidence_no_update  BEFORE UPDATE OR DELETE ON journal_evidence FOR EACH ROW EXECUTE FUNCTION journal_reject_mutation();
CREATE TRIGGER journal_evidence_no_truncate BEFORE TRUNCATE ON journal_evidence FOR EACH STATEMENT EXECUTE FUNCTION journal_reject_mutation();

-- Single append boundary. Caller must have SET LOCAL app.tenant_id; entries is a JSON array of
-- objects with: track, record_id, event_type, schema_version?, connection_id?, provider?, account_ref?,
-- provider_event_id?, occurred_at, source_time?, entity_refs?, payload, evidence_refs?, input_entry_ids?,
-- derivation_rule?, derivation_version?, supersedes_entry_id?, correlation_id?, causation_id?.
-- Sequences are allocated under the tenant row lock so visibility order equals sequence order.
CREATE FUNCTION append_journal_entries(p_entries jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid := current_setting('app.tenant_id', true)::uuid;
  v_seq    bigint;
  v_entry  jsonb;
  v_id     uuid;
  v_out    jsonb := '[]'::jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'app.tenant_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'entries must be a non-empty array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT last_sequence INTO v_seq FROM tenant_sequences WHERE tenant_id = v_tenant FOR UPDATE;
  IF v_seq IS NULL THEN
    RAISE EXCEPTION 'tenant sequence row missing' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
    v_seq := v_seq + 1;
    INSERT INTO journal_entries (
      tenant_id, journal_sequence, track, record_id, event_type, schema_version, connection_id,
      provider, account_ref, provider_event_id, occurred_at, source_time, entity_refs, payload,
      payload_hash, evidence_refs, input_entry_ids, derivation_rule, derivation_version,
      supersedes_entry_id, correlation_id, causation_id)
    VALUES (
      v_tenant, v_seq, (v_entry->>'track')::journal_track, v_entry->>'record_id', v_entry->>'event_type',
      COALESCE((v_entry->>'schema_version')::int, 1), (v_entry->>'connection_id')::uuid,
      v_entry->>'provider', v_entry->>'account_ref', v_entry->>'provider_event_id',
      (v_entry->>'occurred_at')::timestamptz, (v_entry->>'source_time')::timestamptz,
      COALESCE(v_entry->'entity_refs', '{}'::jsonb), v_entry->'payload',
      encode(digest((v_entry->'payload')::text, 'sha256'), 'hex'),
      COALESCE(v_entry->'evidence_refs', '[]'::jsonb),
      COALESCE((SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(COALESCE(v_entry->'input_entry_ids','[]'::jsonb)) x), '{}'::uuid[]),
      v_entry->>'derivation_rule', (v_entry->>'derivation_version')::int,
      (v_entry->>'supersedes_entry_id')::uuid, v_entry->>'correlation_id', v_entry->>'causation_id')
    RETURNING entry_id INTO v_id;
    INSERT INTO outbox (tenant_id, journal_sequence, entry_id) VALUES (v_tenant, v_seq, v_id);
    v_out := v_out || jsonb_build_object('entry_id', v_id, 'journal_sequence', v_seq, 'track', v_entry->>'track', 'record_id', v_entry->>'record_id');
  END LOOP;
  UPDATE tenant_sequences SET last_sequence = v_seq WHERE tenant_id = v_tenant;
  PERFORM pg_notify('journal_appended', v_tenant::text || ':' || v_seq::text);
  RETURN v_out;
END $$;

-- Row-level security: every tenant table is scoped by app.tenant_id for api/worker; the engine
-- reads all tenants (documented in ADR-0003) but cannot write journal rows.
ALTER TABLE tenants           ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants           FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_sequences  ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_sequences  FORCE ROW LEVEL SECURITY;
ALTER TABLE connections       ENABLE ROW LEVEL SECURITY; ALTER TABLE connections       FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_entries   ENABLE ROW LEVEL SECURITY; ALTER TABLE journal_entries   FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_evidence  ENABLE ROW LEVEL SECURITY; ALTER TABLE journal_evidence  FORCE ROW LEVEL SECURITY;
ALTER TABLE deliveries        ENABLE ROW LEVEL SECURITY; ALTER TABLE deliveries        FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox            ENABLE ROW LEVEL SECURITY; ALTER TABLE outbox            FORCE ROW LEVEL SECURITY;
ALTER TABLE engine_checkpoints ENABLE ROW LEVEL SECURITY; ALTER TABLE engine_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE engine_snapshots  ENABLE ROW LEVEL SECURITY; ALTER TABLE engine_snapshots  FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_scope ON tenants          FOR ALL TO bb_api, bb_worker USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_scope ON tenant_sequences FOR ALL TO bb_api, bb_worker USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_scope ON connections      FOR ALL TO bb_api, bb_worker USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_scope ON journal_entries  FOR ALL TO bb_api, bb_worker USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_scope ON journal_evidence FOR ALL TO bb_api, bb_worker USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_scope ON deliveries       FOR ALL TO bb_api, bb_worker USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_scope ON outbox           FOR ALL TO bb_api, bb_worker USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_scope ON engine_checkpoints FOR SELECT TO bb_api, bb_worker USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY engine_read_all ON tenants          FOR SELECT TO bb_engine USING (true);
CREATE POLICY engine_read_all ON tenant_sequences FOR SELECT TO bb_engine USING (true);
CREATE POLICY engine_read_all ON journal_entries  FOR SELECT TO bb_engine USING (true);
CREATE POLICY engine_read_all ON journal_evidence FOR SELECT TO bb_engine USING (true);
CREATE POLICY engine_read_all ON connections      FOR SELECT TO bb_engine USING (true);
CREATE POLICY engine_rw ON engine_checkpoints FOR ALL TO bb_engine USING (true) WITH CHECK (true);
CREATE POLICY engine_rw ON engine_snapshots   FOR ALL TO bb_engine USING (true) WITH CHECK (true);

GRANT USAGE ON SCHEMA public TO bb_api, bb_worker, bb_engine;
GRANT SELECT, INSERT, UPDATE ON tenants, tenant_sequences, connections, deliveries, outbox TO bb_api, bb_worker;
GRANT SELECT, INSERT ON journal_entries, journal_evidence TO bb_api, bb_worker;
GRANT SELECT ON engine_checkpoints TO bb_api, bb_worker;
GRANT USAGE, SELECT ON SEQUENCE outbox_outbox_id_seq TO bb_api, bb_worker;
GRANT SELECT ON tenants, tenant_sequences, journal_entries, journal_evidence, connections TO bb_engine;
GRANT SELECT, INSERT, UPDATE, DELETE ON engine_checkpoints, engine_snapshots TO bb_engine;
GRANT EXECUTE ON FUNCTION append_journal_entries(jsonb) TO bb_api, bb_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON journal_entries, journal_evidence FROM bb_api, bb_worker, bb_engine, PUBLIC;
