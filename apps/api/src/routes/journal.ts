import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "@blackbox/database";
import { CursorError, EngineError, QuestionError, ReviewError, buildSchemaFromContracts, type ConsistencyRequest, type Track } from "@blackbox/application";
import type { AppContext } from "../context.js";
import { HttpError, notFound, validation } from "../context.js";
import type { Guards } from "../guards.js";
import { readEvidenceFence } from "../fence.js";

const TRACKS: Track[] = ["source", "fact", "commitment", "movement", "reservation"];
const dt = z.string().datetime({ offset: true });
const journalQuery = z
  .object({
    track: z.enum(["source", "fact", "commitment", "movement", "reservation"]).optional(),
    event_type: z.string().max(100).optional(),
    record_id: z.string().max(200).optional(),
    entity: z.string().regex(/^[a-z_]+:.+$/).max(260).optional(),
    occurred_from: dt.optional(),
    occurred_to: dt.optional(),
    recorded_from: dt.optional(),
    recorded_to: dt.optional(),
    connection_id: z.string().uuid().optional(),
    cursor: z.string().max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
const searchQuery = z.object({ q: z.string().min(1).max(200), track: z.enum(["source", "fact", "commitment", "movement", "reservation"]).optional(), from: dt.optional(), to: dt.optional(), cursor: z.string().max(2000).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict();
const stateQuery = z.object({ mode: z.enum(["latest_committed", "at_least_cursor", "as_of", "stale_explicit"]).optional(), cursor: z.coerce.number().int().min(0).optional(), as_of_recorded: dt.optional(), as_of_effective: dt.optional() }).strict();
const historyQuery = z.object({ cursor: z.string().max(2000).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict();
const questionBody = z.object({ params: z.record(z.string(), z.unknown()).optional().default({}), consistency: z.object({ mode: z.enum(["latest_committed", "at_least_cursor", "as_of", "stale_explicit"]).optional(), cursor: z.number().int().min(0).optional().nullable(), as_of_recorded: dt.optional().nullable(), as_of_effective: dt.optional().nullable(), deadline_ms: z.number().int().min(100).max(5000).optional() }).optional() }).strict();
const restrictBody = z.object({ reason: z.string().min(3).max(500) }).strict();
const reviewAction = z.object({ action: z.enum(["retry", "confirm_link", "reject_link", "append_correction", "leave_open"]), revision: z.number().int().min(1), reason: z.string().min(3).max(500), payload: z.record(z.string(), z.unknown()).optional() }).strict();

function entityParam(raw: string): { type: string; id: string } {
  const i = raw.indexOf(":");
  return { type: raw.slice(0, i), id: raw.slice(i + 1) };
}

function engineErr(err: unknown): never {
  if (err instanceof EngineError) throw new HttpError(err.status, err.code, err.message, { retryable: err.retryable });
  if (err instanceof CursorError) throw new HttpError(404, "not_found", "cursor not found");
  if (err instanceof QuestionError) throw new HttpError(err.status, err.code, err.message, { details: err.details });
  if (err instanceof ReviewError) throw new HttpError(err.status, err.code, err.message);
  throw err;
}

export function registerJournalRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards): void {
  app.get("/api/journal", { preHandler: [guards.requireRead] }, async (request) => {
    const q = journalQuery.safeParse(request.query);
    if (!q.success) throw validation("invalid journal filter", q.error.issues);
    try {
      const r = await ctx.journal.list(guards.tenantOf(request), { ...q.data, entity: q.data.entity ? entityParam(q.data.entity) : undefined }, { cursor: q.data.cursor ?? null, limit: q.data.limit });
      return { entries: r.entries, page: r.page, consistency: r.consistency };
    } catch (err) {
      engineErr(err);
    }
  });

  app.get("/api/journal/:entry_id", { preHandler: [guards.requireRead] }, async (request) => {
    const r = await ctx.journal.get(guards.tenantOf(request), (request.params as { entry_id: string }).entry_id);
    if (!r) throw notFound("entry");
    return r;
  });

  app.get("/api/entities/:type/:id/state", { preHandler: [guards.requireRead] }, async (request) => {
    const { type, id } = request.params as { type: string; id: string };
    const q = stateQuery.safeParse(request.query);
    if (!q.success) throw validation("invalid state query", q.error.issues);
    const tenantId = guards.tenantOf(request);
    const consistency: ConsistencyRequest = { mode: q.data.mode ?? (q.data.as_of_recorded || q.data.as_of_effective ? "as_of" : "latest_committed"), cursor: q.data.cursor ?? null, as_of_recorded: q.data.as_of_recorded ?? null, as_of_effective: q.data.as_of_effective ?? null, deadline_ms: 5000 };
    const started = process.hrtime.bigint();
    try {
      const state = await ctx.engine.state({ tenant_id: tenantId, entity_type: type, entity_id: id, consistency });
      const readiness = await ctx.readiness.compute(tenantId);
      const cons = state.consistency as { applied_cursor?: number } | undefined;
      ctx.logger.info("query.served", "Entity state served", { tenant_id: tenantId, operation_id: `state:${type}`, duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6), applied_cursor: cons?.applied_cursor });
      return { ...state, readiness: { datasets_present: readiness.datasets_present, datasets_missing: readiness.datasets_missing, sources: Object.values(readiness.dataset_sources).flat() } };
    } catch (err) {
      if (err instanceof EngineError) {
        const stats = await ctx.journal.stats(tenantId);
        throw new HttpError(err.status, err.code, err.message, { retryable: err.retryable, details: { committed_cursor: stats.committed_cursor } });
      }
      engineErr(err);
    }
  });

  app.get("/api/entities/:type/:id/history", { preHandler: [guards.requireRead] }, async (request) => {
    const { type, id } = request.params as { type: string; id: string };
    const q = historyQuery.safeParse(request.query);
    if (!q.success) throw validation("invalid history query", q.error.issues);
    try {
      return await ctx.journal.entityHistory(guards.tenantOf(request), type, id, { cursor: q.data.cursor ?? null, limit: q.data.limit });
    } catch (err) {
      engineErr(err);
    }
  });

  app.get("/api/search", { preHandler: [guards.requireRead] }, async (request) => {
    const q = searchQuery.safeParse(request.query);
    if (!q.success) throw validation("q is required", q.error.issues);
    try {
      const r = await ctx.journal.list(guards.tenantOf(request), { q: q.data.q, track: q.data.track, occurred_from: q.data.from, occurred_to: q.data.to }, { cursor: q.data.cursor ?? null, limit: q.data.limit });
      return { entries: r.entries, page: r.page, consistency: r.consistency, search: { literal: q.data.q, fields: ["record_id", "event_type", "entity_refs"] } };
    } catch (err) {
      engineErr(err);
    }
  });

  app.get("/api/evidence/:evidence_id", { preHandler: [guards.requireRead] }, async (request) => {
    const id = (request.params as { evidence_id: string }).evidence_id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("evidence");
    const tenantId = guards.tenantOf(request);
    const access = await withTenant(ctx.pool, tenantId, (c) => ctx.evidence.get(c, tenantId, id));
    if (access.status === "unavailable" && !access.meta) throw notFound("evidence");
    const fence = readEvidenceFence(ctx.config.fenceDir);
    if (fence) return { status: "restricted", reason: fence.reason, since: fence.since, evidence: access.meta };
    if (access.status !== "available") return { status: access.status, reason: access.reason, evidence: access.meta };
    const text = access.meta.media_type === "application/json" || access.meta.media_type.startsWith("text/") ? access.content.toString("utf8") : null;
    return { status: "available", evidence: access.meta, content: text !== null ? (access.meta.media_type === "application/json" ? safeJson(text) : text) : null, content_encoding: text === null ? "binary_use_content_endpoint" : "inline" };
  });

  app.get("/api/evidence/:evidence_id/content", { preHandler: [guards.requireRead] }, async (request, reply) => {
    const id = (request.params as { evidence_id: string }).evidence_id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("evidence");
    const tenantId = guards.tenantOf(request);
    const access = await withTenant(ctx.pool, tenantId, (c) => ctx.evidence.get(c, tenantId, id));
    if (access.status === "unavailable" && !access.meta) throw notFound("evidence");
    const fence = readEvidenceFence(ctx.config.fenceDir);
    if (fence) throw new HttpError(423, "evidence_restricted", fence.reason);
    if (access.status !== "available") throw new HttpError(410, `evidence_${access.status}`, access.reason);
    reply.header("content-type", access.meta.media_type);
    reply.header("content-disposition", `attachment; filename="evidence-${id}.${access.meta.media_type === "application/json" ? "json" : "bin"}"`);
    reply.header("x-content-type-options", "nosniff");
    return reply.send(access.content);
  });

  // PILOT-08: owner-authorized restriction of one raw evidence object. Appends an immutable ledger row and a
  // security-audit event in one transaction, then removes the live content. Typed journal entries, their
  // evidence_refs and the business history stay; every content path (API, MCP, UI) answers the explicit
  // status `restricted` with the recorded reason. Agents cannot restrict (owner session + CSRF only).
  app.post("/api/evidence/:evidence_id/restrict", { preHandler: [guards.requireOwner] }, async (request, reply) => {
    const id = (request.params as { evidence_id: string }).evidence_id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("evidence");
    const body = restrictBody.safeParse(request.body ?? {});
    if (!body.success) throw validation("invalid restriction request", body.error.issues);
    const tenantId = guards.tenantOf(request);
    const actor = guards.principalOf(request).id;
    const r = await withTenant(ctx.pool, tenantId, async (c) => {
      const res = await ctx.evidence.restrict(c, { tenantId, evidenceId: id, reason: body.data.reason, actorId: actor });
      if (res.found && !res.already) await ctx.auth.auditIn(c, tenantId, "evidence.restricted", "owner", actor, "api", { evidence_id: id, redaction_id: res.redactionId, reason_length: body.data.reason.length });
      return res;
    });
    if (!r.found) throw notFound("evidence");
    const removed = r.storageRef ? ctx.evidence.removeContent(tenantId, r.storageRef) : false;
    ctx.logger.info("evidence.restricted", r.already ? "Evidence already restricted; no new ledger row" : "Evidence restricted by the owner; live content removed", { tenant_id: tenantId, trace_id: request.traceId });
    reply.code(r.already ? 200 : 201);
    return { status: "restricted", evidence_id: id, redaction_id: r.redactionId, already_restricted: r.already, content_removed: removed, audited: !r.already };
  });

  app.get("/api/schema", { preHandler: [guards.requireRead] }, async (request) => {
    const tenantId = guards.tenantOf(request);
    const readiness = await ctx.readiness.compute(tenantId);
    let engineSchema: Record<string, unknown>;
    try {
      engineSchema = await ctx.engine.schema();
    } catch {
      engineSchema = { ...buildSchemaFromContracts(), engine: "unavailable" };
    }
    return { ...engineSchema, workspace_coverage: { datasets_present: readiness.datasets_present, datasets_missing: readiness.datasets_missing, sources: Object.values(readiness.dataset_sources).flat() }, query_capabilities: { tools: ["describe_business_schema", "list_journal_entries", "get_journal_entry", "get_entity_history", "search_events", "get_business_state", "get_evidence", "query_business", "answer_question", "get_readiness"], max_page_rows: 500, default_page_rows: 100, tracks: TRACKS } };
  });

  // ----- questions -----
  app.get("/api/questions", { preHandler: [guards.requireRead] }, async (request) => {
    const readiness = await ctx.readiness.compute(guards.tenantOf(request));
    const byIntent = new Map(readiness.questions.map((q) => [q.intent, q]));
    return { questions: ctx.questions.templates().map((t) => ({ ...t, readiness: byIntent.get(t.intent) ?? null })) };
  });

  app.get("/api/questions/search", { preHandler: [guards.requireRead] }, async (request) => {
    const q = (request.query as { q?: string }).q ?? "";
    if (q.length > 200) throw validation("q too long");
    return { matches: ctx.questions.search(q), note: "literal template title/intent match only; free text is never sent to a model" };
  });

  app.post("/api/questions/:intent", { preHandler: [guards.requireRead], config: { agentPost: true } }, async (request) => {
    const intent = (request.params as { intent: string }).intent;
    const body = questionBody.safeParse(request.body ?? {});
    if (!body.success) throw validation("body must be {params?, consistency?}", body.error.issues);
    const principal = guards.principalOf(request);
    try {
      return await ctx.questions.answer(guards.tenantOf(request), intent, body.data.params, body.data.consistency as Partial<ConsistencyRequest> | undefined, principal.kind);
    } catch (err) {
      engineErr(err);
    }
  });

  // ----- review cases -----
  app.get("/api/review/cases", { preHandler: [guards.requireRead] }, async (request) => {
    const state = (request.query as { state?: string }).state;
    if (state && !["open", "in_progress", "resolved"].includes(state)) throw validation("state must be open|in_progress|resolved");
    return { cases: await ctx.review.list(guards.tenantOf(request), state) };
  });

  app.get("/api/review/cases/:id", { preHandler: [guards.requireRead] }, async (request) => {
    const c = await ctx.review.get(guards.tenantOf(request), (request.params as { id: string }).id);
    if (!c) throw notFound("case");
    return c;
  });

  app.post("/api/review/cases/:id/actions", { preHandler: [guards.requireOwner] }, async (request) => {
    const body = reviewAction.safeParse(request.body);
    if (!body.success) throw validation("action, revision and reason are required", body.error.issues);
    try {
      return await ctx.review.act(guards.tenantOf(request), guards.principalOf(request).id, (request.params as { id: string }).id, body.data);
    } catch (err) {
      engineErr(err);
    }
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
