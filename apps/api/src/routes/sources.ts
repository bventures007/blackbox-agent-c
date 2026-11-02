import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "@blackbox/database";
import { ConnectionError, DemoError, ImportPlanError, IngestionError, SignedInputError, CONNECTOR_PROVIDERS, IMPLEMENTED_PROVIDERS, type Observation } from "@blackbox/application";
import type { AppContext } from "../context.js";
import { HttpError, notFound, validation } from "../context.js";
import type { Guards } from "../guards.js";

const connectionCreate = z.object({ provider: z.string().min(1).max(40), display_name: z.string().min(1).max(120), config: z.record(z.string(), z.unknown()).optional(), secret: z.record(z.string(), z.unknown()).optional(), account_ref: z.string().max(200).optional().nullable() }).strict();
const importPlanBody = z.object({ preset: z.enum(["last_30_days", "this_year", "last_12_months", "custom", "from_now"]), from: z.string().optional().nullable(), to: z.string().optional().nullable(), timezone: z.string().min(1).max(64), include_open_context: z.boolean(), include_opening_state: z.boolean().optional() }).strict();
const runBody = z.object({ kind: z.enum(["backfill", "incremental", "reconcile", "check"]) }).strict();
const observationSchema = z.object({
  provider_event_id: z.string().min(1).max(300),
  kind: z.string().min(1).max(100),
  occurred_at: z.string().datetime({ offset: true }),
  source_time: z.string().datetime({ offset: true }).optional().nullable(),
  entity: z.record(z.string(), z.union([z.string(), z.number()])).optional().default({}),
  payload: z.record(z.string(), z.unknown()),
  evidence_refs: z.array(z.string().max(300)).max(50).optional().default([]),
  correlation_id: z.string().max(200).optional().nullable(),
  schema_version: z.number().int().min(1).max(100).optional(),
  /** Correction: the earlier entry this observation supersedes (engine reverts it before applying). */
  supersedes_entry_id: z.string().uuid().optional().nullable(),
});
const replayBody = z.object({ connection_id: z.string().uuid(), run_id: z.string().uuid().optional(), events: z.array(observationSchema).min(1).max(1000) }).strict();
const genericBody = z.object({ connection_id: z.string().uuid(), records: z.array(observationSchema).min(1).max(1000) }).passthrough();
const bankBody = z.object({ connection_id: z.string().uuid(), csv: z.string().min(1).max(5 * 1024 * 1024), mapping: z.record(z.string(), z.string()).optional() }).strict();
const policyBody = z.object({ connection_id: z.string().uuid(), policy: z.object({ version: z.number().int().min(1), rules: z.array(z.record(z.string(), z.unknown())).max(200) }).strict() }).strict();
const demoBody = z.object({ confirm: z.boolean().optional(), up_to: z.string().regex(/^G\d{2}$/).optional() }).strict().optional();

function toObservation(e: z.infer<typeof observationSchema>): Observation {
  const entity: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.entity)) entity[k] = String(v);
  return { provider_event_id: e.provider_event_id, kind: e.kind, occurred_at: e.occurred_at, source_time: e.source_time ?? null, entity, payload: e.payload, evidence_refs: e.evidence_refs, correlation_id: e.correlation_id ?? null, schema_version: e.schema_version, supersedes_entry_id: e.supersedes_entry_id ?? null };
}

function mapError(err: unknown): never {
  if (err instanceof IngestionError || err instanceof ConnectionError || err instanceof DemoError || err instanceof SignedInputError) throw new HttpError(err.status, err.code, err.message);
  if (err instanceof ImportPlanError) throw validation(err.message);
  throw err;
}

export function registerSourceRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards): void {
  const connections = () => {
    if (!ctx.connections) guards.requireIngestionReady();
    return ctx.connections!;
  };

  app.get("/api/sources", { preHandler: [guards.requireRead] }, async (request) => {
    const tenantId = guards.tenantOf(request);
    const list = ctx.connections ? await ctx.connections.list(tenantId) : [];
    const readiness = await ctx.readiness.compute(tenantId);
    const providers = (ctx.connections?.knownProviders() ?? []).filter((p) => p.release_scope === "first_release");
    const catalogue = providers.map((p) => {
      const conns = list.filter((c) => c.provider === p.id);
      const caps = Object.values(readiness.dataset_sources).flat().filter((s) => s.provider === p.id);
      let state: string = IMPLEMENTED_PROVIDERS.has(p.id) ? "implemented" : CONNECTOR_PROVIDERS.has(p.id) ? "planned" : "unsupported";
      if (conns.length > 0) state = caps.some((c) => c.status === "degraded" || c.status === "unavailable") ? "degraded" : caps.some((c) => c.status === "working") ? "syncing" : "configured";
      return {
        provider: p.id,
        name: p.name,
        category: IMPLEMENTED_PROVIDERS.has(p.id) ? "producer" : "connector",
        state,
        capabilities: caps.map((c) => ({ id: c.capability_id, state: c.status, schedule: c.next_check_reason, last_successful_check_at: c.last_successful_check_at, last_new_event_at: c.last_new_event_at, next_check_at: c.next_check_at, next_check_reason: c.next_check_reason, coverage_from: c.coverage_from, coverage_to: c.coverage_to, coverage_state: c.coverage_state, limitations: c.limitations, connection_id: c.connection_id })),
        connections: conns,
      };
    });
    return { catalogue, readiness_observed_at: readiness.observed_at };
  });

  app.post("/api/sources/connections", { preHandler: [guards.requireOwner] }, async (request, reply) => {
    const body = connectionCreate.safeParse(request.body);
    if (!body.success) throw validation("provider and display_name are required", body.error.issues);
    try {
      const r = await connections().create(guards.tenantOf(request), body.data);
      ctx.logger.info("source.connection_created", "Connection created", { tenant_id: guards.tenantOf(request), connection_id: r.connection.connection_id });
      return reply.code(201).send({ connection: r.connection, ...(r.producer ? { producer: { producer_id: r.producer.producer_id, secret: r.producer.secret, notice: "Shown once; sign deliveries with HMAC-SHA256 over `${timestamp}.${body}`" } } : {}) });
    } catch (err) {
      mapError(err);
    }
  });

  app.get("/api/sources/connections/:id", { preHandler: [guards.requireRead] }, async (request) => {
    const tenantId = guards.tenantOf(request);
    const id = (request.params as { id: string }).id;
    const connection = ctx.connections ? await ctx.connections.get(tenantId, id) : null;
    if (!connection) throw notFound("connection");
    const [health, plan, runs, readiness] = await Promise.all([
      withTenant(ctx.pool, tenantId, (c) => ctx.connections!.healthFor(c, id)),
      ctx.importPlans.current(tenantId, id),
      ctx.connections!.listRuns(tenantId, id),
      ctx.readiness.compute(tenantId),
    ]);
    const proposal = await ctx.importPlans.proposal(tenantId);
    return { connection, health, import_plan: plan, import_plan_proposal: proposal, runs, readiness: readiness.questions.filter((q) => q.sources.some((s) => s.connection_id === id)) };
  });

  app.post("/api/sources/connections/:id/import-plan", { preHandler: [guards.requireOwner] }, async (request, reply) => {
    const body = importPlanBody.safeParse(request.body);
    if (!body.success) throw validation("preset, timezone and include_open_context are required", body.error.issues);
    const id = (request.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("connection");
    try {
      const plan = await ctx.importPlans.create(guards.tenantOf(request), id, guards.principalOf(request).id, body.data);
      return reply.code(201).send(plan);
    } catch (err) {
      if (err instanceof ImportPlanError && err.message === "connection not found") throw notFound("connection");
      mapError(err);
    }
  });

  app.post("/api/sources/connections/:id/runs", { preHandler: [guards.requireOwner] }, async (request, reply) => {
    const body = runBody.safeParse(request.body);
    if (!body.success) throw validation("kind must be backfill|incremental|reconcile|check");
    const id = (request.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("connection");
    const tenantId = guards.tenantOf(request);
    try {
      const plan = await ctx.importPlans.current(tenantId, id);
      // Polled connectors: queued rows per poll group executed by the worker (one check run for `check`).
      const runs = await connections().queueRuns(tenantId, id, body.data.kind, plan?.plan_id ?? null);
      for (const run of runs) ctx.logger.info("import.run_queued", "Import run queued for the worker", { tenant_id: tenantId, connection_id: id, run_id: run.run_id, action_code: body.data.kind, operation_id: run.poll_group ?? undefined });
      const primary = runs[0]!;
      return reply.code(201).send({ ...primary, runs });
    } catch (err) {
      mapError(err);
    }
  });

  for (const action of ["pause", "resume", "disconnect"] as const) {
    app.post(`/api/sources/connections/:id/${action}`, { preHandler: [guards.requireOwner] }, async (request) => {
      const id = (request.params as { id: string }).id;
      const r = await connections().setStatus(guards.tenantOf(request), id, action);
      if (!r) throw notFound("connection");
      ctx.logger.info(`source.connection_${action}`, `Connection ${action} requested`, { tenant_id: guards.tenantOf(request), connection_id: id });
      return r;
    });
  }

  app.get("/api/sources/connections/:id/runs/:run_id", { preHandler: [guards.requireRead] }, async (request) => {
    const { id, run_id } = request.params as { id: string; run_id: string };
    const run = ctx.connections ? await ctx.connections.getRun(guards.tenantOf(request), id, run_id) : null;
    if (!run) throw notFound("run");
    return run;
  });

  app.get("/api/sources/readiness", { preHandler: [guards.requireRead] }, async (request) => {
    const r = await ctx.readiness.compute(guards.tenantOf(request));
    return { observed_at: r.observed_at, datasets_present: r.datasets_present, datasets_missing: r.datasets_missing, questions: r.questions };
  });

  // ----- ingestion producers -----
  app.post("/api/ingest/replay", { preHandler: [guards.requireOwner] }, async (request) => {
    guards.requireIngestionReady();
    await guards.requireStorageCapacity(request);
    const body = replayBody.safeParse(request.body);
    if (!body.success) throw validation("connection_id and events[] are required", body.error.issues);
    try {
      const r = await ctx.ingestion!.ingest({ tenantId: guards.tenantOf(request), connectionId: body.data.connection_id, producer: "replay", runId: body.data.run_id ?? null, runKind: body.data.run_id ? "backfill" : null, observations: body.data.events.map(toObservation), traceId: request.traceId });
      return { accepted: r.accepted, duplicate: r.duplicate, conflict: r.conflict, rejected: r.rejected, committed_cursor: r.committed_cursor, outcomes: r.outcomes };
    } catch (err) {
      mapError(err);
    }
  });

  app.post("/api/ingest/generic", async (request) => {
    guards.checkHost(request);
    guards.requireIngestionReady();
    const producerId = request.headers["x-producer-id"];
    const timestamp = request.headers["x-producer-timestamp"];
    const signature = request.headers["x-producer-signature"];
    if (typeof producerId !== "string" || typeof timestamp !== "string" || typeof signature !== "string") throw new HttpError(401, "signature_required", "X-Producer-Id, X-Producer-Timestamp and X-Producer-Signature headers are required");
    let verified;
    try {
      verified = await ctx.signed!.verify({ producerId, timestamp, signature, rawBody: request.rawBody });
    } catch (err) {
      if (err instanceof SignedInputError) {
        ctx.logger.warn("ingest.signature_rejected", "Signed input rejected", { error_code: err.code, trace_id: request.traceId });
        throw new HttpError(err.status, err.code, err.message);
      }
      throw err;
    }
    const body = genericBody.safeParse(request.body);
    if (!body.success) throw validation("connection_id and records[] are required", body.error.issues);
    // The producer is bound to exactly one connection; the body cannot redirect it (INGEST-01).
    if (body.data.connection_id !== verified.connection_id) throw new HttpError(403, "connection_mismatch", "producer is not bound to this connection");
    await guards.requireStorageCapacity(request, verified.tenant_id); // the producer's workspace thresholds, after verification
    try {
      const r = await ctx.ingestion!.ingest({ tenantId: verified.tenant_id, connectionId: verified.connection_id, producer: "generic", observations: body.data.records.map(toObservation), traceId: request.traceId });
      return { accepted: r.accepted, duplicate: r.duplicate, conflict: r.conflict, rejected: r.rejected, committed_cursor: r.committed_cursor, outcomes: r.outcomes };
    } catch (err) {
      mapError(err);
    }
  });

  app.post("/api/ingest/bank-csv", { preHandler: [guards.requireOwner] }, async (request) => {
    guards.requireIngestionReady();
    await guards.requireStorageCapacity(request);
    const body = bankBody.safeParse(request.body);
    if (!body.success) throw validation("connection_id and csv are required", body.error.issues);
    const tenantId = guards.tenantOf(request);
    const preview = (request.query as { preview?: string }).preview === "1";
    const conn = await connections().get(tenantId, body.data.connection_id);
    if (!conn) throw notFound("connection");
    if (conn.provider !== "bank_csv") throw validation("connection provider must be bank_csv");
    const parsed = await ctx.bankCsv.preview(tenantId, body.data.csv);
    const rows = parsed.parsed.map((p) => ({ line: p.row.line, date: p.row.date, amount_minor: p.row.amount_minor, currency: p.row.currency, reference: p.row.reference, kind: p.observation.kind, bank_entry: p.observation.entity.bank_entry, match: p.match }));
    if (preview) return { rows: parsed.rows, parsed: rows, ambiguous: parsed.ambiguous, errors: parsed.errors };
    if (parsed.parsed.length === 0) throw validation("no valid rows to import", parsed.errors);
    try {
      const observations = parsed.parsed.flatMap((p) => (p.match_observation ? [p.observation, p.match_observation] : [p.observation]));
      const r = await ctx.ingestion!.ingest({ tenantId, connectionId: conn.connection_id, producer: "bank_csv", observations, traceId: request.traceId });
      if (parsed.ambiguous > 0) {
        await withTenant(ctx.pool, tenantId, async (c) => {
          for (const p of parsed.parsed) {
            if (p.match.status !== "ambiguous") continue;
            await c.query(
              `INSERT INTO review_cases (tenant_id, connection_id, type, state, reason, refs, history) VALUES ($1,$2,'ambiguous_bank_match','open',$3,$4,$5)
               ON CONFLICT (tenant_id, type, (refs->>'identity')) WHERE state <> 'resolved' AND refs ? 'identity' DO NOTHING`,
              [tenantId, conn.connection_id, `Bank credit matches ${p.match.candidates.length} payouts; confirm the link`, JSON.stringify({ identity: p.observation.provider_event_id, bank_entry: p.observation.entity.bank_entry, candidates: p.match.candidates }), JSON.stringify([{ at: new Date().toISOString(), actor: "system", action: "ambiguous_match_detected" }])],
            );
          }
        });
      }
      return { rows: parsed.rows, accepted: r.accepted, duplicate: r.duplicate, conflict: r.conflict, rejected: r.rejected, ambiguous: parsed.ambiguous, errors: parsed.errors, committed_cursor: r.committed_cursor };
    } catch (err) {
      mapError(err);
    }
  });

  app.post("/api/ingest/policy", { preHandler: [guards.requireOwner] }, async (request) => {
    guards.requireIngestionReady();
    await guards.requireStorageCapacity(request);
    const body = policyBody.safeParse(request.body);
    if (!body.success) throw validation("connection_id and policy {version, rules[]} are required", body.error.issues);
    const tenantId = guards.tenantOf(request);
    const obs: Observation = {
      provider_event_id: `policy:v${body.data.policy.version}`,
      kind: "business.rule_recorded",
      occurred_at: new Date().toISOString(),
      entity: { rule: `policy-v${body.data.policy.version}` },
      payload: { rule: `policy-v${body.data.policy.version}`, version: body.data.policy.version, rules: body.data.policy.rules },
      evidence_refs: body.data.policy.version > 1 ? [`policy:v${body.data.policy.version - 1}`] : [],
    };
    try {
      const r = await ctx.ingestion!.ingest({ tenantId, connectionId: body.data.connection_id, producer: "policy", observations: [obs], traceId: request.traceId });
      return { accepted: r.accepted, duplicate: r.duplicate, conflict: r.conflict, rejected: r.rejected, committed_cursor: r.committed_cursor, outcomes: r.outcomes };
    } catch (err) {
      mapError(err);
    }
  });

  app.post("/api/demo/run", { preHandler: [guards.requireOwner] }, async (request) => {
    guards.requireIngestionReady();
    await guards.requireStorageCapacity(request);
    const body = demoBody.safeParse(request.body ?? {});
    if (!body.success) throw validation("confirm (boolean) and up_to (Gnn) are optional");
    const tenantId = guards.tenantOf(request);
    try {
      const r = await ctx.demo!.run(tenantId, { confirm: body.data?.confirm, upTo: body.data?.up_to });
      ctx.logger.info("demo.loaded", "Golden demo scenario loaded through the replay path", { tenant_id: tenantId, run_id: r.run_id, record_count: r.result.accepted, committed_cursor: r.result.committed_cursor ?? undefined });
      return { connections: r.connections, run_id: r.run_id, accepted: r.result.accepted, duplicate: r.result.duplicate, conflict: r.result.conflict, rejected: r.result.rejected, committed_cursor: r.result.committed_cursor, checkpoints: r.checkpoints };
    } catch (err) {
      mapError(err);
    }
  });
}
