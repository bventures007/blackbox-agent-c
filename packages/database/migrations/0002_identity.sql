-- 0002_identity.sql — mutable identity/session/audit tables (IDENTITY-ACCESS-AND-RECOVERY.md).
-- Separate from the business journal. Run as bb_migrate. Only bb_api may use these tables; the
-- worker and engine have no grant. Rows are tenant-bound (workspace) and RLS-forced; the
-- authentication path sets app.auth_context='authenticator' for the single transaction that must
-- resolve a credential/session before the workspace is known.

CREATE TABLE principals (
  principal_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(tenant_id),
  kind          text NOT NULL CHECK (kind IN ('owner','agent','producer')),
  display_name  text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  revoked_at    timestamptz
);
CREATE INDEX principals_tenant_idx ON principals(tenant_id, kind);
-- Exactly one owner per installation (single workspace pilot): enforced for concurrent setup.
CREATE UNIQUE INDEX principals_single_owner_idx ON principals((kind)) WHERE kind = 'owner';

CREATE TABLE credentials (
  credential_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id  uuid NOT NULL REFERENCES principals(principal_id),
  tenant_id     uuid NOT NULL REFERENCES tenants(tenant_id),
  purpose       text NOT NULL CHECK (purpose IN ('owner_key','agent_key')),
  prefix        text NOT NULL,
  verifier      text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  display_name  text,
  key_version   int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_reason text
);
CREATE INDEX credentials_prefix_idx ON credentials(prefix) WHERE status = 'active';
CREATE INDEX credentials_principal_idx ON credentials(principal_id);

CREATE TABLE sessions (
  session_hash        text PRIMARY KEY,
  principal_id        uuid NOT NULL REFERENCES principals(principal_id),
  tenant_id           uuid NOT NULL REFERENCES tenants(tenant_id),
  csrf_token          text NOT NULL,
  remembered          boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at     timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_reason      text
);
CREATE INDEX sessions_principal_idx ON sessions(principal_id) WHERE revoked_at IS NULL;

-- Installation-scoped login throttle keyed by an opaque client key (no tenant before login).
CREATE TABLE login_throttle (
  client_key   text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  failures     int NOT NULL DEFAULT 0,
  locked_until timestamptz
);

-- Durable security audit: append-only (UPDATE/DELETE/TRUNCATE rejected). Redacted metadata only.
CREATE TABLE security_audit (
  audit_id    bigserial PRIMARY KEY,
  tenant_id   uuid REFERENCES tenants(tenant_id),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  event       text NOT NULL,
  actor_kind  text NOT NULL,
  actor_id    uuid,
  channel     text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX security_audit_tenant_idx ON security_audit(tenant_id, occurred_at);
CREATE TRIGGER security_audit_no_update BEFORE UPDATE OR DELETE ON security_audit FOR EACH ROW EXECUTE FUNCTION journal_reject_mutation();
CREATE TRIGGER security_audit_no_truncate BEFORE TRUNCATE ON security_audit FOR EACH STATEMENT EXECUTE FUNCTION journal_reject_mutation();

-- Generic signed-input producers (HMAC secret encrypted with the installation data key).
CREATE TABLE producer_credentials (
  producer_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(tenant_id),
  connection_id     uuid NOT NULL REFERENCES connections(connection_id),
  display_name      text NOT NULL,
  secret_ciphertext bytea NOT NULL,
  secret_key_version int NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  revoked_at        timestamptz
);
CREATE INDEX producer_credentials_connection_idx ON producer_credentials(connection_id);

-- Replay protection for signed inputs: one signature accepted once within the time window.
CREATE TABLE producer_nonces (
  producer_id    uuid NOT NULL REFERENCES producer_credentials(producer_id),
  tenant_id      uuid NOT NULL REFERENCES tenants(tenant_id),
  signature_hash text NOT NULL,
  seen_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (producer_id, signature_hash)
);

ALTER TABLE principals           ENABLE ROW LEVEL SECURITY; ALTER TABLE principals           FORCE ROW LEVEL SECURITY;
ALTER TABLE credentials          ENABLE ROW LEVEL SECURITY; ALTER TABLE credentials          FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions             ENABLE ROW LEVEL SECURITY; ALTER TABLE sessions             FORCE ROW LEVEL SECURITY;
ALTER TABLE security_audit       ENABLE ROW LEVEL SECURITY; ALTER TABLE security_audit       FORCE ROW LEVEL SECURITY;
ALTER TABLE producer_credentials ENABLE ROW LEVEL SECURITY; ALTER TABLE producer_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE producer_nonces      ENABLE ROW LEVEL SECURITY; ALTER TABLE producer_nonces      FORCE ROW LEVEL SECURITY;

-- Tenant scope, plus the authenticator context (credential/session resolution before the
-- workspace is known). The authenticator context is set per transaction by the API only.
CREATE POLICY tenant_scope ON principals  FOR ALL TO bb_api USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.auth_context', true) = 'authenticator') WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.auth_context', true) = 'authenticator');
CREATE POLICY tenant_scope ON credentials FOR ALL TO bb_api USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.auth_context', true) = 'authenticator') WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.auth_context', true) = 'authenticator');
CREATE POLICY tenant_scope ON sessions    FOR ALL TO bb_api USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.auth_context', true) = 'authenticator') WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.auth_context', true) = 'authenticator');
CREATE POLICY tenant_scope ON security_audit FOR ALL TO bb_api USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.auth_context', true) = 'authenticator') WITH CHECK (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.auth_context', true) = 'authenticator');
CREATE POLICY tenant_scope ON producer_credentials FOR ALL TO bb_api USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.auth_context', true) = 'authenticator') WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.auth_context', true) = 'authenticator');
CREATE POLICY tenant_scope ON producer_nonces FOR ALL TO bb_api USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.auth_context', true) = 'authenticator') WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.auth_context', true) = 'authenticator');

GRANT SELECT, INSERT, UPDATE ON principals, credentials, sessions, login_throttle, producer_credentials, producer_nonces TO bb_api;
GRANT DELETE ON login_throttle, producer_nonces TO bb_api;
GRANT SELECT, INSERT ON security_audit TO bb_api;
GRANT USAGE, SELECT ON SEQUENCE security_audit_audit_id_seq TO bb_api;
REVOKE UPDATE, DELETE, TRUNCATE ON security_audit FROM bb_api, bb_worker, bb_engine, PUBLIC;
