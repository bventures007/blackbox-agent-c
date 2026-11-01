import type { Pool } from "@blackbox/database";
import { withTenant } from "@blackbox/database";
import type { Logger } from "@blackbox/logging";

export type ReviewAction = "retry" | "confirm_link" | "reject_link" | "append_correction" | "leave_open";

export interface ReviewCase {
  case_id: string;
  tenant_id: string;
  connection_id: string | null;
  run_id: string | null;
  type: string;
  state: "open" | "in_progress" | "resolved";
  revision: number;
  reason: string;
  refs: Record<string, unknown>;
  history: unknown[];
  resolution_entry_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export class ReviewError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
    this.status = status;
  }
}

function rowToCase(r: Record<string, unknown>): ReviewCase {
  const ts = (v: unknown) => (v ? (v as Date).toISOString() : null);
  return {
    case_id: r.case_id as string,
    tenant_id: r.tenant_id as string,
    connection_id: (r.connection_id as string | null) ?? null,
    run_id: (r.run_id as string | null) ?? null,
    type: r.type as string,
    state: r.state as ReviewCase["state"],
    revision: Number(r.revision),
    reason: r.reason as string,
    refs: (r.refs as Record<string, unknown>) ?? {},
    history: (r.history as unknown[]) ?? [],
    resolution_entry_id: (r.resolution_entry_id as string | null) ?? null,
    created_at: ts(r.created_at)!,
    updated_at: ts(r.updated_at)!,
    resolved_at: ts(r.resolved_at),
  };
}

/**
 * Owner-only repair workflow (PILOT-OPERATIONS §3). Decisions are appended as `review.decision`
 * fact entries with actor/reason/evidence and `supersedes_entry_id`; the case row is mutable
 * operational state guarded by optimistic revisions (409 on stale revision, idempotent repeats).
 */
export class ReviewService {
  constructor(
    private readonly pool: Pool,
    private readonly log: Logger,
  ) {}

  async list(tenantId: string, state?: string): Promise<ReviewCase[]> {
    return withTenant(this.pool, tenantId, async (c) => {
      const r = state ? await c.query("SELECT * FROM review_cases WHERE state = $1 ORDER BY created_at DESC LIMIT 500", [state]) : await c.query("SELECT * FROM review_cases ORDER BY created_at DESC LIMIT 500");
      return r.rows.map(rowToCase);
    });
  }

  async get(tenantId: string, caseId: string): Promise<ReviewCase | null> {
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) return null;
    return withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query("SELECT * FROM review_cases WHERE case_id = $1", [caseId]);
      return r.rows[0] ? rowToCase(r.rows[0]) : null;
    });
  }

  async unresolvedCount(tenantId: string): Promise<number> {
    return withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM review_cases WHERE state <> 'resolved'");
      return Number(r.rows[0]?.n ?? 0);
    });
  }

  async act(tenantId: string, actorId: string, caseId: string, input: { action: ReviewAction; revision: number; reason: string; payload?: Record<string, unknown> }): Promise<ReviewCase> {
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new ReviewError("not_found", 404, "case not found");
    if (!input.reason || input.reason.length < 3 || input.reason.length > 500) throw new ReviewError("validation", 422, "reason is required (3-500 characters)");
    const result = await withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query("SELECT * FROM review_cases WHERE case_id = $1 FOR UPDATE", [caseId]);
      const row = r.rows[0];
      if (!row) throw new ReviewError("not_found", 404, "case not found");
      const current = rowToCase(row);
      // Idempotent repeat: same action from the same revision already applied → return current state.
      const prior = await c.query<{ action_id: string }>("SELECT action_id FROM review_actions WHERE case_id = $1 AND from_revision = $2 AND action = $3 AND actor_id = $4", [caseId, input.revision, input.action, actorId]);
      if (prior.rows[0]) return current;
      if (current.revision !== input.revision) throw new ReviewError("stale_revision", 409, `case revision is ${current.revision}, request used ${input.revision}`);
      if (current.state === "resolved") throw new ReviewError("already_resolved", 409, "case is already resolved");
      let entryId: string | null = null;
      let newState: ReviewCase["state"] = current.state;
      if (input.action === "leave_open") newState = "open";
      else if (input.action === "retry") newState = "in_progress";
      else {
        // Business decision: append a fact entry with provenance. Never edits prior entries.
        const supersedes = typeof input.payload?.supersedes_entry_id === "string" ? input.payload.supersedes_entry_id : (typeof current.refs.original_entry_id === "string" ? current.refs.original_entry_id : null);
        const decisionPayload: Record<string, unknown> = {
          decision: input.action,
          case_id: caseId,
          reason: input.reason,
          actor_kind: "owner",
          provenance: "human_confirmed",
          correction: input.action === "append_correction" ? (input.payload?.correction ?? null) : null,
          link: input.action === "confirm_link" || input.action === "reject_link" ? (input.payload?.link ?? current.refs.link ?? null) : null,
        };
        const original = supersedes ? await c.query<{ record_id: string; entity_refs: Record<string, string>; evidence_refs: string[] }>("SELECT record_id, entity_refs, evidence_refs FROM journal_entries WHERE entry_id = $1", [supersedes]) : null;
        const orig = original?.rows[0];
        const draft = {
          track: "fact",
          record_id: orig?.record_id ?? `case:${caseId}`,
          event_type: "review.decision",
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          entity_refs: orig?.entity_refs ?? {},
          payload: decisionPayload,
          evidence_refs: Array.isArray(input.payload?.evidence_refs) ? (input.payload!.evidence_refs as string[]).filter((x) => typeof x === "string").slice(0, 20) : (orig?.evidence_refs ?? []),
          input_entry_ids: supersedes ? [supersedes] : [],
          derivation_rule: "review.decision",
          derivation_version: 1,
          supersedes_entry_id: input.action === "append_correction" || input.action === "reject_link" ? supersedes : null,
          correlation_id: caseId,
        };
        const appended = await c.query<{ append_journal_entries: Array<{ entry_id: string }> }>("SELECT append_journal_entries($1::jsonb)", [JSON.stringify([draft])]);
        entryId = appended.rows[0]!.append_journal_entries[0]!.entry_id;
        newState = "resolved";
      }
      const historyItem = { at: new Date().toISOString(), actor: actorId, action: input.action, reason: input.reason, entry_id: entryId };
      await c.query("INSERT INTO review_actions (tenant_id, case_id, action, from_revision, actor_id, reason, payload, entry_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [tenantId, caseId, input.action, input.revision, actorId, input.reason, JSON.stringify(input.payload ?? {}), entryId]);
      const upd = await c.query(
        "UPDATE review_cases SET state = $2, revision = revision + 1, updated_at = now(), history = history || $3::jsonb, resolution_entry_id = COALESCE($4, resolution_entry_id), resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE resolved_at END WHERE case_id = $1 RETURNING *",
        [caseId, newState, JSON.stringify([historyItem]), entryId],
      );
      return rowToCase(upd.rows[0]!);
    });
    this.log.info("review.action_applied", "Review action applied", { tenant_id: tenantId, operation_id: caseId, action_code: input.action });
    return result;
  }
}
