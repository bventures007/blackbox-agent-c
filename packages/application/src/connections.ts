import type { Pool, TenantClient } from "@blackbox/database";
import { withTenant } from "@blackbox/database";
import { encryptSecret, type DataKey } from "@blackbox/auth";
import { capabilitiesFor, pollGroupOf } from "@blackbox/connectors";
import { loadQuestionContracts } from "./contracts.js";
import { SignedInputService } from "./signed.js";

export const CONNECTION_SECRET_PURPOSE = "connection_secret";

/** Providers whose ingestion path exists in this backend (producers); others are planned/connector-owned. */
export const IMPLEMENTED_PROVIDERS = new Set(["generic", "bank_csv", "replay", "policy"]);
export const CONNECTOR_PROVIDERS = new Set(["shopify", "shopify_payments", "easybill", "dhl"]);

export interface ConnectionSummary {
  connection_id: string;
  provider: string;
  display_name: string;
  account_ref: string | null;
  status: string;
  config: Record<string, unknown>;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
  disconnected_at: string | null;
}

export interface ImportRun {
  run_id: string;
  connection_id: string;
  plan_id: string | null;
  kind: string;
  phase: string;
  state: string;
  counters: { requested: number; loaded: number; committed: number; applied: number; failed: number; duplicates: number; conflicts: number; rejected: number };
  totals_known: boolean;
  pages: number;
  poll_group: string | null;
  capability_scope: string[];
  coverage_from: string | null;
  coverage_to: string | null;
  percent: number | null;
  attempt: number;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  outcome: string | null;
  error_code: string | null;
  next_action: string | null;
  committed_cursor: number | null;
}

export class ConnectionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ConnectionError";
    this.code = code;
    this.status = status;
  }
}

function rowToConnection(r: Record<string, unknown>): ConnectionSummary {
  const ts = (v: unknown) => (v ? (v as Date).toISOString() : null);
  const config = { ...((r.config_json as Record<string, unknown>) ?? {}) };
  return {
    connection_id: r.connection_id as string,
    provider: r.provider as string,
    display_name: r.display_name as string,
    account_ref: (r.account_ref as string | null) ?? null,
    status: r.status as string,
    config,
    has_secret: Boolean(r.secret_ciphertext),
    created_at: ts(r.created_at)!,
    updated_at: ts(r.updated_at)!,
    disconnected_at: ts(r.disconnected_at),
  };
}

export function rowToRun(r: Record<string, unknown>): ImportRun {
  const ts = (v: unknown) => (v ? (v as Date).toISOString() : null);
  const requested = Number(r.requested);
  const loaded = Number(r.loaded);
  const totalsKnown = Boolean(r.totals_known);
  return {
    run_id: r.run_id as string,
    connection_id: r.connection_id as string,
    plan_id: (r.plan_id as string | null) ?? null,
    kind: r.kind as string,
    phase: r.phase as string,
    state: r.state as string,
    counters: { requested, loaded, committed: Number(r.committed), applied: Number(r.applied), failed: Number(r.failed), duplicates: Number(r.duplicates), conflicts: Number(r.conflicts ?? 0), rejected: Number(r.rejected ?? 0) },
    totals_known: totalsKnown,
    pages: Number(r.pages ?? 0),
    poll_group: ((r.checkpoint as Record<string, unknown> | null)?.poll_group as string | undefined) ?? null,
    capability_scope: Array.isArray(r.capability_scope) ? (r.capability_scope as string[]) : [],
    coverage_from: ts(r.coverage_from),
    coverage_to: ts(r.coverage_to),
    // Percentages only when an exact total for the named cohort is known (IMPORT-03).
    percent: totalsKnown && requested > 0 ? Math.min(100, Math.round((loaded / requested) * 100)) : null,
    attempt: Number(r.attempt),
    started_at: ts(r.started_at),
    updated_at: ts(r.updated_at)!,
    finished_at: ts(r.finished_at),
    outcome: (r.outcome as string | null) ?? null,
    error_code: (r.error_code as string | null) ?? null,
    next_action: (r.next_action as string | null) ?? null,
    committed_cursor: r.committed_cursor === null || r.committed_cursor === undefined ? null : Number(r.committed_cursor),
  };
}

/**
 * `applied` is derived at read time from the engine checkpoint: once the engine's applied cursor has
 * reached the run's committed cursor every committed record of the run is applied; before that the
 * worker's last observation stands (durable counters never claim more than the checkpoint proves).
 */
export function withLiveApplied(run: ImportRun, appliedSequence: number | null): ImportRun {
  if (appliedSequence === null || run.committed_cursor === null) return run;
  if (appliedSequence >= run.committed_cursor) return { ...run, counters: { ...run.counters, applied: run.counters.committed } };
  return run;
}

export class ConnectionService {
  private readonly signed: SignedInputService;
  constructor(
    private readonly pool: Pool,
    private readonly dataKey: DataKey,
  ) {
    this.signed = new SignedInputService(pool, dataKey);
  }

  knownProviders(): Array<{ id: string; name: string; release_scope: string }> {
    return loadQuestionContracts().providers.map((p) => ({ id: p.id, name: p.name, release_scope: p.release_scope }));
  }

  async create(tenantId: string, input: { provider: string; display_name: string; config?: Record<string, unknown>; secret?: Record<string, unknown>; account_ref?: string | null }): Promise<{ connection: ConnectionSummary; producer?: { producer_id: string; secret: string } }> {
    const known = this.knownProviders().find((p) => p.id === input.provider);
    if (!known) throw new ConnectionError("unknown_provider", 422, `provider '${input.provider}' is not in the catalogue`);
    if (known.release_scope !== "first_release") throw new ConnectionError("provider_planned", 422, `provider '${input.provider}' is planned, not available in the local pilot`);
    return withTenant(this.pool, tenantId, async (c) => {
      const config = { ...(input.config ?? {}) };
      delete config.secret;
      const ciphertext = input.secret && Object.keys(input.secret).length > 0 ? encryptSecret(this.dataKey, JSON.stringify(input.secret), { tenantId, purpose: CONNECTION_SECRET_PURPOSE }) : null;
      const r = await c.query(
        "INSERT INTO connections (tenant_id, provider, account_ref, display_name, status, config_json, secret_ciphertext, secret_key_version) VALUES ($1,$2,$3,$4,'configured',$5,$6,$7) RETURNING *",
        [tenantId, input.provider, input.account_ref ?? null, input.display_name, JSON.stringify(config), ciphertext, ciphertext ? this.dataKey.version : null],
      );
      const connection = rowToConnection(r.rows[0]!);
      let producer: { producer_id: string; secret: string } | undefined;
      if (input.provider === "generic") producer = await this.signed.createProducer(c, tenantId, connection.connection_id, `${input.display_name} producer`);
      return { connection, producer };
    });
  }

  async list(tenantId: string): Promise<ConnectionSummary[]> {
    return withTenant(this.pool, tenantId, async (c) => (await c.query("SELECT * FROM connections ORDER BY created_at")).rows.map(rowToConnection));
  }

  async get(tenantId: string, connectionId: string): Promise<ConnectionSummary | null> {
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
    return withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query("SELECT * FROM connections WHERE connection_id = $1", [connectionId]);
      return r.rows[0] ? rowToConnection(r.rows[0]) : null;
    });
  }

  async setStatus(tenantId: string, connectionId: string, action: "pause" | "resume" | "disconnect"): Promise<ConnectionSummary | null> {
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
    return withTenant(this.pool, tenantId, async (c) => {
      const status = action === "pause" ? "paused" : action === "resume" ? "configured" : "disconnected";
      const r = await c.query("UPDATE connections SET status = $2, updated_at = now(), disconnected_at = CASE WHEN $2 = 'disconnected' THEN now() ELSE disconnected_at END WHERE connection_id = $1 AND status <> 'disconnected' RETURNING *", [connectionId, status]);
      if (!r.rows[0]) return null;
      await c.query("UPDATE capability_health SET status = $2, observed_at = now(), next_check_at = NULL, next_check_reason = $3 WHERE connection_id = $1", [connectionId, action === "resume" ? "unknown" : action === "pause" ? "paused" : "unavailable", action === "resume" ? "resumed: awaiting next check" : `${action}: no further checks`]);
      return rowToConnection(r.rows[0]);
    });
  }

  async createRun(tenantId: string, connectionId: string, kind: ImportRun["kind"], planId: string | null, opts: { requested?: number; totalsKnown?: boolean } = {}): Promise<ImportRun> {
    return withTenant(this.pool, tenantId, async (c) => {
      const conn = await c.query<{ status: string }>("SELECT status FROM connections WHERE connection_id = $1", [connectionId]);
      if (!conn.rows[0]) throw new ConnectionError("connection_not_found", 404, "connection not found");
      if (conn.rows[0].status === "disconnected") throw new ConnectionError("connection_disconnected", 409, "connection is disconnected");
      const r = await c.query("INSERT INTO import_runs (tenant_id, connection_id, plan_id, kind, phase, state, requested, totals_known, started_at) VALUES ($1,$2,$3,$4,'check_connection','running',$5,$6,now()) RETURNING *", [tenantId, connectionId, planId, kind, opts.requested ?? 0, Boolean(opts.totalsKnown)]);
      return rowToRun(r.rows[0]!);
    });
  }

  /**
   * Queues worker-executed runs for a polled connector (one per poll group, the row shape
   * `apps/worker` SyncEngine.executeRun expects: state queued, checkpoint {poll_group, cursor, window},
   * capability_scope). `check` queues one credential check. The worker scheduler dispatches queued
   * runs on its next tick; counters/phases are then updated by the worker after every COMMIT.
   */
  async queueRuns(tenantId: string, connectionId: string, kind: "backfill" | "incremental" | "reconcile" | "check", planId: string | null): Promise<ImportRun[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const conn = await c.query<{ status: string; provider: string }>("SELECT status, provider FROM connections WHERE connection_id = $1", [connectionId]);
      if (!conn.rows[0]) throw new ConnectionError("connection_not_found", 404, "connection not found");
      if (conn.rows[0].status === "disconnected") throw new ConnectionError("connection_disconnected", 409, "connection is disconnected");
      const provider = conn.rows[0].provider;
      const caps = capabilitiesFor(provider).filter((cap) => cap.modes.local_standalone.methods.includes("polling"));
      if (caps.length === 0) throw new ConnectionError("runs_not_applicable", 422, `provider '${provider}' is producer-driven (no outbound polling); runs are not applicable`);
      const groups = [...new Set(caps.map((cap) => pollGroupOf(provider, cap.id)))];
      if (kind === "backfill" && !planId) throw new ConnectionError("import_plan_required", 422, "create an import plan before starting a backfill");
      const open = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM import_runs WHERE connection_id = $1 AND kind = $2 AND state IN ('queued','running')", [connectionId, kind]);
      if (Number(open.rows[0]?.n ?? 0) > 0) throw new ConnectionError("run_already_active", 409, `a ${kind} run is already queued or running for this connection`);
      const selected = kind === "check" ? groups.slice(0, 1) : groups;
      const runs: ImportRun[] = [];
      for (const group of selected) {
        const scope = caps.filter((cap) => pollGroupOf(provider, cap.id) === group).map((cap) => cap.id);
        const checkpoint = { poll_group: group, cursor: null, window: null };
        const r = await c.query(
          `INSERT INTO import_runs (tenant_id, connection_id, plan_id, kind, state, phase, checkpoint, capability_scope)
           VALUES ($1, $2, $3, $4, 'queued', 'check_connection', $5, $6) RETURNING *`,
          [tenantId, connectionId, planId, kind, JSON.stringify(checkpoint), JSON.stringify(scope)],
        );
        runs.push(rowToRun(r.rows[0]!));
      }
      if (kind === "backfill") await c.query("UPDATE connections SET status = 'backfilling', updated_at = now() WHERE connection_id = $1 AND status IN ('configured','validating')", [connectionId]);
      return runs;
    });
  }

  async updateRun(tenantId: string, runId: string, patch: Partial<{ phase: string; state: string; outcome: string | null; error_code: string | null; next_action: string | null; applied: number; finished: boolean }>): Promise<ImportRun | null> {
    return withTenant(this.pool, tenantId, async (c) => {
      const sets: string[] = ["updated_at = now()"];
      const params: unknown[] = [runId];
      const add = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (patch.phase) add("phase", patch.phase);
      if (patch.state) add("state", patch.state);
      if (patch.outcome !== undefined) add("outcome", patch.outcome);
      if (patch.error_code !== undefined) add("error_code", patch.error_code);
      if (patch.next_action !== undefined) add("next_action", patch.next_action);
      if (patch.applied !== undefined) add("applied", patch.applied);
      if (patch.finished) sets.push("finished_at = now()");
      const r = await c.query(`UPDATE import_runs SET ${sets.join(", ")} WHERE run_id = $1 RETURNING *`, params);
      return r.rows[0] ? rowToRun(r.rows[0]) : null;
    });
  }

  async getRun(tenantId: string, connectionId: string, runId: string): Promise<ImportRun | null> {
    if (!/^[0-9a-f-]{36}$/i.test(runId) || !/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
    return withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query("SELECT * FROM import_runs WHERE run_id = $1 AND connection_id = $2", [runId, connectionId]);
      if (!r.rows[0]) return null;
      const applied = await this.appliedSequence(c, tenantId);
      return withLiveApplied(rowToRun(r.rows[0]), applied);
    });
  }

  async listRuns(tenantId: string, connectionId: string): Promise<ImportRun[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const rows = (await c.query("SELECT * FROM import_runs WHERE connection_id = $1 ORDER BY started_at DESC NULLS LAST LIMIT 50", [connectionId])).rows;
      const applied = await this.appliedSequence(c, tenantId);
      return rows.map((row) => withLiveApplied(rowToRun(row), applied));
    });
  }

  /** Engine checkpoint of this workspace (applied journal cursor), read inside the tenant transaction. */
  private async appliedSequence(c: TenantClient, tenantId: string): Promise<number | null> {
    const r = await c.query<{ applied_sequence: string }>("SELECT applied_sequence FROM engine_checkpoints WHERE tenant_id = $1", [tenantId]);
    return r.rows[0] ? Number(r.rows[0].applied_sequence) : null;
  }

  async healthFor(c: TenantClient, connectionId: string): Promise<Array<Record<string, unknown>>> {
    const r = await c.query("SELECT * FROM capability_health WHERE connection_id = $1 ORDER BY capability_id", [connectionId]);
    return r.rows.map((h) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(h as Record<string, unknown>)) out[k] = v instanceof Date ? v.toISOString() : v;
      delete out.tenant_id;
      return out;
    });
  }

  /** Records a scoped check result without claiming new events (HEALTH-01 semantics). */
  async recordCheck(tenantId: string, connectionId: string, capabilityId: string, result: { outcome: "success_empty" | "success_new" | "failed" | "credential_only"; coverage?: { from: string | null; to: string | null; state: string; history_kind?: string }; limitations?: string[]; schedule_seconds?: number | null; error_code?: string | null }): Promise<void> {
    await withTenant(this.pool, tenantId, async (c) => {
      const next = result.schedule_seconds ? new Date(Date.now() + result.schedule_seconds * 1000) : null;
      const nextReason = result.schedule_seconds ? "scheduled poll" : "producer_driven: no scheduled poll";
      const status = result.outcome === "failed" ? "degraded" : result.outcome === "credential_only" ? "unknown" : "healthy";
      await c.query(
        `INSERT INTO capability_health (tenant_id, connection_id, capability_id, observed_at, status, last_attempt_at, last_successful_check_at, last_new_event_at, next_check_at, next_check_reason, coverage_from, coverage_to, coverage_state, history_kind, limitations, schedule_seconds, failed_count)
         VALUES ($1,$2,$3, now(), $4, now(), CASE WHEN $5 THEN now() ELSE NULL END, CASE WHEN $6 THEN now() ELSE NULL END, $7, $8, $9, $10, $11, $12, $13, $14, CASE WHEN $15 THEN 1 ELSE 0 END)
         ON CONFLICT (connection_id, capability_id) DO UPDATE SET
           observed_at = now(), status = EXCLUDED.status, last_attempt_at = now(),
           last_successful_check_at = CASE WHEN $5 THEN now() ELSE capability_health.last_successful_check_at END,
           last_new_event_at = CASE WHEN $6 THEN now() ELSE capability_health.last_new_event_at END,
           next_check_at = EXCLUDED.next_check_at, next_check_reason = EXCLUDED.next_check_reason,
           coverage_from = COALESCE(EXCLUDED.coverage_from, capability_health.coverage_from),
           coverage_to = COALESCE(EXCLUDED.coverage_to, capability_health.coverage_to),
           coverage_state = CASE WHEN $5 THEN EXCLUDED.coverage_state ELSE capability_health.coverage_state END,
           history_kind = EXCLUDED.history_kind, limitations = EXCLUDED.limitations, schedule_seconds = EXCLUDED.schedule_seconds,
           failed_count = CASE WHEN $15 THEN capability_health.failed_count + 1 ELSE 0 END`,
        [
          tenantId,
          connectionId,
          capabilityId,
          status,
          result.outcome === "success_empty" || result.outcome === "success_new",
          result.outcome === "success_new",
          next,
          nextReason,
          result.coverage?.from ?? null,
          result.coverage?.to ?? null,
          result.coverage?.state ?? "unknown",
          result.coverage?.history_kind ?? "unknown",
          JSON.stringify(result.limitations ?? []),
          result.schedule_seconds ?? null,
          result.outcome === "failed",
        ],
      );
    });
  }
}
