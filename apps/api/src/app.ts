import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { createPool, withInstallation, type Pool } from "@blackbox/database";
import { AuthService, DataKeyError, loadDataKey, type DataKey } from "@blackbox/auth";
import { createLogger, DebugGate, FileCollector, type Logger } from "@blackbox/logging";
import { BankCsvService, ConnectionService, createEngineClient, DemoService, EvidenceStore, ImportPlanService, IngestionService, JournalService, QuestionService, ReadinessService, ReviewService, SignedInputService } from "@blackbox/application";
import type { ApiConfig } from "./config.js";
import { HttpError, type AppContext } from "./context.js";
import { createGuards } from "./guards.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerJournalRoutes } from "./routes/journal.js";
import { registerDiagnosticsRoutes } from "./routes/diagnostics.js";

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  close(): Promise<void>;
}

export interface BuildOptions {
  config: ApiConfig;
  /** Reuse an existing pool/logger (tests); otherwise created from config. */
  pool?: Pool;
  logger?: Logger;
  collector?: FileCollector;
  logStream?: NodeJS.WritableStream;
}

/** Creates the shared services (also used by the CLI without an HTTP listener). */
export function createContext(options: BuildOptions): AppContext {
  const { config } = options;
  const debugGate = options.logger?.debugGate ?? new DebugGate();
  debugGate.reset(); // startup always returns to INFO
  const collector = options.collector ?? new FileCollector({ dir: config.logsDir, capBytes: config.logCapBytes, retentionDays: config.logRetentionDays });
  const logger = options.logger ?? createLogger({ component: "api", serviceVersion: config.serviceVersion, instanceId: config.instanceId, level: config.logLevel, sinks: [collector], debugGate, stream: options.logStream });
  const pool = options.pool ?? createPool(config.databaseUrl, { applicationName: "blackbox-api" });
  const auth = new AuthService({ pool, logger, secretsDir: config.secretsDir });
  const evidence = new EvidenceStore(config.evidenceDir);
  const journal = new JournalService(pool);
  const readiness = new ReadinessService(pool);
  const importPlans = new ImportPlanService(pool);
  const engine = createEngineClient({ url: config.engineUrl, token: config.engineToken, tokenFile: config.engineTokenFile, logger, journal });
  const questions = new QuestionService(engine, readiness, logger.child({}, "query"));
  const bankCsv = new BankCsvService(pool);
  const review = new ReviewService(pool, logger);
  let dataKey: DataKey | null = null;
  let dataKeyError: AppContext["dataKeyError"] = null;
  try {
    dataKey = loadDataKey(config.secretsDir);
  } catch (err) {
    if (err instanceof DataKeyError) {
      dataKeyError = { code: err.code, message: err.message, action: err.action };
      logger.error("secrets.data_key_unavailable", "Installation data key unavailable: ingestion and provider secrets are disabled", { error_code: err.code, action_code: "restore_or_setup", retryable: false });
    } else throw err;
  }
  const ingestion = dataKey ? new IngestionService({ pool, logger, evidence, dataKey }) : null;
  const signed = dataKey ? new SignedInputService(pool, dataKey) : null;
  const connections = dataKey ? new ConnectionService(pool, dataKey) : null;
  const demo = ingestion && connections ? new DemoService(pool, ingestion, connections) : null;
  return { config, pool, logger, collector, debugGate, auth, dataKey, dataKeyError, evidence, ingestion, journal, readiness, importPlans, engine, questions, bankCsv, signed, review, connections, demo, startedAt: new Date(), runtime: { mcpLastRequestAt: null, lastDbProbe: null } };
}

export async function buildApp(options: BuildOptions): Promise<BuiltApp> {
  const ctx = createContext(options);
  const { config, logger } = ctx;
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 6 * 1024 * 1024 });

  // JSON parser that preserves the raw body for HMAC verification of signed producer input.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    request.rawBody = typeof body === "string" ? body : body.toString("utf8");
    if (request.rawBody.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(request.rawBody));
    } catch {
      done(new HttpError(400, "invalid_json", "request body is not valid JSON"), undefined);
    }
  });
  await app.register(fastifyCookie);
  app.decorateRequest("auth", null);
  app.decorateRequest("rawBody", "");
  app.decorateRequest("traceId", "");
  app.addHook("onRequest", async (request, reply) => {
    request.auth = null;
    request.traceId = randomUUID();
    reply.header("x-trace-id", request.traceId);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    if (request.url.startsWith("/api/")) reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  });

  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof HttpError) {
      if (err.status === 401 || err.status === 403) logger.warn("auth.access_denied", "Request denied", { error_code: err.code, trace_id: request.traceId, action_code: request.method });
      if (err.retryAfterSeconds) reply.header("retry-after", String(err.retryAfterSeconds));
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, retryable: err.retryable, ...(err.details !== undefined ? { details: err.details } : {}) } });
    }
    const fe = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
    if (typeof fe.statusCode === "number" && fe.statusCode < 500) {
      const code = fe.statusCode === 413 ? "too_large" : fe.statusCode === 415 ? "unsupported_media_type" : fe.statusCode === 400 ? "bad_request" : "request_error";
      return reply.code(fe.statusCode).send({ error: { code, message: fe.message ?? "request error", retryable: false } });
    }
    const e = err as Error;
    logger.error("api.request_failed", `Unhandled request failure: ${e?.name ?? "Error"}: ${String(e?.message ?? "").slice(0, 200)}`, { error_code: "internal", trace_id: request.traceId, retryable: false, action_code: request.routeOptions?.url ?? undefined });
    return reply.code(500).send({ error: { code: "internal", message: "internal error", retryable: false, trace_id: request.traceId } });
  });

  const guards = createGuards(ctx);
  registerAuthRoutes(app, ctx, guards);
  registerSourceRoutes(app, ctx, guards);
  registerJournalRoutes(app, ctx, guards);
  registerDiagnosticsRoutes(app, ctx, guards);

  // Static: built web UI at / (SPA fallback) and landing at /landing when the builds exist.
  const webIndex = path.join(config.webDist, "index.html");
  if (existsSync(webIndex)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: "/", wildcard: false, index: false, decorateReply: true });
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/landing")) throw new HttpError(404, "not_found", "route not found");
      const rel = request.url.split("?")[0]!.replace(/^\/+/, "");
      if (rel && existsSync(path.join(config.webDist, rel))) return reply.sendFile(rel);
      return reply.sendFile("index.html");
    });
  }
  const landingIndex = path.join(config.landingDist, "index.html");
  if (existsSync(landingIndex)) {
    await app.register(fastifyStatic, { root: config.landingDist, prefix: "/landing/", wildcard: true, index: ["index.html"], decorateReply: !existsSync(webIndex) });
    app.get("/landing", async (_request, reply) => reply.redirect("/landing/", 302));
  }
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: { code: "not_found", message: "route not found", retryable: false } }));

  // Reset any persisted debug sessions at startup (DIAG-05) — best effort when the DB is up.
  try {
    await withInstallation(ctx.pool, (c) => c.query("SELECT 1"));
    ctx.runtime.lastDbProbe = { at: new Date().toISOString(), ok: true };
  } catch (err) {
    ctx.runtime.lastDbProbe = { at: new Date().toISOString(), ok: false, error: (err as Error).message };
    logger.error("api.database_unavailable", "PostgreSQL is not reachable at startup; requests will fail until it recovers", { error_code: "database_unavailable", retryable: true });
  }

  const close = async () => {
    await app.close();
    ctx.collector.close();
    if (!options.pool) await ctx.pool.end().catch(() => {});
  };
  return { app, ctx, close };
}

/** Starts listening on 127.0.0.1 only. */
export async function startServer(built: BuiltApp): Promise<string> {
  const { app, ctx } = built;
  const address = await app.listen({ host: ctx.config.host, port: ctx.config.port });
  ctx.logger.info("api.started", "API listening on the loopback interface", { action_code: "listening" });
  return address;
}
