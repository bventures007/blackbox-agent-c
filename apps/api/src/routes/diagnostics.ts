import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { withTenant } from "@blackbox/database";
import { DEBUG_MAX_MINUTES, getLogRecord, queryLogs, type LogLevel, type LogRecord } from "@blackbox/logging";
import type { AppContext } from "../context.js";
import { HttpError, notFound, validation } from "../context.js";
import type { Guards } from "../guards.js";
import { buildDiagnosticsExport, EXPORT_CATEGORIES, healthCards } from "../diagnostics.js";
import { readStorage } from "./auth.js";

const levelEnum = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]);
const list = (s: string | undefined) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
const logsQuery = z
  .object({
    level_min: levelEnum.optional(),
    levels: z.string().max(40).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    component: z.string().max(200).optional(),
    provider: z.string().max(200).optional(),
    connection_id: z.string().max(400).optional(),
    run_id: z.string().max(400).optional(),
    trace_id: z.string().max(400).optional(),
    q: z.string().max(200).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();
const debugBody = z.object({ component: z.string().min(1).max(64), connection_id: z.string().uuid().optional(), run_id: z.string().uuid().optional(), minutes: z.number().int().min(1).max(DEBUG_MAX_MINUTES) }).strict();
const exportBody = z.object({ since: z.string().datetime({ offset: true }), until: z.string().datetime({ offset: true }), categories: z.array(z.enum(EXPORT_CATEGORIES)).min(1).optional() }).strict();

export function registerDiagnosticsRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards): void {
  /** Unauthenticated loopback liveness: status and version only, never tenant data. */
  app.get("/api/health", async (request) => {
    guards.checkHost(request);
    return { status: "ok", version: ctx.config.serviceVersion };
  });

  async function resolveFilter(request: FastifyRequest, tenantId: string) {
    const q = logsQuery.safeParse(request.query);
    if (!q.success) throw validation("invalid log filter", q.error.issues);
    const d = q.data;
    let connectionIds = list(d.connection_id);
    if (d.provider) {
      // provider → this workspace's connection ids (never another tenant's)
      const providers = list(d.provider) ?? [];
      const ids = await withTenant(ctx.pool, tenantId, async (c) => (await c.query<{ connection_id: string }>("SELECT connection_id FROM connections WHERE provider = ANY($1::text[])", [providers])).rows.map((r) => r.connection_id));
      connectionIds = connectionIds ? connectionIds.filter((id) => ids.includes(id)) : ids;
      if (connectionIds.length === 0) connectionIds = ["00000000-0000-0000-0000-000000000000"];
    }
    return { level_min: d.level_min, levels: list(d.levels) as LogLevel[] | undefined, since: d.since, until: d.until, component: list(d.component), connection_id: connectionIds, run_id: list(d.run_id), trace_id: list(d.trace_id), q: d.q, cursor: d.cursor ?? null, limit: d.limit, tenant_id: tenantId };
  }

  app.get("/api/diagnostics/health", { preHandler: [guards.requireOwner] }, async (request) => {
    const tenantId = guards.tenantOf(request);
    const cards = await healthCards({ pool: ctx.pool, engine: ctx.engine, tenantId, serviceVersion: ctx.config.serviceVersion, startedAt: ctx.startedAt, collector: ctx.collector.stats(), mcpLastRequestAt: ctx.runtime.mcpLastRequestAt, debugActive: ctx.debugGate.active().map((d) => ({ component: d.component, expires_at: d.expires_at })) });
    return { cards, observed_at: new Date().toISOString(), refresh_interval_seconds: 5, stale_after_seconds: 30 };
  });

  app.get("/api/diagnostics/logs", { preHandler: [guards.requireOwner] }, async (request) => {
    const tenantId = guards.tenantOf(request);
    const filter = await resolveFilter(request, tenantId);
    let r;
    try {
      r = queryLogs(ctx.config.logsDir, filter);
    } catch (err) {
      if (err instanceof RangeError) throw validation(err.message);
      throw err;
    }
    const stats = ctx.collector.stats();
    return { records: r.records, page: r.page, retained_from: r.retained_from, retained_to: r.retained_to, dropped_count: stats.dropped_count, state: stats.state, debug_active: ctx.debugGate.active().map((d) => ({ component: d.component, connection_id: d.connection_id ?? null, run_id: d.run_id ?? null, expires_at: d.expires_at })) };
  });

  app.get("/api/diagnostics/logs/stream", { preHandler: [guards.requireOwner] }, async (request, reply) => {
    const tenantId = guards.tenantOf(request);
    const filter = await resolveFilter(request, tenantId);
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ since: new Date().toISOString(), recheck_seconds: 5 })}\n\n`);
    const { matches, normalizeQuery } = await import("@blackbox/logging");
    const q = normalizeQuery({ ...filter, since: new Date().toISOString(), until: "9999-12-31T00:00:00.000Z" });
    const onRecord = (record: LogRecord) => {
      if (!matches(record, q)) return;
      reply.raw.write(`event: record\ndata: ${JSON.stringify(record)}\n\n`);
    };
    ctx.logger.events.on("record", onRecord);
    let closed = false;
    const close = (reason: string) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      ctx.logger.events.off("record", onRecord);
      try {
        reply.raw.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
        reply.raw.end();
      } catch {
        /* ignore */
      }
    };
    // Re-check authorization every ≤5 s; stop within 5 s of revocation (DIAG-06, LOCAL-02).
    const timer = setInterval(() => {
      guards
        .stillAuthorized(request)
        .then((ok) => {
          if (!ok) close("unauthorized");
          else reply.raw.write(`: keepalive\n\n`);
        })
        .catch(() => close("unauthorized"));
    }, 2500);
    request.raw.on("close", () => close("client_closed"));
    await new Promise<void>((resolve) => {
      request.raw.on("close", () => resolve());
      reply.raw.on("close", () => resolve());
    });
    return reply;
  });

  app.get("/api/diagnostics/logs/:record_id", { preHandler: [guards.requireOwner] }, async (request) => {
    const tenantId = guards.tenantOf(request);
    const id = (request.params as { record_id: string }).record_id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("record");
    const r = getLogRecord(ctx.config.logsDir, id);
    if (!r || (r.record.tenant_id && r.record.tenant_id !== tenantId)) throw notFound("record");
    return { record: r.record, siblings: r.siblings.filter((s) => !s.tenant_id || s.tenant_id === tenantId) };
  });

  app.post("/api/diagnostics/debug", { preHandler: [guards.requireOwner] }, async (request) => {
    const body = debugBody.safeParse(request.body);
    if (!body.success) throw validation(`component and minutes (1-${DEBUG_MAX_MINUTES}) are required`, body.error.issues);
    const tenantId = guards.tenantOf(request);
    const actor = guards.principalOf(request).id;
    const expires = new Date(Date.now() + body.data.minutes * 60_000);
    const row = await withTenant(ctx.pool, tenantId, async (c) => {
      await c.query("UPDATE debug_sessions SET stopped_at = now(), stop_reason = 'replaced' WHERE stopped_at IS NULL");
      const r = await c.query<{ debug_id: string }>("INSERT INTO debug_sessions (tenant_id, component, connection_id, run_id, expires_at, actor_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING debug_id", [tenantId, body.data.component, body.data.connection_id ?? null, body.data.run_id ?? null, expires, actor]);
      await ctx.auth.auditIn(c, tenantId, "debug.enabled", "owner", actor, "api", { component: body.data.component, minutes: body.data.minutes, scoped: Boolean(body.data.connection_id || body.data.run_id) });
      return r.rows[0]!;
    });
    ctx.debugGate.reset();
    ctx.debugGate.set({ debug_id: row.debug_id, tenant_id: tenantId, component: body.data.component, connection_id: body.data.connection_id ?? null, run_id: body.data.run_id ?? null, expires_at: expires.toISOString() });
    ctx.logger.info("diagnostics.debug_enabled", "Temporary DEBUG recording enabled", { tenant_id: tenantId, connection_id: body.data.connection_id, run_id: body.data.run_id, action_code: body.data.component, next_retry_at: expires.toISOString() });
    return { active: true, expires_at: expires.toISOString(), scope: { component: body.data.component, connection_id: body.data.connection_id ?? null, run_id: body.data.run_id ?? null } };
  });

  app.delete("/api/diagnostics/debug", { preHandler: [guards.requireOwner] }, async (request) => {
    const tenantId = guards.tenantOf(request);
    const actor = guards.principalOf(request).id;
    await withTenant(ctx.pool, tenantId, async (c) => {
      await c.query("UPDATE debug_sessions SET stopped_at = now(), stop_reason = 'owner_stopped' WHERE stopped_at IS NULL");
      await ctx.auth.auditIn(c, tenantId, "debug.stopped", "owner", actor, "api", {});
    });
    ctx.debugGate.reset();
    ctx.logger.info("diagnostics.debug_stopped", "DEBUG recording stopped", { tenant_id: tenantId });
    return { active: false, expires_at: null, scope: null };
  });

  app.get("/api/diagnostics/debug", { preHandler: [guards.requireOwner] }, async () => {
    const active = ctx.debugGate.active();
    const s = active[0];
    return { active: Boolean(s), expires_at: s?.expires_at ?? null, scope: s ? { component: s.component, connection_id: s.connection_id ?? null, run_id: s.run_id ?? null } : null };
  });

  app.post("/api/diagnostics/export", { preHandler: [guards.requireOwner] }, async (request, reply) => {
    const body = exportBody.safeParse(request.body);
    if (!body.success) throw validation("since and until (RFC3339) are required; categories optional", body.error.issues);
    const tenantId = guards.tenantOf(request);
    const preview = (request.query as { preview?: string }).preview === "1";
    let health = null;
    try {
      health = await healthCards({ pool: ctx.pool, engine: ctx.engine, tenantId, serviceVersion: ctx.config.serviceVersion, startedAt: ctx.startedAt, collector: ctx.collector.stats(), mcpLastRequestAt: ctx.runtime.mcpLastRequestAt, debugActive: [] });
    } catch {
      health = null;
    }
    const result = buildDiagnosticsExport({ logsDir: ctx.config.logsDir, since: body.data.since, until: body.data.until, categories: body.data.categories ?? [...EXPORT_CATEGORIES], tenantId, serviceVersion: ctx.config.serviceVersion, health });
    if (preview) return { preview: result.preview };
    await ctx.auth.audit(tenantId, "diagnostics.exported", "owner", guards.principalOf(request).id, "api", { size_bytes: result.preview.size_bytes, truncated: result.preview.truncated, categories: result.preview.categories });
    ctx.logger.info("diagnostics.exported", "Diagnostics bundle exported", { tenant_id: tenantId, record_count: result.preview.records });
    reply.header("content-type", "application/zip");
    reply.header("content-disposition", `attachment; filename="blackbox-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.zip"`);
    return reply.send(Buffer.from(result.zip));
  });

  app.get("/api/diagnostics/storage", { preHandler: [guards.requireOwner] }, async (request) => readStorage(ctx, guards.tenantOf(request)));

  // Agents must never reach diagnostics: explicit 403 (not 404) so the denial is observable.
  app.addHook("onRequest", async (request) => {
    if (request.url.startsWith("/api/diagnostics") && typeof request.headers.authorization === "string" && !request.cookies?.bb_session) {
      throw new HttpError(403, "forbidden", "diagnostics are owner-only; agent keys cannot read technical logs");
    }
  });
}
