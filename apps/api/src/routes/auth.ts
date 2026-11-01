import { originAllowed } from "@blackbox/auth";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AGENT_GRANT, AuthError, SESSION_COOKIE, clientThrottleKey, REMEMBERED_ABSOLUTE_MS } from "@blackbox/auth";
import { withTenant } from "@blackbox/database";
import type { AppContext } from "../context.js";
import { HttpError, notFound, validation } from "../context.js";
import type { Guards } from "../guards.js";

const loginSchema = z.object({ key: z.string().min(1).max(200), remember: z.boolean().optional().default(false) }).strict();
const rotateSchema = z.object({ current_key: z.string().min(1).max(200) }).strict();
const workspacePatch = z.object({ display_name: z.string().min(1).max(120).optional(), locale: z.enum(["en", "de"]).optional() }).strict();
const agentCreate = z.object({ name: z.string().min(1).max(120), expires_at: z.string().datetime({ offset: true }).optional().nullable() }).strict();
const retentionPatch = z.record(z.string().min(1).max(64), z.number().int().min(1).max(3650));
const storagePatch = z.object({ warn_percent: z.number().int().min(1).max(90).optional(), warn_min_bytes: z.number().int().positive().optional(), critical_percent: z.number().int().min(1).max(50).optional(), critical_min_bytes: z.number().int().positive().optional(), log_cap_bytes: z.number().int().min(1048576).max(104857600).optional(), log_retention_days: z.number().int().min(1).max(7).optional() }).strict();
const backupsPatch = z.object({ retention_daily: z.number().int().min(1).max(30).optional(), retention_weekly: z.number().int().min(0).max(12).optional() }).strict();

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards): void {
  app.post("/api/auth/login", async (request, reply) => {
    guards.checkHost(request);
    const body = loginSchema.safeParse(request.body);
    if (!body.success) throw validation("key (string) and optional remember (boolean) are required");
    // Origin check for the login form too (cross-origin forms cannot log the browser in).
    const origin = request.headers.origin;
    if (typeof origin === "string" && !originOk(origin, [ctx.config.port, ctx.config.publicPort])) throw new HttpError(403, "forbidden", "Origin is not allowed");
    const clientKey = clientThrottleKey(request.ip, request.headers["user-agent"]);
    try {
      const { session_id, session } = await ctx.auth.login({ key: body.data.key, remember: body.data.remember, clientKey });
      reply.setCookie(SESSION_COOKIE, session_id, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: false, // loopback http profile; Secure is mandatory for any future HTTPS profile
        ...(session.remembered ? { maxAge: Math.floor(REMEMBERED_ABSOLUTE_MS / 1000) } : {}),
      });
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof AuthError) throw new HttpError(err.status, err.code, err.message, { retryable: err.code === "throttled", retryAfterSeconds: err.retryAfterSeconds });
      throw err;
    }
  });

  app.post("/api/auth/logout", { preHandler: [guards.requireOwner] }, async (request, reply) => {
    const a = request.auth!;
    if (a.kind === "owner") await ctx.auth.logout(a.session.session_hash, a.session.principal.tenant_id, a.session.principal.principal_id);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/auth/session", { preHandler: [guards.requireOwner] }, async (request) => {
    const a = request.auth!;
    if (a.kind !== "owner") throw new HttpError(403, "forbidden", "owner session required");
    const ws = await ctx.auth.getWorkspace(a.session.principal.tenant_id);
    return {
      principal: { id: a.session.principal.principal_id, kind: "owner" },
      workspace: ws ? { tenant_id: ws.tenant_id, display_name: ws.display_name, locale: ws.locale } : null,
      csrf_token: a.session.csrf_token,
      session: { expires_at: a.session.expires_at, remembered: a.session.remembered },
    };
  });

  app.post("/api/auth/rotate-key", { preHandler: [guards.requireOwner] }, async (request, reply) => {
    const body = rotateSchema.safeParse(request.body);
    if (!body.success) throw validation("current_key is required");
    const a = request.auth!;
    if (a.kind !== "owner") throw new HttpError(403, "forbidden", "owner session required");
    try {
      const newKey = await ctx.auth.rotateOwnerKey(a.session.principal.tenant_id, a.session.principal.principal_id, body.data.current_key);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return { new_key: newKey, notice: "Shown once. Save it in your password manager; all previous sessions are signed out." };
    } catch (err) {
      if (err instanceof AuthError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
  });

  app.get("/api/workspace", { preHandler: [guards.requireRead] }, async (request) => {
    const tenantId = guards.tenantOf(request);
    const ws = await ctx.auth.getWorkspace(tenantId);
    if (!ws) throw notFound("workspace");
    const unresolved = await ctx.review.unresolvedCount(tenantId);
    const backups = await readBackups(ctx, tenantId);
    return { ...ws, backups: { status: backups.status }, unresolved_review_count: unresolved };
  });

  app.patch("/api/workspace", { preHandler: [guards.requireOwner] }, async (request) => {
    const body = workspacePatch.safeParse(request.body);
    if (!body.success) throw validation("display_name (string) and/or locale (en|de)");
    const p = guards.principalOf(request);
    return ctx.auth.updateWorkspace(guards.tenantOf(request), p.id, body.data);
  });

  // ----- agents (owner only) -----
  app.get("/api/agents", { preHandler: [guards.requireOwner] }, async (request) => ctx.auth.listAgentKeys(guards.tenantOf(request)));

  app.post("/api/agents", { preHandler: [guards.requireOwner] }, async (request, reply) => {
    const body = agentCreate.safeParse(request.body);
    if (!body.success) throw validation("name is required; expires_at optional RFC3339");
    try {
      const r = await ctx.auth.createAgentKey(guards.tenantOf(request), guards.principalOf(request).id, { name: body.data.name, expires_at: body.data.expires_at ?? null });
      return reply.code(201).send({ credential_id: r.credential_id, key: r.key, grant: AGENT_GRANT, notice: "Shown once. Provide it to the MCP bridge through BLACKBOX_AGENT_KEY or a key file; never as a command argument." });
    } catch (err) {
      if (err instanceof AuthError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
  });

  app.post("/api/agents/:id/revoke", { preHandler: [guards.requireOwner] }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("agent key");
    const ok = await ctx.auth.revokeAgentKey(guards.tenantOf(request), guards.principalOf(request).id, id);
    if (!ok) throw notFound("agent key");
    return reply.code(204).send();
  });

  app.get("/api/agents/mcp-config", { preHandler: [guards.requireOwner] }, async () => ({
    transport: "stdio",
    command: "node",
    args: ["packages/mcp/dist/server.js"],
    env: { BLACKBOX_API_URL: `http://127.0.0.1:${ctx.config.publicPort}`, BLACKBOX_AGENT_KEY: "<paste the agent key here or use BLACKBOX_AGENT_KEY_FILE=/path/to/key-file>" },
    snippet: JSON.stringify({ mcpServers: { blackbox: { command: "node", args: ["packages/mcp/dist/server.js"], env: { BLACKBOX_API_URL: `http://127.0.0.1:${ctx.config.publicPort}`, BLACKBOX_AGENT_KEY_FILE: "/absolute/path/to/agent.key" } } } }, null, 2),
    notes: ["The key is read from the environment or a 0600 file, never from command-line arguments.", "Cloud-hosted clients cannot reach the loopback API; use a local MCP-capable client.", "The grant is read-only business access for this workspace; it cannot ingest, administer or read technical logs."],
  }));

  // ----- settings (owner only) -----
  app.get("/api/settings/backups", { preHandler: [guards.requireOwner] }, async (request) => readBackups(ctx, guards.tenantOf(request)));
  app.patch("/api/settings/backups", { preHandler: [guards.requireOwner] }, async (request) => {
    const body = backupsPatch.safeParse(request.body);
    if (!body.success) throw validation("retention_daily/retention_weekly integers");
    const tenantId = guards.tenantOf(request);
    await withTenant(ctx.pool, tenantId, (c) => c.query("UPDATE backup_status SET retention_daily = COALESCE($2, retention_daily), retention_weekly = COALESCE($3, retention_weekly), updated_at = now() WHERE tenant_id = $1", [tenantId, body.data.retention_daily ?? null, body.data.retention_weekly ?? null]));
    return readBackups(ctx, tenantId);
  });
  app.post("/api/settings/backups/run", { preHandler: [guards.requireOwner] }, async (request) => {
    const b = await readBackups(ctx, guards.tenantOf(request));
    if (b.status === "not_configured") throw new HttpError(409, "backup_not_configured", "No backup destination is enrolled. Enroll one through the host wrapper (./blackbox backup --enroll) first.");
    throw new HttpError(503, "backup_runner_unavailable", "Backup execution is performed by the host wrapper/worker; the API only reports status in this build.");
  });

  app.get("/api/settings/retention", { preHandler: [guards.requireOwner] }, async (request) => readRetention(ctx, guards.tenantOf(request)));
  app.patch("/api/settings/retention", { preHandler: [guards.requireOwner] }, async (request) => {
    const body = retentionPatch.safeParse(request.body);
    if (!body.success) throw validation("map of evidence_class → days (1-3650)");
    const tenantId = guards.tenantOf(request);
    await withTenant(ctx.pool, tenantId, async (c) => {
      for (const [cls, days] of Object.entries(body.data)) {
        await c.query("INSERT INTO retention_policies (tenant_id, evidence_class, days, source) VALUES ($1,$2,$3,'owner') ON CONFLICT (tenant_id, evidence_class) DO UPDATE SET days = $3, source = 'owner', updated_at = now()", [tenantId, cls, days]);
      }
      await ctx.auth.auditIn(c, tenantId, "retention.updated", "owner", guards.principalOf(request).id, "api", { classes: Object.keys(body.data) });
    });
    return readRetention(ctx, tenantId);
  });

  app.get("/api/settings/storage", { preHandler: [guards.requireOwner] }, async (request) => readStorage(ctx, guards.tenantOf(request)));
  app.patch("/api/settings/storage", { preHandler: [guards.requireOwner] }, async (request) => {
    const body = storagePatch.safeParse(request.body);
    if (!body.success) throw validation("storage threshold fields must be positive integers within bounds", body.error.issues);
    const tenantId = guards.tenantOf(request);
    const d = body.data;
    await withTenant(ctx.pool, tenantId, (c) =>
      c.query(
        "UPDATE storage_thresholds SET warn_percent = COALESCE($2, warn_percent), warn_min_bytes = COALESCE($3, warn_min_bytes), critical_percent = COALESCE($4, critical_percent), critical_min_bytes = COALESCE($5, critical_min_bytes), log_cap_bytes = COALESCE($6, log_cap_bytes), log_retention_days = COALESCE($7, log_retention_days), updated_at = now() WHERE tenant_id = $1",
        [tenantId, d.warn_percent ?? null, d.warn_min_bytes ?? null, d.critical_percent ?? null, d.critical_min_bytes ?? null, d.log_cap_bytes ?? null, d.log_retention_days ?? null],
      ),
    );
    return readStorage(ctx, tenantId);
  });

  app.get("/api/settings/security", { preHandler: [guards.requireOwner] }, async (request) => ctx.auth.securitySummary(guards.tenantOf(request)));
}

function originOk(origin: string, ports: number | readonly number[]): boolean {
  return originAllowed(origin, ports);
}

export async function readBackups(ctx: AppContext, tenantId: string): Promise<Record<string, unknown> & { status: string }> {
  return withTenant(ctx.pool, tenantId, async (c) => {
    const r = await c.query("SELECT * FROM backup_status WHERE tenant_id = $1", [tenantId]);
    const row = (r.rows[0] ?? { status: "not_configured" }) as Record<string, unknown>;
    const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v ?? null));
    const lastCutoff = row.last_cutoff instanceof Date ? row.last_cutoff : null;
    return {
      status: String(row.status ?? "not_configured"),
      destination_label: row.destination_label ?? null,
      last_attempt_at: ts(row.last_attempt_at),
      last_completed_at: ts(row.last_completed_at),
      last_cutoff: ts(row.last_cutoff),
      next_due_at: ts(row.next_due_at),
      recoverable_age_seconds: lastCutoff ? Math.floor((Date.now() - lastCutoff.getTime()) / 1000) : null,
      retention: { daily: Number(row.retention_daily ?? 7), weekly: Number(row.retention_weekly ?? 4) },
      same_device: row.same_device ?? null,
      last_restore_test_at: ts(row.last_restore_test_at),
      protection: row.status === "not_configured" ? "unprotected: no backup destination enrolled" : "scheduled",
    };
  });
}

async function readRetention(ctx: AppContext, tenantId: string): Promise<{ default_days: number; classes: Record<string, { days: number; source: string }> }> {
  return withTenant(ctx.pool, tenantId, async (c) => {
    const r = await c.query<{ evidence_class: string; days: number; source: string }>("SELECT evidence_class, days, source FROM retention_policies WHERE tenant_id = $1 ORDER BY evidence_class", [tenantId]);
    return { default_days: 90, classes: Object.fromEntries(r.rows.map((x) => [x.evidence_class, { days: Number(x.days), source: x.source }])) };
  });
}

export async function readStorage(ctx: AppContext, tenantId: string): Promise<Record<string, unknown>> {
  const { statfs } = await import("node:fs/promises");
  const thresholds = await withTenant(ctx.pool, tenantId, async (c) => (await c.query("SELECT * FROM storage_thresholds WHERE tenant_id = $1", [tenantId])).rows[0] as Record<string, unknown> | undefined);
  const volumes: Record<string, unknown> = {};
  for (const [name, dir] of [
    ["evidence", ctx.config.evidenceDir],
    ["logs", ctx.config.logsDir],
    ["snapshots", ctx.config.snapshotDir],
  ] as const) {
    try {
      const s = await statfs(dir);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      const warnAt = Math.max((Number(thresholds?.warn_percent ?? 10) / 100) * total, Number(thresholds?.warn_min_bytes ?? 5368709120));
      const critAt = Math.max((Number(thresholds?.critical_percent ?? 2) / 100) * total, Number(thresholds?.critical_min_bytes ?? 1073741824));
      volumes[name] = { total_bytes: total, free_bytes: free, state: free < critAt ? "critical" : free < warnAt ? "warning" : "ok" };
    } catch (err) {
      volumes[name] = { state: "unavailable", reason: (err as NodeJS.ErrnoException).code ?? "stat_failed" };
    }
  }
  const logs = ctx.collector.stats();
  return {
    thresholds: thresholds ? { warn_percent: Number(thresholds.warn_percent), warn_min_bytes: Number(thresholds.warn_min_bytes), critical_percent: Number(thresholds.critical_percent), critical_min_bytes: Number(thresholds.critical_min_bytes), log_cap_bytes: Number(thresholds.log_cap_bytes), log_retention_days: Number(thresholds.log_retention_days) } : null,
    volumes,
    evidence: ctx.evidence.usage(),
    logs: { bytes: logs.bytes, cap_bytes: logs.cap_bytes, retained_from: logs.retained_from, retained_to: logs.retained_to, files: logs.files, dropped_count: logs.dropped_count, state: logs.state },
  };
}
