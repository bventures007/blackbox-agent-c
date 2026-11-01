import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import type { Pool } from "@blackbox/database";
import { withTenant } from "@blackbox/database";
import { queryLogs, type CollectorStats, type LogRecord } from "@blackbox/logging";
import type { EngineClient, EngineHealth } from "@blackbox/application";

export type HealthState = "healthy" | "working" | "degraded" | "unavailable" | "unknown";

export interface HealthCard {
  area: "api" | "worker" | "postgres" | "engine" | "sources" | "mcp" | "diagnostics";
  state: HealthState;
  observed_at: string;
  reason: string;
  next_action: string | null;
  details: Record<string, unknown>;
}

/** Documented thresholds (SYSTEM-AND-DIAGNOSTICS.md): observations older than 30 s are stale. */
export const STALE_AFTER_MS = 30_000;
export const WORKER_HEARTBEAT_STALE_MS = 60_000;

export async function probePostgres(pool: Pool, timeoutMs = 2000): Promise<{ ok: boolean; latency_ms: number; writable: boolean | null; error?: string }> {
  const started = process.hrtime.bigint();
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), timeoutMs));
  try {
    const r = (await Promise.race([pool.query<{ recovery: boolean }>("SELECT pg_is_in_recovery() AS recovery"), timer])) as { rows: Array<{ recovery: boolean }> };
    return { ok: true, latency_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6), writable: !r.rows[0]?.recovery };
  } catch (err) {
    return { ok: false, latency_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6), writable: null, error: (err as Error).message.slice(0, 120) };
  }
}

export interface HealthInputs {
  pool: Pool;
  engine: EngineClient;
  tenantId: string | null;
  serviceVersion: string;
  startedAt: Date;
  collector: CollectorStats;
  mcpLastRequestAt: string | null;
  debugActive: Array<{ component: string; expires_at: string }>;
}

export async function healthCards(input: HealthInputs): Promise<HealthCard[]> {
  const now = new Date().toISOString();
  const cards: HealthCard[] = [];
  const pg = await probePostgres(input.pool);
  cards.push({
    area: "postgres",
    state: pg.ok ? (pg.writable ? "healthy" : "degraded") : "unavailable",
    observed_at: now,
    reason: pg.ok ? (pg.writable ? "connection, read and write readiness probes succeeded" : "database is read-only (in recovery)") : `probe failed: ${pg.error ?? "unknown"}`,
    next_action: pg.ok ? null : "check the postgres container with ./blackbox doctor and restart the runtime",
    details: { latency_ms: pg.latency_ms, writable: pg.writable },
  });
  cards.push({ area: "api", state: "healthy", observed_at: now, reason: "this response was served by the API", next_action: null, details: { version: input.serviceVersion, uptime_seconds: Math.floor((Date.now() - input.startedAt.getTime()) / 1000), last_probe_at: now } });

  // Worker: heartbeat row written by the worker (other agent) into import_runs/capability_health is optional here.
  let worker: HealthCard = { area: "worker", state: "unknown", observed_at: now, reason: "no worker heartbeat observed by this API build", next_action: "start the worker service; until then imports are producer-driven only", details: {} };
  let sources: HealthCard = { area: "sources", state: "unknown", observed_at: now, reason: "no workspace scope", next_action: null, details: {} };
  if (pg.ok && input.tenantId) {
    try {
      const s = await withTenant(input.pool, input.tenantId, async (c) => {
        const runs = await c.query<{ running: string; failed: string; oldest: Date | null; last_done: Date | null }>(
          "SELECT count(*) FILTER (WHERE state IN ('running','queued'))::text AS running, count(*) FILTER (WHERE state = 'failed')::text AS failed, min(started_at) FILTER (WHERE state IN ('running','queued')) AS oldest, max(finished_at) FILTER (WHERE state LIKE 'completed%') AS last_done FROM import_runs",
        );
        const caps = await c.query<{ status: string; n: string; last_ok: Date | null; last_new: Date | null; next_check: Date | null }>("SELECT status, count(*)::text AS n, max(last_successful_check_at) AS last_ok, max(last_new_event_at) AS last_new, min(next_check_at) AS next_check FROM capability_health GROUP BY status");
        return { runs: runs.rows[0]!, caps: caps.rows };
      });
      const running = Number(s.runs.running);
      const failed = Number(s.runs.failed);
      worker = {
        area: "worker",
        state: running > 0 ? "working" : failed > 0 ? "degraded" : "unknown",
        observed_at: now,
        reason: running > 0 ? `${running} import run(s) in progress` : failed > 0 ? `${failed} failed run(s) need attention` : "no worker heartbeat; no queued work",
        next_action: failed > 0 ? "open Sources → Needs review" : null,
        details: { running, failed, oldest_pending_started_at: s.runs.oldest?.toISOString() ?? null, last_completed_at: s.runs.last_done?.toISOString() ?? null },
      };
      const total = s.caps.reduce((a, r) => a + Number(r.n), 0);
      const bad = s.caps.filter((r) => r.status === "degraded" || r.status === "unavailable").reduce((a, r) => a + Number(r.n), 0);
      const lastOk = s.caps.map((r) => r.last_ok).filter(Boolean).sort().pop() as Date | undefined;
      const lastNew = s.caps.map((r) => r.last_new).filter(Boolean).sort().pop() as Date | undefined;
      sources = {
        area: "sources",
        state: total === 0 ? "unknown" : bad > 0 ? "degraded" : "healthy",
        observed_at: now,
        reason: total === 0 ? "no source capability has reported a check yet" : bad > 0 ? `${bad} of ${total} capabilities degraded/unavailable` : `${total} capabilities healthy (last successful check differs from last new event)`,
        next_action: bad > 0 ? "open Sources for the affected connection" : null,
        details: { capabilities: total, degraded: bad, last_successful_check_at: lastOk?.toISOString() ?? null, last_new_event_at: lastNew?.toISOString() ?? null },
      };
    } catch (err) {
      worker.details = { error: (err as Error).message.slice(0, 120) };
    }
  }
  cards.push(worker);

  let engineCard: HealthCard;
  try {
    const h: EngineHealth = await input.engine.health();
    const t = input.tenantId ? h.tenants[input.tenantId] : undefined;
    const lag = t ? t.lag_entries : null;
    engineCard = {
      area: "engine",
      state: h.stub ? "unavailable" : h.status === "healthy" ? (lag && lag > 0 ? "working" : "healthy") : h.status === "catching_up" || h.status === "rebuilding" ? "working" : "degraded",
      observed_at: h.heartbeat_at ?? now,
      reason: h.stub ? "engine stub active (ENGINE_URL=stub): no reducer, no state answers" : `engine ${h.status}; reducer_version ${h.reducer_version}${t ? `; applied ${t.applied_cursor} of committed ${t.committed_cursor}` : ""}`,
      next_action: h.stub ? "start the Rust engine service" : null,
      details: { reducer_version: h.reducer_version, phase: t?.phase ?? null, applied_cursor: t?.applied_cursor ?? null, committed_cursor: t?.committed_cursor ?? null, lag_entries: lag, rss_bytes: h.rss_bytes ?? null },
    };
  } catch (err) {
    engineCard = { area: "engine", state: "unavailable", observed_at: now, reason: `engine unreachable: ${(err as Error).message.slice(0, 100)}`, next_action: "check the engine container (./blackbox doctor)", details: {} };
  }
  cards.push(engineCard);
  cards.push(sources);
  cards.push({
    area: "mcp",
    state: input.mcpLastRequestAt ? "healthy" : "unknown",
    observed_at: now,
    reason: input.mcpLastRequestAt ? "an authorized agent request was served" : "no authorized agent request observed since start (a configured endpoint is not a connected client)",
    next_action: input.mcpLastRequestAt ? null : "connect a local MCP client with an agent key",
    details: { last_authorized_request_at: input.mcpLastRequestAt },
  });
  const c = input.collector;
  cards.push({
    area: "diagnostics",
    state: c.state === "unavailable" ? "unavailable" : c.state === "degraded" ? "degraded" : "healthy",
    observed_at: now,
    reason: c.state === "unavailable" ? `collector cannot write: ${c.last_error ?? "unknown"}` : c.dropped_count > 0 ? `${c.dropped_count} records dropped (bounded buffer/storage)` : "collector healthy",
    next_action: c.state === "healthy" ? null : "check free space on the logs volume",
    details: { retained_from: c.retained_from, retained_to: c.retained_to, bytes: c.bytes, cap_bytes: c.cap_bytes, retention_days: c.retention_days, dropped_count: c.dropped_count, buffered: c.buffered, debug_active: input.debugActive },
  });
  return cards;
}

export interface ExportRequest {
  logsDir: string;
  since: string;
  until: string;
  categories: string[];
  tenantId: string | null;
  serviceVersion: string;
  health: HealthCard[] | null;
  maxBytes?: number;
}

export interface ExportPreview {
  size_bytes: number;
  truncated: boolean;
  unavailable: string[];
  categories: string[];
  since: string;
  until: string;
  records: number;
}

export const EXPORT_MAX_BYTES = 10 * 1024 * 1024;
export const EXPORT_CATEGORIES = ["versions", "health", "errors", "logs"] as const;

/** Consistent per-bundle pseudonyms for ids (tenant/connection/run/trace/instance). */
class Pseudonymizer {
  private map = new Map<string, string>();
  private counters: Record<string, number> = {};
  constructor(private readonly salt: string) {}
  id(kind: string, value: string | undefined): string | undefined {
    if (!value) return undefined;
    const key = `${kind}:${value}`;
    let p = this.map.get(key);
    if (!p) {
      this.counters[kind] = (this.counters[kind] ?? 0) + 1;
      p = `${kind}-${this.counters[kind]}-${createHash("sha256").update(this.salt + key).digest("hex").slice(0, 6)}`;
      this.map.set(key, p);
    }
    return p;
  }
}

const EXPORT_ALLOWED_FIELDS = new Set(["schema_version", "record_id", "occurred_at", "level", "event_name", "message", "component", "service_version", "scope", "tenant_id", "connection_id", "capability_id", "run_id", "operation_id", "attempt", "trace_id", "span_id", "duration_ms", "record_count", "error_code", "retryable", "next_retry_at", "action_code", "committed_cursor", "applied_cursor", "truncated", "termination", "instance_id", "journal_batch_id"]);

export function buildDiagnosticsExport(req: ExportRequest): { zip: Uint8Array; preview: ExportPreview } {
  const max = req.maxBytes ?? EXPORT_MAX_BYTES;
  const pseudo = new Pseudonymizer(createHash("sha256").update(`${req.since}|${req.until}|${Date.now()}`).digest("hex"));
  const files: Record<string, Uint8Array> = {};
  const unavailable: string[] = [];
  const categories = req.categories.filter((c) => (EXPORT_CATEGORIES as readonly string[]).includes(c));
  if (categories.includes("versions")) {
    files["versions.json"] = strToU8(JSON.stringify({ service_version: req.serviceVersion, node: process.version, os: `${os.platform()} ${os.release()} ${os.arch()}`, log_schema_version: 1, exported_at: new Date().toISOString() }, null, 2));
  }
  if (categories.includes("health")) {
    if (req.health) files["health.json"] = strToU8(JSON.stringify(req.health.map((h) => ({ ...h, details: sanitizeDetails(h.details) })), null, 2));
    else unavailable.push("health: runtime probes unavailable (API/database down)");
  }
  let records = 0;
  let truncated = false;
  if (categories.includes("logs") || categories.includes("errors")) {
    let budget = max - 64 * 1024;
    const lines: string[] = [];
    const errorCounts: Record<string, number> = {};
    try {
      let cursor: string | null = null;
      outer: for (let page = 0; page < 200; page += 1) {
        const r = queryLogs(req.logsDir, { since: req.since, until: req.until, level_min: categories.includes("logs") ? "DEBUG" : "WARN", limit: 1000, cursor, tenant_id: req.tenantId ?? undefined });
        for (const rec of r.records) {
          if (rec.level === "WARN" || rec.level === "ERROR") {
            const key = `${rec.component}|${rec.event_name}|${rec.error_code ?? ""}`;
            errorCounts[key] = (errorCounts[key] ?? 0) + 1;
          }
          if (categories.includes("logs")) {
            const line = JSON.stringify(sanitizeExportRecord(rec, pseudo));
            if (budget - line.length - 1 < 0) {
              truncated = true;
              break outer;
            }
            budget -= line.length + 1;
            lines.push(line);
            records += 1;
          }
        }
        cursor = r.page.next_cursor;
        if (!cursor) break;
      }
    } catch (err) {
      unavailable.push(`logs: ${(err as Error).message.slice(0, 80)}`);
    }
    if (categories.includes("errors")) files["error-counts.json"] = strToU8(JSON.stringify(errorCounts, null, 2));
    if (categories.includes("logs")) files["logs-excerpt.jsonl"] = strToU8(lines.join("\n") + (lines.length ? "\n" : ""));
  }
  files["README.txt"] = strToU8(
    [
      "Blackbox diagnostics export (local, explicit).",
      `Range: ${req.since} .. ${req.until}`,
      `Categories: ${categories.join(", ")}`,
      `Truncated: ${truncated}`,
      unavailable.length ? `Unavailable: ${unavailable.join("; ")}` : "Unavailable: none",
      "Identifiers are pseudonymized consistently within this bundle; no credentials, business content, evidence or personal paths are included.",
      "",
    ].join("\n"),
  );
  const zip = zipSync(files, { level: 6 });
  return { zip, preview: { size_bytes: zip.byteLength, truncated, unavailable, categories, since: req.since, until: req.until, records } };
}

function sanitizeExportRecord(rec: LogRecord, pseudo: Pseudonymizer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!EXPORT_ALLOWED_FIELDS.has(k)) continue;
    if (k === "tenant_id" || k === "connection_id" || k === "run_id" || k === "trace_id" || k === "span_id" || k === "instance_id" || k === "operation_id" || k === "journal_batch_id") {
      out[k] = pseudo.id(k.replace("_id", ""), typeof v === "string" ? v : undefined);
    } else if (typeof v === "string") out[k] = v.slice(0, 512);
    else out[k] = v;
  }
  return out;
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === "string") out[k] = v.replace(/\/(?:Users|home)\/[^\s/]+/g, "[path]").slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
  }
  return out;
}

export interface DoctorCheck {
  id: string;
  state: "ok" | "degraded" | "failure" | "unavailable";
  message: string;
  next_action: string | null;
}

/** Host-side checks that do not need the database (doctor exit codes: 0 ok, 1 degraded, 2 failure). */
export function doctorFileChecks(input: { logsDir: string; evidenceDir: string; secretsDir: string; snapshotDir: string }): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ id: "node_version", state: nodeMajor >= 22 ? "ok" : "failure", message: `node ${process.versions.node}`, next_action: nodeMajor >= 22 ? null : "install Node 22 LTS or newer" });
  for (const [id, dir, needWrite] of [
    ["logs_dir", input.logsDir, true],
    ["evidence_dir", input.evidenceDir, true],
    ["snapshot_dir", input.snapshotDir, false],
    ["secrets_dir", input.secretsDir, false],
  ] as const) {
    if (!existsSync(dir)) {
      checks.push({ id, state: needWrite ? "failure" : "degraded", message: `${id} does not exist`, next_action: "run ./blackbox setup or check the volume mount" });
      continue;
    }
    try {
      accessSync(dir, needWrite ? fsConstants.R_OK | fsConstants.W_OK : fsConstants.R_OK);
      checks.push({ id, state: "ok", message: `${id} accessible`, next_action: null });
    } catch {
      checks.push({ id, state: "failure", message: `${id} not ${needWrite ? "writable" : "readable"}`, next_action: "fix permissions on the host directory" });
    }
  }
  const keyFile = path.join(input.secretsDir, "data.key");
  if (existsSync(keyFile)) {
    const mode = statSync(keyFile).mode & 0o777;
    checks.push({ id: "data_key", state: (mode & 0o077) === 0 ? "ok" : "degraded", message: `data.key present (mode ${mode.toString(8)})`, next_action: (mode & 0o077) === 0 ? null : "chmod 600 the data key" });
  } else {
    checks.push({ id: "data_key", state: "degraded", message: "data.key missing: ingestion and provider secrets unavailable", next_action: "run ./blackbox setup on a fresh installation or restore secrets from backup" });
  }
  const logs = (() => {
    try {
      return queryLogs(input.logsDir, { level_min: "ERROR", limit: 1, since: new Date(Date.now() - 3600_000).toISOString() });
    } catch {
      return null;
    }
  })();
  checks.push({ id: "retained_logs", state: logs ? "ok" : "degraded", message: logs ? `retained ${logs.retained_from ?? "none"} .. ${logs.retained_to ?? "none"}; errors in last hour: ${logs.records.length > 0 ? "yes" : "no"}` : "log files unreadable", next_action: logs ? null : "check the logs volume" });
  return checks;
}

export function doctorExitCode(checks: DoctorCheck[]): 0 | 1 | 2 {
  if (checks.some((c) => c.state === "failure")) return 2;
  if (checks.some((c) => c.state === "degraded" || c.state === "unavailable")) return 1;
  return 0;
}
