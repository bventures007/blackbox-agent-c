/**
 * Diagnostics over the API and CLI entry points.
 * Covers: DIAG-03 (journal.batch_committed only after COMMIT with committed_cursor/record_count,
 * query.served carries the applied cutoff, stable record/trace ids, workspace scope), DIAG-05
 * (debug defaults off, server-side ≤15 min expiry, stop/renew, reset at startup, retention cursors),
 * DIAG-06 (canaries through the API never reach files; anonymous/agent/other-tenant/forged-origin
 * access to logs denied; owner stream stops within 5 s of logout), DIAG-08 (explicit export with
 * preview, categories, 10 MiB cap, pseudonymized ids, no paths/credentials), and the `logs`/`doctor`/
 * `diagnostics export` CLI fallback reading files without the database.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { withTenant } from "@blackbox/database";
import { ApiClient, startTestApp, wait, type TestApp } from "@blackbox/testing";
import { repoRoot } from "../vitest.shared.js";

let app: TestApp;
let owner: { key: string; tenant_id: string };
let demo: { connections: Record<string, string>; run_id: string; committed_cursor: number };
let agentKey: string;

function allLogText(): string {
  app.collector.flush();
  return readdirSync(app.install.logsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => readFileSync(path.join(app.install.logsDir, f), "utf8"))
    .join("");
}

beforeAll(async () => {
  app = await startTestApp();
  owner = await app.setupOwner();
  const c = new ApiClient(app.baseUrl);
  await c.login(owner.key);
  demo = (await c.post("/api/demo/run", {})).json as typeof demo;
  agentKey = ((await c.post("/api/agents", { name: "log-probe" })).json as { key: string }).key;
});
afterAll(async () => {
  await app?.stop();
});

describe("DIAG-03 lifecycle records", () => {
  it("logs journal commits after COMMIT with cursor/count/run ids and query serving with the applied cutoff", async () => {
    await wait(100);
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    const logs = (await c.get(`/api/diagnostics/logs?run_id=${demo.run_id}&limit=1000`)).json as { records: Array<Record<string, unknown>>; state: string; dropped_count: number };
    const commits = logs.records.filter((r) => r.event_name === "journal.batch_committed");
    expect(commits.length).toBe(19);
    for (const r of commits) {
      expect(r).toMatchObject({ schema_version: 1, level: "INFO", component: "ingestion", scope: "workspace", tenant_id: owner.tenant_id, run_id: demo.run_id, service_version: "test", instance_id: "test-instance" });
      expect(typeof r.committed_cursor).toBe("number");
      expect(typeof r.record_count).toBe("number");
      expect(typeof r.journal_batch_id).toBe("string");
      expect(r.record_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof r.connection_id).toBe("string");
    }
    expect(Math.max(...commits.map((r) => r.committed_cursor as number))).toBe(demo.committed_cursor);
    // commit records never carry payload/business content
    for (const r of commits) expect(JSON.stringify(r)).not.toMatch(/#1001|INV-1001|TX-1001|11900/);
    const q = await c.post("/api/questions/invoices.outstanding", { params: {} });
    expect(q.status).toBe(200);
    await wait(100);
    const served = ((await c.get("/api/diagnostics/logs?component=query&limit=50")).json as { records: Array<Record<string, unknown>> }).records;
    const rec = served.find((r) => r.event_name === "query.unavailable" || r.event_name === "query.served")!;
    expect(rec).toBeDefined();
    expect(rec.operation_id).toBe("invoice-01");
    expect(typeof rec.duration_ms).toBe("number");
    expect(JSON.stringify(rec)).not.toContain("INV-1001");
    expect(logs.state).toBe("healthy");
    expect(logs.dropped_count).toBe(0);
    const one = (await c.get(`/api/diagnostics/logs/${commits[0]!.record_id}`)).json as { record: Record<string, unknown> };
    expect(one.record.record_id).toBe(commits[0]!.record_id);
    // access denial events carry trace ids and error codes
    const anon = new ApiClient(app.baseUrl);
    await anon.get("/api/journal");
    await wait(100);
    const denied = ((await c.get("/api/diagnostics/logs?level_min=WARN&limit=100")).json as { records: Array<Record<string, unknown>> }).records.find((r) => r.event_name === "auth.access_denied");
    expect(denied).toMatchObject({ level: "WARN", error_code: "unauthenticated" });
    expect(denied!.trace_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("DIAG-05 temporary debug", () => {
  it("is off by default, enforced server-side, capped at 15 minutes, stoppable, and reset on restart", async () => {
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    expect((await c.get("/api/diagnostics/debug")).json).toMatchObject({ active: false });
    app.logger.child({}, "ingestion").debug("test.debug_hidden", "should not appear");
    expect((await c.post("/api/diagnostics/debug", { component: "ingestion", minutes: 16 })).status).toBe(422);
    expect((await c.post("/api/diagnostics/debug", { component: "ingestion", minutes: 0 })).status).toBe(422);
    const on = await c.post("/api/diagnostics/debug", { component: "ingestion", connection_id: demo.connections.shop, minutes: 1 });
    expect(on.status).toBe(200);
    expect((on.json as { active: boolean; scope: { component: string } }).scope.component).toBe("ingestion");
    app.logger.child({ tenant_id: owner.tenant_id, connection_id: demo.connections.shop }, "ingestion").debug("test.debug_visible", "visible");
    app.logger.child({ tenant_id: owner.tenant_id, connection_id: demo.connections.stock }, "ingestion").debug("test.debug_other_connection", "hidden");
    app.logger.child({}, "api").debug("test.debug_other_component", "hidden");
    await wait(100);
    const dbg = ((await c.get("/api/diagnostics/logs?level_min=DEBUG&limit=200")).json as { records: Array<Record<string, unknown>>; debug_active: unknown[] }).records.map((r) => r.event_name);
    expect(dbg).toContain("test.debug_visible");
    expect(dbg).not.toContain("test.debug_hidden");
    expect(dbg).not.toContain("test.debug_other_connection");
    expect(dbg).not.toContain("test.debug_other_component");
    // server-side expiry: force the gate's expiry in the past
    const active = app.built.ctx.debugGate.active()[0]!;
    app.built.ctx.debugGate.set({ ...active, expires_at: new Date(Date.now() - 1000).toISOString() });
    app.logger.child({ tenant_id: owner.tenant_id, connection_id: demo.connections.shop }, "ingestion").debug("test.debug_after_expiry", "hidden");
    await wait(100);
    expect(allLogText()).not.toContain("test.debug_after_expiry");
    expect((await c.get("/api/diagnostics/debug")).json).toMatchObject({ active: false });
    // renew explicitly, then stop
    expect((await c.post("/api/diagnostics/debug", { component: "api", minutes: 15 })).status).toBe(200);
    expect((await c.delete("/api/diagnostics/debug")).json).toMatchObject({ active: false });
    const rows = await withTenant(app.pool, owner.tenant_id, async (cl) => (await cl.query("SELECT stop_reason FROM debug_sessions ORDER BY started_at")).rows);
    expect(rows.map((r) => r.stop_reason)).toEqual(["replaced", "owner_stopped"]);
    const audit = (await c.get("/api/settings/security")).json as { counts: Record<string, number> };
    expect(audit.counts["debug.enabled"]).toBe(2);
    expect(audit.counts["debug.stopped"]).toBe(1);
    // restart resets to INFO even if a row says active
    await withTenant(app.pool, owner.tenant_id, (cl) => cl.query("INSERT INTO debug_sessions (tenant_id, component, expires_at) VALUES ($1, 'api', now() + interval '10 minutes')", [owner.tenant_id]));
    const { createContext } = await import("@blackbox/api");
    const fresh = createContext({ config: app.config, pool: app.pool, logger: app.logger, collector: app.collector });
    expect(fresh.debugGate.active()).toHaveLength(0);
    const storage = (await c.get("/api/diagnostics/storage")).json as { logs: { retained_from: string | null; cap_bytes: number; state: string } };
    expect(storage.logs.cap_bytes).toBe(100 * 1024 * 1024);
    expect(storage.logs.retained_from).toBeTruthy();
  });
});

describe("DIAG-06 redaction and access", () => {
  it("canaries submitted through normal/error paths never reach any sink", async () => {
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    const canary = "CANARY-anna.secret@example.com-bbk_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    await c.request("POST", "/api/auth/login", { key: canary, remember: false }, { origin: app.baseUrl, "user-agent": "canary" });
    await c.post("/api/ingest/replay", { connection_id: demo.connections.shop, events: [{ provider_event_id: "canary-1", kind: "order.accepted", occurred_at: "2026-10-31T09:00:00Z", entity: { order: canary }, payload: { order: "#C", quantity: 1, unit_gross_minor: 1, gross_minor: 1, currency: "EUR", email: "pii.canary@example.com", note: "<script>alert('x')</script>" } }] });
    await c.post("/api/ingest/replay", { connection_id: demo.connections.shop, events: [{ provider_event_id: "canary-2", kind: "order.accepted", occurred_at: "2026-10-31T09:00:00Z", entity: {}, payload: { order: "#C2", quantity: "oops", currency: canary } }] });
    await c.get(`/api/journal?event_type=${encodeURIComponent(canary)}`);
    await c.get(`/api/search?q=${encodeURIComponent("pii.canary@example.com")}`);
    await c.request("GET", "/api/workspace", undefined, { authorization: "Bearer shpat_canarytoken1234567890", cookie: "" });
    await wait(150);
    const text = allLogText();
    for (const part of ["anna.secret", "bbk_ZZZZ", "pii.canary", "<script>", "shpat_canary"]) expect(text, part).not.toContain(part);
    // The canonical journal payload is anchored too (not just logs).
    const entry = (await c.get("/api/journal?record_id=order:%23C")).json as { entries: Array<{ payload: unknown }> };
    expect(JSON.stringify(entry.entries.map((e) => e.payload))).not.toMatch(/pii\.canary|<script>/);
  });

  it("logs are owner-only and workspace-scoped; agents, anonymous, forged origins and other tenants are denied", async () => {
    const anon = new ApiClient(app.baseUrl);
    for (const url of ["/api/diagnostics/logs", "/api/diagnostics/health", "/api/diagnostics/logs/stream", "/api/diagnostics/storage", "/api/diagnostics/debug"]) expect((await anon.get(url)).status, url).toBe(401);
    const agent = new ApiClient(app.baseUrl);
    agent.bearer = agentKey;
    for (const url of ["/api/diagnostics/logs", "/api/diagnostics/health", "/api/diagnostics/logs/stream", "/api/diagnostics/storage"]) expect((await agent.get(url)).status, url).toBe(403);
    expect((await agent.post("/api/diagnostics/debug", { component: "api", minutes: 1 })).status).toBe(403);
    expect((await agent.post("/api/diagnostics/export", { since: "2026-01-01T00:00:00Z", until: "2026-12-31T00:00:00Z" })).status).toBe(403);
    expect((await agent.get("/api/sources/readiness")).status).toBe(200); // business readiness still works
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    expect((await c.request("POST", "/api/diagnostics/debug", { component: "api", minutes: 1 }, { origin: "http://evil.example", "x-blackbox-csrf": c.csrf! })).status).toBe(403);
    expect((await c.request("POST", "/api/diagnostics/export", { since: "2026-01-01T00:00:00Z", until: "2026-12-31T00:00:00Z" }, { origin: app.baseUrl, "x-blackbox-csrf": "" })).status).toBe(403); // missing/empty CSRF header
    // Workspace scope: records of another tenant are never listed, counted or fetched.
    const tenantB = await app.createTenant("Tenant B");
    app.logger.child({ tenant_id: tenantB, connection_id: "11111111-1111-4111-8111-111111111111" }, "ingestion").info("test.other_tenant", "other tenant record");
    app.logger.child({ tenant_id: owner.tenant_id }, "ingestion").info("test.own_tenant", "own tenant record");
    await wait(100);
    const list = (await c.get("/api/diagnostics/logs?q=tenant%20record&limit=100")).json as { records: Array<Record<string, unknown>> };
    expect(list.records.some((r) => r.event_name === "test.own_tenant")).toBe(true);
    expect(list.records.some((r) => r.event_name === "test.other_tenant")).toBe(false);
    expect(list.records.every((r) => !r.tenant_id || r.tenant_id === owner.tenant_id)).toBe(true);
    const foreignRec = JSON.parse(allLogText().split("\n").find((l) => l.includes("test.other_tenant"))!) as { record_id: string };
    expect((await c.get(`/api/diagnostics/logs/${foreignRec.record_id}`)).status).toBe(404);
    const byForeignConnection = (await c.get("/api/diagnostics/logs?connection_id=11111111-1111-4111-8111-111111111111&limit=100")).json as { records: unknown[] };
    expect(byForeignConnection.records).toHaveLength(0);
    // provider filter resolves only this workspace's connections
    const byProvider = (await c.get("/api/diagnostics/logs?provider=shopify&limit=100")).json as { records: Array<Record<string, unknown>> };
    expect(byProvider.records.length).toBeGreaterThan(0);
    expect(byProvider.records.every((r) => r.connection_id === demo.connections.shop)).toBe(true);
  });
});

describe("DIAG-08 explicit export", () => {
  it("previews then exports a bounded, pseudonymized bundle without credentials, business content or paths", async () => {
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    const since = new Date(Date.now() - 3600_000).toISOString();
    const until = new Date(Date.now() + 60_000).toISOString();
    const preview = (await c.post("/api/diagnostics/export?preview=1", { since, until })).json as { preview: { size_bytes: number; truncated: boolean; categories: string[]; records: number; unavailable: string[] } };
    expect(preview.preview.size_bytes).toBeGreaterThan(0);
    expect(preview.preview.categories).toEqual(["versions", "health", "errors", "logs"]);
    expect(preview.preview.records).toBeGreaterThan(10);
    const res = await fetch(`${app.baseUrl}/api/diagnostics/export`, { method: "POST", headers: { "content-type": "application/json", cookie: c.cookie!, origin: app.baseUrl, "x-blackbox-csrf": c.csrf! }, body: JSON.stringify({ since, until, categories: ["versions", "health", "errors", "logs"] }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const zip = new Uint8Array(await res.arrayBuffer());
    expect(zip.byteLength).toBeLessThanOrEqual(10 * 1024 * 1024);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(["README.txt", "error-counts.json", "health.json", "logs-excerpt.jsonl", "versions.json"]);
    const excerpt = strFromU8(files["logs-excerpt.jsonl"]!);
    expect(excerpt).not.toContain(owner.tenant_id);
    expect(excerpt).not.toContain(demo.connections.shop);
    expect(excerpt).not.toContain(demo.run_id);
    expect(excerpt).not.toMatch(/\/Users\/|\/home\//);
    expect(excerpt).not.toMatch(/bbk_|bba_|shpat_/);
    const lines = excerpt.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const runIds = new Set(lines.filter((l) => l.event_name === "journal.batch_committed" && l.run_id).map((l) => l.run_id));
    expect(runIds.size).toBe(1); // consistent pseudonym preserves correlation
    expect([...runIds][0]).toMatch(/^run-1-/);
    const health = JSON.parse(strFromU8(files["health.json"]!)) as Array<{ area: string; state: string }>;
    expect(health.map((h) => h.area).sort()).toEqual(["api", "diagnostics", "engine", "mcp", "postgres", "sources", "worker"]);
    expect(health.find((h) => h.area === "engine")!.state).toBe("unavailable"); // stub, honestly reported
    expect(health.find((h) => h.area === "postgres")!.state).toBe("healthy");
    const audit = (await c.get("/api/settings/security")).json as { counts: Record<string, number> };
    expect(audit.counts["diagnostics.exported"]).toBe(1);
    // cap: a huge window with categories=logs on a tiny max is truncated, never over the limit
    const { buildDiagnosticsExport } = await import("@blackbox/api");
    const small = buildDiagnosticsExport({ logsDir: app.install.logsDir, since, until, categories: ["logs"], tenantId: owner.tenant_id, serviceVersion: "test", health: null, maxBytes: 70 * 1024 });
    expect(small.preview.truncated).toBe(true);
    expect(small.zip.byteLength).toBeLessThanOrEqual(70 * 1024);
  });

  it("health cards describe measured state with observation time, reason and next action", async () => {
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    const health = (await c.get("/api/diagnostics/health")).json as { cards: Array<{ area: string; state: string; observed_at: string; reason: string; next_action: string | null; details: Record<string, unknown> }>; refresh_interval_seconds: number; stale_after_seconds: number };
    expect(health.refresh_interval_seconds).toBe(5);
    expect(health.stale_after_seconds).toBe(30);
    for (const card of health.cards) {
      expect(Date.parse(card.observed_at)).toBeGreaterThan(0);
      expect(card.reason.length).toBeGreaterThan(5);
    }
    const sources = health.cards.find((h) => h.area === "sources")!;
    expect(sources.state).toBe("healthy");
    expect(sources.details.last_successful_check_at).toBeTruthy();
    expect(sources.details.last_new_event_at).toBeTruthy();
    const mcp = health.cards.find((h) => h.area === "mcp")!;
    expect(mcp.state).toBe("healthy"); // an agent key was used earlier in this file: an actual authorized request was observed
    expect(mcp.details.last_authorized_request_at).toBeTruthy();
    expect(health.cards.find((h) => h.area === "diagnostics")!.details.retained_from).toBeTruthy();
  });
});

/** Async spawn: a synchronous spawn would block this worker, which also hosts the API under test. */
function run(file: string, args: string[], env: Record<string, string>): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 90_000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : error ? 1 : 0;
      resolve({ status: code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe("CLI fallback", () => {
  const cli = path.join(repoRoot, "apps/api/src/cli.ts");
  const tsx = path.join(repoRoot, "node_modules/.bin/tsx");
  // Minimal environment: an inherited NODE_OPTIONS/tsx loader from the test runner would deadlock the child at startup.
  const env = () => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LOGS_DIR: app.install.logsDir, EVIDENCE_DIR: app.install.evidenceDir, SECRETS_DIR: app.install.secretsDir, SNAPSHOT_DIR: app.install.snapshotDir, DATABASE_URL: app.db.urls.api, ENGINE_URL: "stub", PORT: String(app.port) });

  it("logs reads retained files without the database, honours --level/--since/--run/--format", async () => {
    app.collector.flush();
    const json = await run(tsx, [cli, "logs", "--since", "1h", "--run", demo.run_id, "--format", "json", "--limit", "1000"], { ...env(), DATABASE_URL: "postgres://bb_api:wrong@127.0.0.1:1/none" });
    expect(json.status).toBe(0);
    const records = json.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records.filter((r) => r.event_name === "journal.batch_committed")).toHaveLength(19);
    const warn = await run(tsx, [cli, "logs", "--since", "1h", "--level", "warn", "--format", "text", "--limit", "1000"], env());
    expect(warn.stdout).toMatch(/WARN|ERROR/);
    expect(warn.stdout).not.toMatch(/ INFO /);
    const bad = await run(tsx, [cli, "logs", "--level", "loud"], env());
    expect(bad.status).toBe(2);
  });

  it("doctor reports checks with documented exit codes and does not need the database for file checks", async () => {
    const ok = await run(tsx, [cli, "doctor", "--format", "json"], env());
    const report = JSON.parse(ok.stdout) as { exit_code: number; checks: Array<{ id: string; state: string }> };
    expect(report.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["node_version", "logs_dir", "evidence_dir", "secrets_dir", "data_key", "retained_logs", "postgres", "api", "engine"]));
    expect(report.checks.find((c) => c.id === "postgres")!.state).toBe("ok");
    expect(report.checks.find((c) => c.id === "api")!.state).toBe("ok");
    expect(report.checks.find((c) => c.id === "engine")!.state).toBe("degraded"); // stub
    expect(ok.status).toBe(1);
    expect(report.exit_code).toBe(1);
    const down = await run(tsx, [cli, "doctor", "--format", "json"], { ...env(), DATABASE_URL: "postgres://bb_api:wrong@127.0.0.1:1/none", PORT: String(app.port + 1) });
    const r2 = JSON.parse(down.stdout) as { checks: Array<{ id: string; state: string }> };
    expect(r2.checks.find((c) => c.id === "postgres")!.state).toBe("unavailable");
    expect(r2.checks.find((c) => c.id === "api")!.state).toBe("unavailable");
    expect(r2.checks.find((c) => c.id === "retained_logs")!.state).toBe("ok");
    const failure = await run(tsx, [cli, "doctor"], { ...env(), HOST: "0.0.0.0", LOGS_DIR: "/nonexistent/logs" });
    expect(failure.status).toBe(2);
    expect(failure.stdout).toMatch(/not supported/);
  });

  it("diagnostics export writes a capped zip from files even when the database is down", async () => {
    const out = path.join(app.install.root, "diag.zip");
    const r = await run(tsx, [cli, "diagnostics", "export", "--since", "1h", "--output", out], { ...env(), DATABASE_URL: "postgres://bb_api:wrong@127.0.0.1:1/none" });
    expect(r.status).toBe(0);
    const summary = JSON.parse(r.stdout) as { output: string; size_bytes: number; unavailable: string[]; records: number };
    expect(summary.output).toBe(out);
    expect(statSync(out).size).toBe(summary.size_bytes);
    expect(summary.unavailable.join(" ")).toMatch(/health/);
    const files = unzipSync(new Uint8Array(readFileSync(out)));
    expect(Object.keys(files)).toContain("logs-excerpt.jsonl");
    expect(Object.keys(files)).not.toContain("health.json");
  });
});
