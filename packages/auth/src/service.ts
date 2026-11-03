import { randomUUID, createHash } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import type { Pool, TenantClient } from "@blackbox/database";
import { withAuthenticator, withInstallation, withTenant } from "@blackbox/database";
import type { Logger } from "@blackbox/logging";
import { DATA_KEY_FILE } from "./datakey.js";
import { generateAgentKey, generateCsrfToken, generateOwnerKey, generateSessionId, hashKey, hashSessionId, parseKey, verifyKey } from "./keys.js";

export const SESSION_COOKIE = "bb_session";
export const CSRF_HEADER = "x-blackbox-csrf";
export const REMEMBERED_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const REMEMBERED_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const ORDINARY_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const THROTTLE_MAX_FAILURES = 5;
/**
 * Agent-key argon2 verification result (key hash → credential id) is reused at most this long; the credential and
 * principal rows (status, expiry) are re-read from PostgreSQL on every request regardless, so revocation stays
 * immediate. argon2id at 64 MiB / t=3 costs ≈100-200 ms of CPU per verification: with the former 5 s TTL every
 * agent key was re-verified twelve times a minute and concurrent misses ran it in parallel (PILOT-09 smoke profile:
 * the api container saturated four cores). Concurrent misses now share one in-flight verification.
 */
export const VERIFY_CACHE_MS = 10 * 60 * 1000;
export const AGENT_GRANT = "workspace.read_business";

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  constructor(code: string, status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface Principal {
  principal_id: string;
  tenant_id: string;
  kind: "owner" | "agent";
  display_name: string;
  credential_id: string | null;
}

export interface OwnerSession {
  principal: Principal;
  session_hash: string;
  csrf_token: string;
  remembered: boolean;
  expires_at: string;
  created_at: string;
}

export interface AgentContext {
  principal: Principal;
  credential_id: string;
  last_used_at: string | null;
}

export interface Workspace {
  tenant_id: string;
  display_name: string;
  locale: "en" | "de";
  created_at: string;
}

export interface AuthServiceOptions {
  pool: Pool;
  logger: Logger;
  secretsDir: string;
  now?: () => Date;
}

interface CredentialRow {
  credential_id: string;
  principal_id: string;
  tenant_id: string;
  purpose: "owner_key" | "agent_key";
  verifier: string;
  status: string;
  display_name: string | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  kind: "owner" | "agent";
  principal_name: string;
  principal_status: string;
}

export class AuthService {
  private readonly pool: Pool;
  private readonly log: Logger;
  private readonly secretsDir: string;
  private readonly now: () => Date;
  private verifyCache = new Map<string, { credential_id: string; at: number }>();
  private verifyInFlight = new Map<string, Promise<string | null>>();

  constructor(options: AuthServiceOptions) {
    this.pool = options.pool;
    this.log = options.logger.child({}, "auth");
    this.secretsDir = options.secretsDir;
    this.now = options.now ?? (() => new Date());
  }

  // ---------- setup / owner lifecycle ----------

  async isInitialized(): Promise<boolean> {
    return withAuthenticator(this.pool, async (c) => {
      const r = await c.query("SELECT 1 FROM principals WHERE kind = 'owner' LIMIT 1");
      return (r.rowCount ?? 0) > 0;
    });
  }

  /**
   * Atomic, idempotent first setup: one workspace + one owner + one key. Concurrent callers
   * serialize on an advisory lock and the single-owner unique index; a second run reports
   * `already_initialized` and never replaces the saved owner or key.
   */
  async setup(input: { displayName: string; locale?: "en" | "de" }): Promise<{ status: "created"; key: string; tenant_id: string; principal_id: string } | { status: "already_initialized"; tenant_id: string }> {
    const tenantId = randomUUID();
    const key = generateOwnerKey();
    const verifier = await hashKey(key);
    const parsed = parseKey(key)!;
    const result = await withAuthenticator(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7245002)");
      const existing = await c.query<{ tenant_id: string }>("SELECT tenant_id FROM principals WHERE kind = 'owner' LIMIT 1");
      if (existing.rows[0]) return { status: "already_initialized" as const, tenant_id: existing.rows[0].tenant_id };
      // tenants/tenant_sequences are tenant-scoped: set the scope to the new id for this transaction.
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await c.query("INSERT INTO tenants (tenant_id, display_name) VALUES ($1, $2)", [tenantId, input.displayName]);
      await c.query("INSERT INTO tenant_sequences (tenant_id, last_sequence) VALUES ($1, 0)", [tenantId]);
      await c.query("INSERT INTO storage_thresholds (tenant_id) VALUES ($1)", [tenantId]);
      await c.query("INSERT INTO backup_status (tenant_id) VALUES ($1)", [tenantId]);
      await c.query("INSERT INTO retention_policies (tenant_id, evidence_class, days, source) VALUES ($1, 'provider_payload', 90, 'default'), ($1, 'document', 90, 'default'), ($1, 'communication', 90, 'default')", [tenantId]);
      const p = await c.query<{ principal_id: string }>("INSERT INTO principals (tenant_id, kind, display_name) VALUES ($1, 'owner', 'Owner') RETURNING principal_id", [tenantId]);
      const principalId = p.rows[0]!.principal_id;
      await c.query("INSERT INTO credentials (principal_id, tenant_id, purpose, prefix, verifier, display_name) VALUES ($1, $2, 'owner_key', $3, $4, 'Personal access key')", [principalId, tenantId, parsed.lookupPrefix, verifier]);
      await c.query("INSERT INTO workspace_settings (tenant_id, locale) VALUES ($1, $2)", [tenantId, input.locale ?? "en"]);
      await this.auditIn(c, tenantId, "owner.setup", "owner", principalId, "host_setup", { locale: input.locale ?? "en" });
      return { status: "created" as const, key, tenant_id: tenantId, principal_id: principalId };
    });
    if (result.status === "created") {
      this.log.info("auth.setup_completed", "Workspace and owner created; key issued through the setup channel", { tenant_id: result.tenant_id });
    } else {
      this.log.info("auth.setup_skipped", "Setup already completed; existing owner preserved", { tenant_id: result.tenant_id });
    }
    return result;
  }

  async getWorkspace(tenantId: string): Promise<Workspace | null> {
    return withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query<{ tenant_id: string; display_name: string; created_at: Date }>("SELECT tenant_id, display_name, created_at FROM tenants WHERE tenant_id = $1", [tenantId]);
      const row = r.rows[0];
      if (!row) return null;
      return { tenant_id: row.tenant_id, display_name: row.display_name, locale: await this.readLocale(c, tenantId), created_at: row.created_at.toISOString() };
    });
  }

  private async readLocale(c: TenantClient, tenantId: string): Promise<"en" | "de"> {
    const r = await c.query<{ locale: string | null }>("SELECT locale FROM workspace_settings WHERE tenant_id = $1", [tenantId]);
    return r.rows[0]?.locale === "de" ? "de" : "en";
  }

  async updateWorkspace(tenantId: string, actorId: string, patch: { display_name?: string; locale?: "en" | "de" }): Promise<Workspace> {
    await withTenant(this.pool, tenantId, async (c) => {
      if (patch.display_name !== undefined) await c.query("UPDATE tenants SET display_name = $2 WHERE tenant_id = $1", [tenantId, patch.display_name]);
      if (patch.locale !== undefined) {
        await c.query("INSERT INTO workspace_settings (tenant_id, locale) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET locale = $2, updated_at = now()", [tenantId, patch.locale]);
        await this.auditIn(c, tenantId, "workspace.updated", "owner", actorId, "api", { locale: patch.locale });
      }
    });
    return (await this.getWorkspace(tenantId))!;
  }

  // ---------- login / sessions ----------

  async login(input: { key: unknown; remember: boolean; clientKey: string }): Promise<{ session_id: string; session: OwnerSession }> {
    await this.checkThrottle(input.clientKey);
    const parsed = parseKey(input.key);
    if (!parsed || parsed.kind !== "owner") {
      await this.recordFailure(input.clientKey);
      this.log.warn("auth.login_failed", "Login rejected: key format invalid", { error_code: "invalid_key" });
      throw new AuthError("invalid_key", 401, "The access key is not valid");
    }
    const cred = await this.findActiveCredential(parsed.lookupPrefix, "owner_key", parsed.key);
    if (!cred) {
      await this.recordFailure(input.clientKey);
      this.log.warn("auth.login_failed", "Login rejected: no matching active owner key", { error_code: "invalid_key" });
      throw new AuthError("invalid_key", 401, "The access key is not valid");
    }
    const sessionId = generateSessionId();
    const sessionHash = hashSessionId(sessionId);
    const csrf = generateCsrfToken();
    const now = this.now();
    const absolute = new Date(now.getTime() + (input.remember ? REMEMBERED_ABSOLUTE_MS : ORDINARY_ABSOLUTE_MS));
    const idle = new Date(now.getTime() + (input.remember ? REMEMBERED_IDLE_MS : ORDINARY_ABSOLUTE_MS));
    await withTenant(this.pool, cred.tenant_id, async (c) => {
      await c.query(
        "INSERT INTO sessions (session_hash, principal_id, tenant_id, csrf_token, remembered, absolute_expires_at, idle_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [sessionHash, cred.principal_id, cred.tenant_id, csrf, input.remember, absolute, idle],
      );
      await c.query("UPDATE credentials SET last_used_at = now() WHERE credential_id = $1", [cred.credential_id]);
      await this.auditIn(c, cred.tenant_id, "owner.login", "owner", cred.principal_id, "api", { remembered: input.remember });
    });
    await this.clearThrottle(input.clientKey);
    this.log.info("auth.login_succeeded", "Owner session created", { tenant_id: cred.tenant_id });
    const expires = absolute < idle ? absolute : idle;
    return {
      session_id: sessionId,
      session: {
        principal: { principal_id: cred.principal_id, tenant_id: cred.tenant_id, kind: "owner", display_name: cred.principal_name, credential_id: cred.credential_id },
        session_hash: sessionHash,
        csrf_token: csrf,
        remembered: input.remember,
        expires_at: expires.toISOString(),
        created_at: now.toISOString(),
      },
    };
  }

  /** Re-reads the session row on every request (no cache): revocation is effective immediately. */
  async authenticateSession(sessionId: string | undefined): Promise<OwnerSession | null> {
    if (!sessionId || sessionId.length < 40 || sessionId.length > 64) return null;
    const hash = hashSessionId(sessionId);
    const now = this.now();
    return withAuthenticator(this.pool, async (c) => {
      const r = await c.query<{
        session_hash: string;
        principal_id: string;
        tenant_id: string;
        csrf_token: string;
        remembered: boolean;
        created_at: Date;
        absolute_expires_at: Date;
        idle_expires_at: Date;
        revoked_at: Date | null;
        principal_status: string;
        display_name: string;
        kind: "owner" | "agent";
      }>(
        `SELECT s.session_hash, s.principal_id, s.tenant_id, s.csrf_token, s.remembered, s.created_at, s.absolute_expires_at, s.idle_expires_at, s.revoked_at,
                p.status AS principal_status, p.display_name, p.kind
           FROM sessions s JOIN principals p ON p.principal_id = s.principal_id
          WHERE s.session_hash = $1`,
        [hash],
      );
      const row = r.rows[0];
      if (!row || row.revoked_at || row.principal_status !== "active" || row.kind !== "owner") return null;
      if (row.absolute_expires_at <= now || row.idle_expires_at <= now) return null;
      // Idle extension (remembered sessions only move the idle deadline; absolute never moves).
      const newIdle = new Date(Math.min(row.absolute_expires_at.getTime(), now.getTime() + (row.remembered ? REMEMBERED_IDLE_MS : ORDINARY_ABSOLUTE_MS)));
      await c.query("UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE session_hash = $1", [hash, now, newIdle]);
      const expires = row.absolute_expires_at < newIdle ? row.absolute_expires_at : newIdle;
      return {
        principal: { principal_id: row.principal_id, tenant_id: row.tenant_id, kind: "owner", display_name: row.display_name, credential_id: null },
        session_hash: row.session_hash,
        csrf_token: row.csrf_token,
        remembered: row.remembered,
        expires_at: expires.toISOString(),
        created_at: row.created_at.toISOString(),
      };
    });
  }

  async logout(sessionHash: string, tenantId: string, principalId: string): Promise<void> {
    await withTenant(this.pool, tenantId, async (c) => {
      await c.query("UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE session_hash = $1 AND revoked_at IS NULL", [sessionHash]);
      await this.auditIn(c, tenantId, "owner.logout", "owner", principalId, "api", {});
    });
  }

  // ---------- agent keys ----------

  async authenticateAgentKey(bearer: unknown): Promise<AgentContext | null> {
    const parsed = parseKey(bearer);
    if (!parsed || parsed.kind !== "agent") return null;
    const cred = await this.findActiveCredential(parsed.lookupPrefix, "agent_key", parsed.key);
    if (!cred) return null;
    const lastUsed = cred.last_used_at;
    // Bounded write amplification: record use at most once per minute per credential.
    if (!lastUsed || this.now().getTime() - lastUsed.getTime() > 60_000) {
      await withTenant(this.pool, cred.tenant_id, (c) => c.query("UPDATE credentials SET last_used_at = now() WHERE credential_id = $1", [cred.credential_id])).catch(() => {});
    }
    return {
      principal: { principal_id: cred.principal_id, tenant_id: cred.tenant_id, kind: "agent", display_name: cred.principal_name, credential_id: cred.credential_id },
      credential_id: cred.credential_id,
      last_used_at: lastUsed ? lastUsed.toISOString() : null,
    };
  }

  async createAgentKey(tenantId: string, actorId: string, input: { name: string; expires_at?: string | null }): Promise<{ credential_id: string; key: string; principal_id: string }> {
    const expires = input.expires_at ? new Date(input.expires_at) : null;
    if (expires && (Number.isNaN(expires.getTime()) || expires <= this.now())) throw new AuthError("validation", 422, "expires_at must be a future timestamp");
    const key = generateAgentKey();
    const parsed = parseKey(key)!;
    const verifier = await hashKey(key);
    const result = await withTenant(this.pool, tenantId, async (c) => {
      const p = await c.query<{ principal_id: string }>("INSERT INTO principals (tenant_id, kind, display_name, created_by) VALUES ($1, 'agent', $2, $3) RETURNING principal_id", [tenantId, input.name, actorId]);
      const principalId = p.rows[0]!.principal_id;
      const cr = await c.query<{ credential_id: string }>(
        "INSERT INTO credentials (principal_id, tenant_id, purpose, prefix, verifier, display_name, expires_at) VALUES ($1,$2,'agent_key',$3,$4,$5,$6) RETURNING credential_id",
        [principalId, tenantId, parsed.lookupPrefix, verifier, input.name, expires],
      );
      await this.auditIn(c, tenantId, "agent.key_created", "owner", actorId, "api", { principal_id: principalId, expires: Boolean(expires) });
      return { credential_id: cr.rows[0]!.credential_id, principal_id: principalId };
    });
    this.log.info("auth.agent_key_created", "Agent key created", { tenant_id: tenantId });
    return { ...result, key };
  }

  async listAgentKeys(tenantId: string): Promise<Array<{ credential_id: string; name: string; status: string; created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null; grant: string }>> {
    return withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query<{ credential_id: string; name: string; status: string; created_at: Date; last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null }>(
        `SELECT cr.credential_id, p.display_name AS name, cr.status, cr.created_at, cr.last_used_at, cr.expires_at, cr.revoked_at
           FROM credentials cr JOIN principals p ON p.principal_id = cr.principal_id
          WHERE cr.purpose = 'agent_key' ORDER BY cr.created_at DESC`,
      );
      return r.rows.map((x) => ({
        credential_id: x.credential_id,
        name: x.name,
        status: x.expires_at && x.expires_at <= this.now() && x.status === "active" ? "expired" : x.status,
        created_at: x.created_at.toISOString(),
        last_used_at: x.last_used_at?.toISOString() ?? null,
        expires_at: x.expires_at?.toISOString() ?? null,
        revoked_at: x.revoked_at?.toISOString() ?? null,
        grant: AGENT_GRANT,
      }));
    });
  }

  /** Revocation commits before this resolves; later requests with the key fail (no cache of status). */
  async revokeAgentKey(tenantId: string, actorId: string, credentialId: string): Promise<boolean> {
    const ok = await withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query("UPDATE credentials SET status = 'revoked', revoked_at = now(), revoked_reason = 'owner_revoked' WHERE credential_id = $1 AND purpose = 'agent_key' AND status = 'active'", [credentialId]);
      if ((r.rowCount ?? 0) === 0) {
        const exists = await c.query("SELECT 1 FROM credentials WHERE credential_id = $1 AND purpose = 'agent_key'", [credentialId]);
        return (exists.rowCount ?? 0) > 0;
      }
      await c.query("UPDATE principals SET status = 'revoked', revoked_at = now() WHERE principal_id = (SELECT principal_id FROM credentials WHERE credential_id = $1)", [credentialId]);
      await this.auditIn(c, tenantId, "agent.key_revoked", "owner", actorId, "api", { credential_id: credentialId });
      return true;
    });
    this.verifyCache.clear();
    if (ok) this.log.info("auth.agent_key_revoked", "Agent key revoked", { tenant_id: tenantId });
    return ok;
  }

  // ---------- rotation / reset ----------

  async rotateOwnerKey(tenantId: string, principalId: string, currentKey: unknown): Promise<string> {
    const parsed = parseKey(currentKey);
    const cred = parsed && parsed.kind === "owner" ? await this.findActiveCredential(parsed.lookupPrefix, "owner_key", parsed.key) : null;
    if (!cred || cred.tenant_id !== tenantId || cred.principal_id !== principalId) {
      this.log.warn("auth.rotation_rejected", "Key rotation rejected: current key did not verify", { tenant_id: tenantId, error_code: "invalid_key" });
      throw new AuthError("invalid_key", 401, "The current access key is not valid");
    }
    const newKey = await this.replaceOwnerKey(tenantId, principalId, "owner.key_rotated", "api", { revokeAgents: false });
    this.log.info("auth.owner_key_rotated", "Owner key rotated; all owner sessions revoked", { tenant_id: tenantId });
    return newKey;
  }

  /**
   * Host-only reset: callable only from the CLI with read access to the secrets directory
   * (the data key file). Rotates the owner key, revokes all sessions and agent keys, audits.
   */
  async resetAccess(): Promise<{ key: string; tenant_id: string }> {
    try {
      accessSync(path.join(this.secretsDir, DATA_KEY_FILE), fsConstants.R_OK);
    } catch {
      throw new AuthError("host_access_required", 403, `reset-access requires read access to ${DATA_KEY_FILE} in the secrets directory (host-only operation)`);
    }
    const owner = await withAuthenticator(this.pool, async (c) => {
      const r = await c.query<{ principal_id: string; tenant_id: string }>("SELECT principal_id, tenant_id FROM principals WHERE kind = 'owner' LIMIT 1");
      return r.rows[0] ?? null;
    });
    if (!owner) throw new AuthError("not_initialized", 409, "No owner exists yet; run setup first");
    const key = await this.replaceOwnerKey(owner.tenant_id, owner.principal_id, "owner.access_reset", "host_reset", { revokeAgents: true });
    this.log.warn("auth.access_reset", "Host-only access reset performed; owner key rotated, sessions and agent keys revoked", { tenant_id: owner.tenant_id, action_code: "relogin_required" });
    return { key, tenant_id: owner.tenant_id };
  }

  private async replaceOwnerKey(tenantId: string, principalId: string, event: string, channel: string, opts: { revokeAgents: boolean }): Promise<string> {
    const newKey = generateOwnerKey();
    const verifier = await hashKey(newKey);
    const parsed = parseKey(newKey)!;
    await withTenant(this.pool, tenantId, async (c) => {
      await c.query("UPDATE credentials SET status = 'revoked', revoked_at = now(), revoked_reason = $2 WHERE principal_id = $1 AND purpose = 'owner_key' AND status = 'active'", [principalId, event]);
      await c.query(
        "INSERT INTO credentials (principal_id, tenant_id, purpose, prefix, verifier, display_name, key_version) VALUES ($1,$2,'owner_key',$3,$4,'Personal access key', (SELECT COALESCE(MAX(key_version),0)+1 FROM credentials WHERE principal_id = $1))",
        [principalId, tenantId, parsed.lookupPrefix, verifier],
      );
      await c.query("UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE principal_id = $1 AND revoked_at IS NULL", [principalId, event]);
      if (opts.revokeAgents) {
        await c.query("UPDATE credentials SET status = 'revoked', revoked_at = now(), revoked_reason = $1 WHERE purpose = 'agent_key' AND status = 'active'", [event]);
        await c.query("UPDATE principals SET status = 'revoked', revoked_at = now() WHERE kind = 'agent' AND status = 'active'");
      }
      await this.auditIn(c, tenantId, event, channel === "host_reset" ? "host" : "owner", principalId, channel, { agents_revoked: opts.revokeAgents });
    });
    this.verifyCache.clear();
    return newKey;
  }

  // ---------- helpers ----------

  private async findActiveCredential(prefix: string, purpose: "owner_key" | "agent_key", key: string): Promise<CredentialRow | null> {
    const rows = await withAuthenticator(this.pool, async (c) => {
      const r = await c.query<CredentialRow>(
        `SELECT cr.credential_id, cr.principal_id, cr.tenant_id, cr.purpose, cr.verifier, cr.status, cr.display_name, cr.expires_at, cr.last_used_at,
                p.kind, p.display_name AS principal_name, p.status AS principal_status
           FROM credentials cr JOIN principals p ON p.principal_id = cr.principal_id
          WHERE cr.prefix = $1 AND cr.purpose = $2 AND cr.status = 'active' AND p.status = 'active'`,
        [prefix, purpose],
      );
      return r.rows;
    });
    const now = this.now();
    const keyHash = createHash("sha256").update(key).digest("hex");
    const cached = this.verifyCache.get(keyHash);
    const candidates = rows.filter((row) => !(row.expires_at && row.expires_at <= now));
    if (cached && now.getTime() - cached.at < VERIFY_CACHE_MS) {
      const hit = candidates.find((row) => row.credential_id === cached.credential_id);
      if (hit) return hit;
    }
    // One argon2 verification per key at a time: concurrent requests with the same (uncached) key await it.
    const inflightKey = `${purpose}:${keyHash}`;
    let pending = this.verifyInFlight.get(inflightKey);
    if (!pending) {
      pending = (async () => {
        for (const row of candidates) {
          if (await verifyKey(row.verifier, key)) {
            this.verifyCache.set(keyHash, { credential_id: row.credential_id, at: this.now().getTime() });
            if (this.verifyCache.size > 1000) this.verifyCache.clear();
            return row.credential_id;
          }
        }
        return null;
      })().finally(() => this.verifyInFlight.delete(inflightKey));
      this.verifyInFlight.set(inflightKey, pending);
    }
    const credentialId = await pending;
    return credentialId ? (candidates.find((row) => row.credential_id === credentialId) ?? null) : null;
  }

  private async checkThrottle(clientKey: string): Promise<void> {
    const now = this.now();
    const locked = await withInstallation(this.pool, async (c) => {
      const r = await c.query<{ locked_until: Date | null; failures: number; window_start: Date }>("SELECT locked_until, failures, window_start FROM login_throttle WHERE client_key = $1", [clientKey]);
      const row = r.rows[0];
      if (!row) return null;
      if (row.locked_until && row.locked_until > now) return row.locked_until;
      return null;
    });
    if (locked) {
      const retry = Math.ceil((locked.getTime() - now.getTime()) / 1000);
      this.log.warn("auth.login_throttled", "Login attempt rejected by throttle", { error_code: "throttled", retryable: true, next_retry_at: locked.toISOString() });
      throw new AuthError("throttled", 429, "Too many failed login attempts; try again later", retry);
    }
  }

  private async recordFailure(clientKey: string): Promise<void> {
    const now = this.now();
    await withInstallation(this.pool, async (c) => {
      const r = await c.query<{ failures: number; window_start: Date }>("SELECT failures, window_start FROM login_throttle WHERE client_key = $1 FOR UPDATE", [clientKey]);
      const row = r.rows[0];
      if (!row || now.getTime() - row.window_start.getTime() > THROTTLE_WINDOW_MS) {
        await c.query("INSERT INTO login_throttle (client_key, window_start, failures, locked_until) VALUES ($1, $2, 1, NULL) ON CONFLICT (client_key) DO UPDATE SET window_start = $2, failures = 1, locked_until = NULL", [clientKey, now]);
        return;
      }
      const failures = row.failures + 1;
      const lockedUntil = failures >= THROTTLE_MAX_FAILURES ? new Date(row.window_start.getTime() + THROTTLE_WINDOW_MS) : null;
      await c.query("UPDATE login_throttle SET failures = $2, locked_until = $3 WHERE client_key = $1", [clientKey, failures, lockedUntil]);
    });
  }

  private async clearThrottle(clientKey: string): Promise<void> {
    await withInstallation(this.pool, (c) => c.query("DELETE FROM login_throttle WHERE client_key = $1", [clientKey])).catch(() => {});
  }

  async auditIn(c: TenantClient, tenantId: string | null, event: string, actorKind: string, actorId: string | null, channel: string, metadata: Record<string, unknown>): Promise<void> {
    await c.query("INSERT INTO security_audit (tenant_id, event, actor_kind, actor_id, channel, metadata) VALUES ($1,$2,$3,$4,$5,$6)", [tenantId, event, actorKind, actorId, channel, JSON.stringify(metadata)]);
  }

  async audit(tenantId: string, event: string, actorKind: string, actorId: string | null, channel: string, metadata: Record<string, unknown>): Promise<void> {
    await withTenant(this.pool, tenantId, (c) => this.auditIn(c, tenantId, event, actorKind, actorId, channel, metadata));
  }

  async securitySummary(tenantId: string): Promise<{ counts: Record<string, number>; last_events: Array<{ occurred_at: string; event: string; actor_kind: string; channel: string }> }> {
    return withTenant(this.pool, tenantId, async (c) => {
      const counts = await c.query<{ event: string; n: string }>("SELECT event, count(*)::text AS n FROM security_audit WHERE tenant_id = $1 GROUP BY event", [tenantId]);
      const last = await c.query<{ occurred_at: Date; event: string; actor_kind: string; channel: string }>("SELECT occurred_at, event, actor_kind, channel FROM security_audit WHERE tenant_id = $1 ORDER BY audit_id DESC LIMIT 20", [tenantId]);
      return {
        counts: Object.fromEntries(counts.rows.map((r) => [r.event, Number(r.n)])),
        last_events: last.rows.map((r) => ({ occurred_at: r.occurred_at.toISOString(), event: r.event, actor_kind: r.actor_kind, channel: r.channel })),
      };
    });
  }

  /** Current revocation state of a session/credential (used by streams every ≤5 s). */
  async isSessionStillValid(sessionHash: string): Promise<boolean> {
    const now = this.now();
    return withAuthenticator(this.pool, async (c) => {
      const r = await c.query<{ revoked_at: Date | null; absolute_expires_at: Date; idle_expires_at: Date; principal_status: string }>(
        "SELECT s.revoked_at, s.absolute_expires_at, s.idle_expires_at, p.status AS principal_status FROM sessions s JOIN principals p ON p.principal_id = s.principal_id WHERE s.session_hash = $1",
        [sessionHash],
      );
      const row = r.rows[0];
      return Boolean(row && !row.revoked_at && row.principal_status === "active" && row.absolute_expires_at > now && row.idle_expires_at > now);
    });
  }

  async isCredentialStillValid(credentialId: string): Promise<boolean> {
    const now = this.now();
    return withAuthenticator(this.pool, async (c) => {
      const r = await c.query<{ status: string; expires_at: Date | null; principal_status: string }>(
        "SELECT cr.status, cr.expires_at, p.status AS principal_status FROM credentials cr JOIN principals p ON p.principal_id = cr.principal_id WHERE cr.credential_id = $1",
        [credentialId],
      );
      const row = r.rows[0];
      return Boolean(row && row.status === "active" && row.principal_status === "active" && (!row.expires_at || row.expires_at > now));
    });
  }
}
