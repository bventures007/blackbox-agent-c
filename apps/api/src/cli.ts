#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { bootstrapRoles, passwordsFromEnv, pendingMigrations, runMigrations } from "@blackbox/database";
import { AuthError, ensureDataKey } from "@blackbox/auth";
import { createLogger, FileCollector, followLogs, queryLogs, type LogLevel, type LogRecord } from "@blackbox/logging";
import { createContext } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { buildDiagnosticsExport, doctorExitCode, doctorFileChecks, EXPORT_CATEGORIES, healthCards, probePostgres, type DoctorCheck } from "./diagnostics.js";

const HELP = `blackbox API CLI (node apps/api/dist/cli.js <command>)

Commands
  setup [--name <workspace>] [--locale en|de]   Create the single workspace/owner, show the personal key once (idempotent).
  rotate-key                                    Rotate the owner key (reads the current key from stdin, prints the new key once).
  reset-access                                  Host-only: new owner key, all sessions and agent keys revoked (needs SECRETS_DIR read access).
  create-agent-key --name <name> [--expires <RFC3339>]   Create a read-only agent key (printed once).
  migrate                                       Apply pending SQL migrations as bb_migrate (MIGRATE_DATABASE_URL).
  bootstrap                                     Create roles/database as the superuser (BB_SUPERUSER_URL + BB_*_PASSWORD env).
  logs [--follow] [--level <min>] [--since <1h|RFC3339>] [--until <RFC3339>] [--component a,b] [--connection <id>] [--run <id>] [--trace <id>] [--q <text>] [--format json|text] [--limit n]
  doctor [--format json|text]                   Prerequisite/port/storage/service checks. Exit 0 ok, 1 degraded, 2 failure.
  diagnostics export --since <1h|RFC3339> [--until <RFC3339>] --output <file> [--categories versions,health,errors,logs]

Environment: DATABASE_URL (bb_api), MIGRATE_DATABASE_URL (bb_migrate), SECRETS_DIR, EVIDENCE_DIR, LOGS_DIR, SNAPSHOT_DIR, ENGINE_URL, ENGINE_TOKEN|ENGINE_TOKEN_FILE, PORT, HOST=127.0.0.1.
Secrets are never accepted as command-line arguments. Keys are shown once on this terminal and never written to logs.
`;

function out(line: string): void {
  process.stdout.write(line + "\n");
}
function err(line: string): void {
  process.stderr.write(line + "\n");
}

function parseSince(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^(\d+)([smhd])$/.exec(raw);
  if (m) {
    const n = Number(m[1]);
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
    return new Date(Date.now() - n * unit).toISOString();
  }
  if (Number.isNaN(Date.parse(raw))) throw new Error(`invalid time '${raw}' (use 1h, 30m, 2d or RFC3339)`);
  return new Date(raw).toISOString();
}

function formatText(r: LogRecord): string {
  const scope = [r.component, r.tenant_id ? `ws:${r.tenant_id.slice(0, 8)}` : null, r.connection_id ? `conn:${r.connection_id.slice(0, 8)}` : null, r.run_id ? `run:${r.run_id.slice(0, 8)}` : null].filter(Boolean).join(" ");
  const extra = [r.error_code ? `error=${r.error_code}` : null, r.duration_ms !== undefined ? `${r.duration_ms}ms` : null, r.record_count !== undefined ? `n=${r.record_count}` : null, r.committed_cursor !== undefined ? `committed=${r.committed_cursor}` : null, r.applied_cursor !== undefined ? `applied=${r.applied_cursor}` : null].filter(Boolean).join(" ");
  return `${r.occurred_at} ${r.level.padEnd(5)} ${scope} ${r.event_name} — ${r.message}${extra ? ` (${extra})` : ""}`;
}

async function withContext<T>(fn: (ctx: ReturnType<typeof createContext>) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const ctx = createContext({ config });
  try {
    return await fn(ctx);
  } finally {
    ctx.collector.close();
    await ctx.pool.end().catch(() => {});
  }
}

function keyNotice(kind: "owner" | "agent", key: string): string {
  const en = kind === "owner" ? "Your personal access key (shown once). Save it in your password manager now. Possession grants administrator access to this workspace: do not share it with agents." : "Agent key (shown once). Provide it to the MCP bridge through BLACKBOX_AGENT_KEY or BLACKBOX_AGENT_KEY_FILE; it grants read-only business access.";
  const de = kind === "owner" ? "Ihr persönlicher Zugangsschlüssel (wird nur einmal angezeigt). Speichern Sie ihn jetzt in Ihrem Passwort-Manager. Wer den Schlüssel besitzt, hat Administratorzugriff auf diesen Arbeitsbereich: nicht an Agenten weitergeben." : "Agentenschlüssel (wird nur einmal angezeigt). Über BLACKBOX_AGENT_KEY oder BLACKBOX_AGENT_KEY_FILE an die MCP-Brücke übergeben; er gewährt nur Lesezugriff auf Geschäftsdaten.";
  return `\n${en}\n${de}\n\n    ${key}\n`;
}

async function cmdSetup(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { name: { type: "string" }, locale: { type: "string" }, json: { type: "boolean" } }, strict: true });
  const config = loadConfig();
  const dk = ensureDataKey(config.secretsDir);
  mkdirSync(config.evidenceDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.logsDir, { recursive: true });
  return withContext(async (ctx) => {
    ctx.logger.info("setup.started", "Setup started", { action_code: dk.created ? "data_key_created" : "data_key_present" });
    const locale = values.locale === "de" ? "de" : "en";
    const r = await ctx.auth.setup({ displayName: values.name ?? "My workspace", locale });
    if (r.status === "already_initialized") {
      ctx.logger.info("setup.already_initialized", "Setup already completed; nothing changed", { tenant_id: r.tenant_id });
      if (values.json) out(JSON.stringify({ status: "already_initialized", tenant_id: r.tenant_id }));
      else out(`Setup already completed for workspace ${r.tenant_id}. Existing owner key kept. Lost it? Use: reset-access (host only).\nEinrichtung bereits abgeschlossen. Bestehender Schlüssel bleibt gültig. Verloren? reset-access (nur auf dem Host).`);
      return 0;
    }
    ctx.logger.info("setup.completed", "Workspace and owner created", { tenant_id: r.tenant_id });
    if (values.json) out(JSON.stringify({ status: "created", tenant_id: r.tenant_id, principal_id: r.principal_id, key: r.key }));
    else out(keyNotice("owner", r.key) + `\nWorkspace: ${r.tenant_id}\nOpen http://127.0.0.1:${config.port}/ and sign in with the key.`);
    return 0;
  });
}

async function readSecretFromStdin(prompt: string): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write(prompt);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function cmdRotateKey(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } }, strict: true });
  const current = await readSecretFromStdin("Enter the current owner key (input is read from stdin): ");
  return withContext(async (ctx) => {
    const { withAuthenticator } = await import("@blackbox/database");
    const owner = await withAuthenticator(ctx.pool, async (c) => (await c.query<{ principal_id: string; tenant_id: string }>("SELECT principal_id, tenant_id FROM principals WHERE kind = 'owner' LIMIT 1")).rows[0] ?? null);
    if (!owner) {
      err("not initialized; run setup first");
      return 2;
    }
    try {
      const key = await ctx.auth.rotateOwnerKey(owner.tenant_id, owner.principal_id, current);
      if (values.json) out(JSON.stringify({ status: "rotated", key }));
      else out(keyNotice("owner", key) + "\nAll previous owner sessions are signed out.");
      return 0;
    } catch (e) {
      if (e instanceof AuthError) {
        err(`rotation rejected: ${e.message}`);
        return 2;
      }
      throw e;
    }
  });
}

async function cmdResetAccess(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" }, yes: { type: "boolean" } }, strict: true });
  if (!values.yes) {
    err("reset-access rotates the owner key and revokes ALL sessions and agent keys. Re-run with --yes to confirm.");
    return 1;
  }
  return withContext(async (ctx) => {
    try {
      const r = await ctx.auth.resetAccess();
      if (values.json) out(JSON.stringify({ status: "reset", tenant_id: r.tenant_id, key: r.key }));
      else out(keyNotice("owner", r.key) + "\nAll sessions and agent keys were revoked. Business data and source configuration are unchanged.");
      return 0;
    } catch (e) {
      if (e instanceof AuthError) {
        err(`reset refused: ${e.message}`);
        return 2;
      }
      throw e;
    }
  });
}

async function cmdCreateAgentKey(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { name: { type: "string" }, expires: { type: "string" }, json: { type: "boolean" } }, strict: true });
  if (!values.name) {
    err("--name is required");
    return 2;
  }
  return withContext(async (ctx) => {
    const { withAuthenticator } = await import("@blackbox/database");
    const owner = await withAuthenticator(ctx.pool, async (c) => (await c.query<{ principal_id: string; tenant_id: string }>("SELECT principal_id, tenant_id FROM principals WHERE kind = 'owner' LIMIT 1")).rows[0] ?? null);
    if (!owner) {
      err("not initialized; run setup first");
      return 2;
    }
    const r = await ctx.auth.createAgentKey(owner.tenant_id, owner.principal_id, { name: values.name!, expires_at: values.expires ?? null });
    if (values.json) out(JSON.stringify({ status: "created", credential_id: r.credential_id, key: r.key }));
    else out(keyNotice("agent", r.key) + `\ncredential_id: ${r.credential_id}`);
    return 0;
  });
}

async function cmdMigrate(): Promise<number> {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) {
    err("MIGRATE_DATABASE_URL (bb_migrate role) is required");
    return 2;
  }
  const r = await runMigrations(url, { log: (l) => err(`migrate: ${l}`) });
  out(JSON.stringify(r));
  return 0;
}

async function cmdBootstrap(): Promise<number> {
  const superuserUrl = process.env.BB_SUPERUSER_URL;
  if (!superuserUrl) {
    err("BB_SUPERUSER_URL is required");
    return 2;
  }
  const r = await bootstrapRoles({ superuserUrl, database: process.env.BB_DATABASE, passwords: passwordsFromEnv(), log: (l) => err(`bootstrap: ${l}`) });
  out(JSON.stringify(r));
  return 0;
}

async function cmdLogs(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { follow: { type: "boolean" }, level: { type: "string" }, since: { type: "string" }, until: { type: "string" }, component: { type: "string" }, connection: { type: "string" }, run: { type: "string" }, trace: { type: "string" }, q: { type: "string" }, format: { type: "string" }, limit: { type: "string" } },
    strict: true,
  });
  const logsDir = process.env.LOGS_DIR;
  if (!logsDir) {
    err("LOGS_DIR is required");
    return 2;
  }
  const level = (values.level ?? "info").toUpperCase();
  if (!["DEBUG", "INFO", "WARN", "ERROR"].includes(level)) {
    err("--level must be debug|info|warn|error");
    return 2;
  }
  const format = values.format ?? "text";
  if (format !== "json" && format !== "text") {
    err("--format must be json|text");
    return 2;
  }
  const query = { level_min: level as LogLevel, since: parseSince(values.since), until: parseSince(values.until), component: values.component?.split(","), connection_id: values.connection ? [values.connection] : undefined, run_id: values.run ? [values.run] : undefined, trace_id: values.trace ? [values.trace] : undefined, q: values.q, limit: values.limit ? Number(values.limit) : 200 };
  const print = (r: LogRecord) => out(format === "json" ? JSON.stringify(r) : formatText(r));
  const r = queryLogs(logsDir, query);
  for (const rec of [...r.records].reverse()) print(rec);
  if (r.page.truncated) err(`… more records available (retained ${r.retained_from ?? "none"} .. ${r.retained_to ?? "none"}); narrow the filter or raise --limit`);
  if (!values.follow) return 0;
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  await followLogs(logsDir, query, print, ac.signal);
  return 0;
}

async function cmdDoctor(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { format: { type: "string" } }, strict: true });
  const trace = (phase: string) => {
    if (process.env.BLACKBOX_DOCTOR_TRACE) err(`doctor: ${phase}`);
  };
  const checks: DoctorCheck[] = [];
  let config;
  try {
    config = loadConfig();
    checks.push({ id: "config", state: "ok", message: `config valid; API port 127.0.0.1:${config.port}`, next_action: null });
  } catch (e) {
    checks.push({ id: "config", state: "failure", message: (e as Error).message, next_action: "fix the environment variables" });
  }
  const dirs = { logsDir: process.env.LOGS_DIR ?? "", evidenceDir: process.env.EVIDENCE_DIR ?? "", secretsDir: process.env.SECRETS_DIR ?? "", snapshotDir: process.env.SNAPSHOT_DIR ?? path.join(process.env.EVIDENCE_DIR ?? ".", "..", "snapshots") };
  trace("file checks");
  checks.push(...doctorFileChecks(dirs));
  if (config) {
    const { createPool } = await import("@blackbox/database");
    const pool = createPool(config.databaseUrl, { max: 1, applicationName: "blackbox-doctor" });
    try {
      trace("postgres probe");
      const pg = await probePostgres(pool, 8000);
      trace(`postgres probe done: ${pg.ok ? "ok" : pg.error}`);
      checks.push({ id: "postgres", state: pg.ok ? "ok" : "unavailable", message: pg.ok ? `reachable in ${pg.latency_ms} ms` : `unreachable: ${pg.error}`, next_action: pg.ok ? null : "start the runtime (./blackbox start) and re-run doctor" });
      if (pg.ok && process.env.MIGRATE_DATABASE_URL) {
        try {
          const pending = await pendingMigrations(process.env.MIGRATE_DATABASE_URL);
          checks.push({ id: "migrations", state: pending.length === 0 ? "ok" : "degraded", message: pending.length === 0 ? "schema up to date" : `${pending.length} pending migration(s)`, next_action: pending.length === 0 ? null : "run migrate" });
        } catch (e) {
          checks.push({ id: "migrations", state: "degraded", message: `cannot check migrations: ${(e as Error).message.slice(0, 80)}`, next_action: null });
        }
      }
    } finally {
      trace("pool end");
      await Promise.race([pool.end(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
      trace("pool ended");
    }
    try {
      trace("api probe");
      const res = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(2000) });
      const body = (await res.json()) as { status?: string; version?: string };
      checks.push({ id: "api", state: res.ok ? "ok" : "degraded", message: res.ok ? `API ${body.version} responding` : `API responded ${res.status}`, next_action: null });
    } catch {
      checks.push({ id: "api", state: "unavailable", message: "API not responding on the loopback port (live checks unavailable)", next_action: "start the runtime; retained logs remain readable with `logs`" });
    }
    if (config.engineUrl !== "stub") {
      try {
        const res = await fetch(`${config.engineUrl}/health`, { headers: { "x-engine-token": config.engineToken ?? "" }, signal: AbortSignal.timeout(2000) });
        checks.push({ id: "engine", state: res.ok ? "ok" : "degraded", message: res.ok ? "engine responding" : `engine responded ${res.status}`, next_action: null });
      } catch {
        checks.push({ id: "engine", state: "unavailable", message: "engine not reachable from this host (expected outside Compose: engine is on the private network)", next_action: null });
      }
    } else {
      checks.push({ id: "engine", state: "degraded", message: "ENGINE_URL=stub: no reducer; state/question answers unavailable", next_action: "configure the Rust engine" });
    }
  }
  const code = doctorExitCode(checks);
  if (values.format === "json") out(JSON.stringify({ exit_code: code, checks }, null, 2));
  else {
    for (const c of checks) out(`${c.state.padEnd(11)} ${c.id.padEnd(16)} ${c.message}${c.next_action ? `  → ${c.next_action}` : ""}`);
    out(`overall: ${code === 0 ? "ok" : code === 1 ? "degraded" : "failure"} (exit ${code})`);
  }
  return code;
}

async function cmdDiagnosticsExport(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { since: { type: "string" }, until: { type: "string" }, output: { type: "string" }, categories: { type: "string" } }, strict: true });
  if (!values.output) {
    err("--output <file> is required");
    return 2;
  }
  const logsDir = process.env.LOGS_DIR;
  if (!logsDir) {
    err("LOGS_DIR is required");
    return 2;
  }
  const since = parseSince(values.since ?? "1h")!;
  const until = parseSince(values.until) ?? new Date().toISOString();
  const categories = values.categories ? values.categories.split(",") : [...EXPORT_CATEGORIES];
  let health = null;
  let serviceVersion = "unknown";
  try {
    const config = loadConfig();
    serviceVersion = config.serviceVersion;
    const { createPool } = await import("@blackbox/database");
    const pool = createPool(config.databaseUrl, { max: 1, applicationName: "blackbox-diagnostics" });
    try {
      const pg = await probePostgres(pool, 2000);
      if (pg.ok) {
        const ctx = createContext({ config, pool, collector: new FileCollector({ dir: logsDir }), logger: createLogger({ component: "cli", serviceVersion: config.serviceVersion, level: "ERROR" }) });
        health = await healthCards({ pool, engine: ctx.engine, tenantId: null, serviceVersion: config.serviceVersion, startedAt: new Date(), collector: ctx.collector.stats(), mcpLastRequestAt: null, debugActive: [] });
        ctx.collector.close();
      }
    } finally {
      await pool.end().catch(() => {});
    }
  } catch {
    health = null;
  }
  const result = buildDiagnosticsExport({ logsDir, since, until, categories, tenantId: null, serviceVersion, health });
  writeFileSync(values.output, Buffer.from(result.zip));
  out(JSON.stringify({ output: values.output, ...result.preview }));
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "setup":
      return cmdSetup(rest);
    case "rotate-key":
      return cmdRotateKey(rest);
    case "reset-access":
      return cmdResetAccess(rest);
    case "create-agent-key":
      return cmdCreateAgentKey(rest);
    case "migrate":
      return cmdMigrate();
    case "bootstrap":
      return cmdBootstrap();
    case "logs":
      return cmdLogs(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "diagnostics":
      if (rest[0] === "export") return cmdDiagnosticsExport(rest.slice(1));
      err("usage: diagnostics export --since 1h --output <file>");
      return 2;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      out(HELP);
      return command === undefined ? 2 : 0;
    default:
      err(`unknown command '${command}'\n`);
      out(HELP);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof ConfigError) err(`configuration error: ${e.message}`);
    else err(`error: ${(e as Error).message}`);
    process.exit(2);
  });
