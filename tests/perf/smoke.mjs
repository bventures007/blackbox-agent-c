#!/usr/bin/env node
// PILOT-09 / OPS-05 smoke-profile load driver (benchmarks/performance-contract.json, profile "smoke").
//
//   node tests/perf/smoke.mjs --pools <pools.json> --mode closed|fixed --transport api|mcp \
//     --duration 600 [--clients 20] [--rate 40] [--ingest-obs-per-second 10] [--warmup 60] \
//     --out reports/evidence/PILOT-09/run-<name>.json [--owner-key-file <file>] [--project <compose project>]
//
// Query mix (per request): 50 % hot current state (latest_committed order state of a designated hot
// order), 20 % cold order state (as_of_recorded replay of a cold-sample order at one of 600 distinct
// cutoffs so the engine's cold LRU mostly misses), 20 % entity history (first 100 entries), 10 %
// bounded 30-day summary (tenant-wide `invoices.outstanding` evaluated at the window end: `now` + `due_before`; the intent has no from/to). Closed loop: N clients
// each issue one request after the other. Fixed arrival: requests are scheduled at a constant rate
// and latency counts from the scheduled arrival to completion (queueing included). Both modes run
// with concurrent replay ingestion through the owner session (durable ack latency and
// at_least_cursor barrier lag are measured per batch). Transport "mcp" drives the real stdio bridge
// (packages/mcp/dist/server.js) with the official SDK client, one bridge per principal.
// Memory: docker stats of the Compose project every 10 s (whole stack) plus the engine health card.
// A response counts as successful only when it is HTTP/tool success AND carries the expected
// consistency status (current / historical); 429, 503, timeouts and stale answers are failures.
import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const driverFaults = { unhandled_rejections: 0, uncaught_exceptions: 0, samples: [] };
process.on("unhandledRejection", (e) => { driverFaults.unhandled_rejections++; if (driverFaults.samples.length < 5) driverFaults.samples.push(String(e?.message ?? e)); });
process.on("uncaughtException", (e) => { driverFaults.uncaught_exceptions++; if (driverFaults.samples.length < 5) driverFaults.samples.push(String(e?.message ?? e)); });

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const POOLS = JSON.parse(readFileSync(opt("pools"), "utf8"));
const MODE = opt("mode", "closed");
const TRANSPORT = opt("transport", "api");
const DURATION = Number(opt("duration", "600"));
const CLIENTS = Number(opt("clients", "20"));
const RATE = Number(opt("rate", "40"));
const INGEST_OBS = Number(opt("ingest-obs-per-second", "10"));
const WARMUP = Number(opt("warmup", "60"));
const OUT = opt("out");
const OWNER_KEY_FILE = opt("owner-key-file", process.env.OWNER_KEY_FILE);
const PROJECT = opt("project", process.env.COMPOSE_PROJECT_NAME ?? "blackbox-agent-c-ops");
const API = POOLS.api;
const DEADLINE_MS = 5000;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MCP_SERVER = process.env.BLACKBOX_MCP_SERVER ?? path.join(repo, "packages/mcp/dist/server.js");

const clientsCfg = POOLS.clients.slice(0, CLIENTS);
const keyCache = new Map();
const keyOf = (f) => keyCache.get(f) ?? (keyCache.set(f, readFileSync(f, "utf8").trim()), keyCache.get(f));

// ----- deterministic-ish RNG per run -------------------------------------------------------------
let seed = 0x9e3779b9;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const CLASSES = [["hot", 0.5], ["cold", 0.2], ["history", 0.2], ["summary", 0.1]];
function pickClass() {
  let r = rnd();
  for (const [c, w] of CLASSES) {
    if (r < w) return c;
    r -= w;
  }
  return "hot";
}
// 600 distinct recorded-time cutoffs spread over the last ten minutes before the run start.
const RUN_START = Date.now();
const CUTOFFS = Array.from({ length: 600 }, (_, i) => new Date(RUN_START - (i + 1) * 1000).toISOString());

// ----- API transport ------------------------------------------------------------------------------------
async function apiRequest(method, url, key, body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), DEADLINE_MS + 2000);
  try {
    const res = await fetch(API + url, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: { error: { code: e.name === "AbortError" ? "client_timeout" : "network", message: String(e.message) } } };
  } finally {
    clearTimeout(t);
  }
}

// ----- MCP transport (official SDK client over stdio) ----------------------------------------------------
const bridges = new Map();
async function bridgeFor(keyFile) {
  if (bridges.has(keyFile)) return bridges.get(keyFile);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_SERVER], env: { ...process.env, BLACKBOX_API_URL: API, BLACKBOX_AGENT_KEY_FILE: keyFile }, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "blackbox-perf-smoke", version: "1.0.0" });
  await client.connect(transport);
  bridges.set(keyFile, client);
  return client;
}
async function mcpCall(keyFile, tool, args) {
  const client = await bridgeFor(keyFile);
  try {
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: DEADLINE_MS + 2000 });
    const text = r.content?.find((c) => c.type === "text")?.text ?? "";
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return { status: r.isError ? json?.error?.status ?? 500 : 200, json };
  } catch (e) {
    return { status: 0, json: { error: { code: /timeout/i.test(String(e.message)) ? "client_timeout" : "bridge", message: String(e.message) } } };
  }
}

// ----- one request of a class ----------------------------------------------------------------------------
function classify(cls, r) {
  if (!r.json || r.status !== 200) return { ok: false, code: r.json?.error?.code ?? `http_${r.status}` };
  if (r.json.error) return { ok: false, code: r.json.error.code ?? "error" };
  const st = r.json.consistency?.status;
  if (cls === "hot" && st !== "current") return { ok: false, code: `consistency_${st ?? "missing"}` };
  if (cls === "cold" && st !== "historical") return { ok: false, code: `consistency_${st ?? "missing"}` };
  if (cls === "summary" && !["complete", "partial", "unknown", "conflict"].includes(r.json.status)) return { ok: false, code: `status_${r.json.status}` };
  if (cls === "history" && !Array.isArray(r.json.entries)) return { ok: false, code: "no_entries" };
  return { ok: true, code: null };
}
async function doRequest(client, cls) {
  const pool = POOLS.pools[client.tenant_id];
  const key = keyOf(client.key_file);
  let r;
  if (TRANSPORT === "api") {
    if (cls === "hot") r = await apiRequest("GET", `/api/entities/order/${encodeURIComponent(pick(pool.hot))}/state`, key);
    else if (cls === "cold") r = await apiRequest("GET", `/api/entities/order/${encodeURIComponent(pick(pool.cold))}/state?mode=as_of&as_of_recorded=${encodeURIComponent(pick(CUTOFFS))}`, key);
    else if (cls === "history") r = await apiRequest("GET", `/api/entities/order/${encodeURIComponent(pick(pool.hot.concat(pool.cold)))}/history?limit=100`, key);
    else r = await apiRequest("POST", `/api/questions/invoices.outstanding`, key, { params: { now: POOLS.summary_window.to, due_before: POOLS.summary_window.to } });
  } else {
    if (cls === "hot") r = await mcpCall(client.key_file, "get_business_state", { entity_type: "order", entity_id: pick(pool.hot) });
    else if (cls === "cold") r = await mcpCall(client.key_file, "get_business_state", { entity_type: "order", entity_id: pick(pool.cold), mode: "as_of", as_of_recorded: pick(CUTOFFS) });
    else if (cls === "history") r = await mcpCall(client.key_file, "get_entity_history", { entity_type: "order", entity_id: pick(pool.hot.concat(pool.cold)), limit: 100 });
    else r = await mcpCall(client.key_file, "answer_question", { intent: "invoices.outstanding", params: { now: POOLS.summary_window.to, due_before: POOLS.summary_window.to } });
  }
  return classify(cls, r);
}

// ----- samples -------------------------------------------------------------------------------------------
const samples = { hot: [], cold: [], history: [], summary: [] };
const errors = { hot: {}, cold: {}, history: {}, summary: {} };
const perTenant = {};
function record(cls, ms, res, tenantIndex) {
  samples[cls].push({ ms, ok: res.ok });
  if (!res.ok) errors[cls][res.code] = (errors[cls][res.code] ?? 0) + 1;
  perTenant[tenantIndex] = (perTenant[tenantIndex] ?? 0) + 1;
}
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)].toFixed(1));
}
function stats(cls) {
  const all = samples[cls];
  const ok = all.filter((s) => s.ok).map((s) => s.ms);
  const everything = all.map((s) => s.ms);
  return { requests: all.length, successful: ok.length, success_fraction: all.length ? Number((ok.length / all.length).toFixed(5)) : null, p50_ms: pct(everything, 0.5), p95_ms: pct(everything, 0.95), p99_ms: pct(everything, 0.99), p95_ms_successful_only: pct(ok, 0.95), max_ms: pct(everything, 1), errors: errors[cls] };
}

// ----- ingestion through the owner session ----------------------------------------------------------------
const ingest = { batches: 0, observations: 0, entries: 0, ack_ms: [], lag_ms: [], errors: {}, connection_id: null, first_cursor: null, last_cursor: null };
// Startup requests are bounded (60 s) and retried: an API still digesting the previous run's ingestion backlog
// must delay the run, not kill the driver on undici's 300 s header timeout (observed on the MCP closed-loop attempt).
const SETUP_TIMEOUT_MS = 60_000;
async function ownerSession() {
  if (!OWNER_KEY_FILE) return null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await ownerSessionOnce();
    } catch (e) {
      lastErr = e;
      console.error(`owner session attempt ${attempt} failed: ${e?.message ?? e}; retrying in 30 s`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
  throw lastErr;
}
async function ownerSessionOnce() {
  const key = readFileSync(OWNER_KEY_FILE, "utf8").trim();
  const login = await fetch(API + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: API }, body: JSON.stringify({ key, remember: false }), signal: AbortSignal.timeout(SETUP_TIMEOUT_MS) });
  if (login.status !== 204) throw new Error(`owner login failed: ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const sess = await (await fetch(API + "/api/auth/session", { headers: { cookie }, signal: AbortSignal.timeout(SETUP_TIMEOUT_MS) })).json();
  const headers = { cookie, origin: API, "x-blackbox-csrf": sess.csrf_token, "content-type": "application/json" };
  // a dedicated labeled replay connection for this run
  const conns = await (await fetch(API + "/api/sources", { headers, signal: AbortSignal.timeout(SETUP_TIMEOUT_MS) })).json();
  let conn = null;
  for (const p of conns.catalogue ?? []) for (const c of p.connections ?? []) if (c.display_name === "perf smoke ingestion" && c.status !== "disconnected") conn = c;
  if (!conn) {
    const res = await fetch(API + "/api/sources/connections", { method: "POST", headers, body: JSON.stringify({ provider: "replay", display_name: "perf smoke ingestion", config: { synthetic: true, purpose: "PILOT-09" } }), signal: AbortSignal.timeout(SETUP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`connection create failed ${res.status} ${await res.text()}`);
    conn = (await res.json()).connection ?? (await res.json());
  }
  ingest.connection_id = conn.connection_id;
  return { headers, connection_id: conn.connection_id, tenant_id: sess.workspace.tenant_id };
}
let ingestTimer = null;
function startIngestion(owner, runTag) {
  if (!owner || INGEST_OBS <= 0) return;
  let n = 0;
  ingestTimer = setInterval(() => ingestOnce().catch((e) => { ingest.errors.driver = (ingest.errors.driver ?? 0) + 1; ingest.last_driver_error = String(e?.message ?? e); }), 1000);
  async function ingestOnce() {
    const events = [];
    for (let i = 0; i < INGEST_OBS; i++) {
      const id = `#PERF-${runTag}-${n++}`;
      events.push({ provider_event_id: `perf:${runTag}:${id}`, kind: "order.accepted", occurred_at: new Date().toISOString(), entity: { order: id, customer: `C-PERF-${n % 97}`, item: `SKU-PERF-${n % 13}` }, payload: { order: id, quantity: 1 + (n % 5), unit: "piece", unit_gross_minor: 1190, gross_minor: 1190 * (1 + (n % 5)), currency: "EUR", status: "accepted" }, evidence_refs: [] });
    }
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(API + "/api/ingest/replay", { method: "POST", headers: owner.headers, body: JSON.stringify({ connection_id: owner.connection_id, events }), signal: AbortSignal.timeout(DEADLINE_MS * 60) });
    } catch (e) {
      ingest.errors.network = (ingest.errors.network ?? 0) + 1;
      return;
    }
    const ack = performance.now() - t0;
    if (res.status !== 200) {
      ingest.errors[`http_${res.status}`] = (ingest.errors[`http_${res.status}`] ?? 0) + 1;
      return;
    }
    let body;
    try {
      body = await res.json();
    } catch (e) {
      ingest.errors.body = (ingest.errors.body ?? 0) + 1;
      return;
    }
    ingest.batches++;
    ingest.observations += body.accepted ?? 0;
    ingest.ack_ms.push(ack);
    if (body.committed_cursor != null) {
      if (ingest.first_cursor == null) ingest.first_cursor = body.committed_cursor;
      ingest.last_cursor = body.committed_cursor;
      // lag: time until the engine has applied this batch's committed cursor (barrier wait + one point read)
      const t1 = performance.now();
      const last = events[events.length - 1].entity.order;
      // A saturated API can exceed undici's 300 s header timeout here; a failed barrier read is an ingestion
      // error, never a driver crash (the earlier runs died on an unhandled HeadersTimeoutError at this point).
      try {
        const r = await fetch(API + `/api/entities/order/${encodeURIComponent(last)}/state?mode=at_least_cursor&cursor=${body.committed_cursor}`, { headers: owner.headers, signal: AbortSignal.timeout(DEADLINE_MS * 10) });
        const lag = performance.now() - t1;
        if (r.status === 200) ingest.lag_ms.push(lag);
        else ingest.errors[`lag_http_${r.status}`] = (ingest.errors[`lag_http_${r.status}`] ?? 0) + 1;
      } catch (e) {
        ingest.errors[e.name === "TimeoutError" ? "lag_client_timeout" : "lag_network"] = (ingest.errors[e.name === "TimeoutError" ? "lag_client_timeout" : "lag_network"] ?? 0) + 1;
      }
    }
  }
}

// ----- memory sampling ---------------------------------------------------------------------------------------
const memSamples = [];
function dockerStats() {
  return new Promise((resolve) => {
    execFile("docker", ["stats", "--no-stream", "--format", "{{json .}}"], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve([]);
      const rows = stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.Name.startsWith(PROJECT + "-") && !r.Name.endsWith("-pgproxy"));
      resolve(rows.map((r) => ({ name: r.Name.slice(PROJECT.length + 1), mem: r.MemUsage.split("/")[0].trim(), cpu: r.CPUPerc })));
    });
  });
}
const toMiB = (s) => {
  const m = /^([\d.]+)\s*([KMG]i?B)$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  return m[2].startsWith("G") ? v * 1024 : m[2].startsWith("K") ? v / 1024 : v;
};
let memTimer = null;
function startMemorySampling(owner) {
  const sample = async () => {
    const rows = await dockerStats();
    const total = rows.reduce((a, r) => a + (toMiB(r.mem) ?? 0), 0);
    const engine = rows.find((r) => r.name === "engine");
    let engineCard = null;
    if (owner) {
      try {
        const h = await (await fetch(API + "/api/diagnostics/health", { headers: owner.headers, signal: AbortSignal.timeout(DEADLINE_MS * 2) })).json();
        engineCard = (Array.isArray(h.cards) ? h.cards.find((c) => c.area === "engine") : h.cards?.engine) ?? null;
      } catch {
        /* ignore */
      }
    }
    memSamples.push({ at: new Date().toISOString(), total_stack_mib: Number(total.toFixed(1)), engine_mib: engine ? toMiB(engine.mem) : null, containers: rows, engine_card: engineCard });
  };
  memTimer = setInterval(sample, 10000);
  return sample();
}

// ----- warm-up (hot sets only; cold samples are never touched) ------------------------------------------------
async function warmup() {
  const t0 = Date.now();
  let n = 0;
  const jobs = clientsCfg.map(async (c, i) => {
    const pool = POOLS.pools[c.tenant_id];
    const share = pool.hot.filter((_, j) => j % clientsCfg.filter((x) => x.tenant_id === c.tenant_id).length === clientsCfg.filter((x) => x.tenant_id === c.tenant_id).indexOf(c));
    for (const id of share) {
      if (Date.now() - t0 > WARMUP * 1000) break;
      if (TRANSPORT === "api") await apiRequest("GET", `/api/entities/order/${encodeURIComponent(id)}/state`, keyOf(c.key_file));
      else await mcpCall(c.key_file, "get_business_state", { entity_type: "order", entity_id: id });
      n++;
    }
  });
  await Promise.all(jobs);
  return { touched: n, seconds: (Date.now() - t0) / 1000 };
}

// ----- load modes ------------------------------------------------------------------------------------------------
async function closedLoop(deadline) {
  await Promise.all(
    clientsCfg.map(async (c) => {
      while (Date.now() < deadline) {
        const cls = pickClass();
        const t0 = performance.now();
        const res = await doRequest(c, cls);
        record(cls, performance.now() - t0, res, c.tenant_index);
      }
    }),
  );
}
async function fixedArrival(deadline) {
  const interval = 1000 / RATE;
  const start = performance.now();
  let i = 0;
  const inflight = new Set();
  let maxInflight = 0;
  let scheduled = 0;
  while (Date.now() < deadline) {
    const due = start + i * interval;
    const now = performance.now();
    if (now < due) await new Promise((r) => setTimeout(r, due - now));
    const c = clientsCfg[i % clientsCfg.length];
    const cls = pickClass();
    const sched = due;
    scheduled++;
    const p = doRequest(c, cls).then((res) => record(cls, performance.now() - sched, res, c.tenant_index));
    inflight.add(p);
    maxInflight = Math.max(maxInflight, inflight.size);
    p.finally(() => inflight.delete(p));
    i++;
  }
  await Promise.race([Promise.all([...inflight]), new Promise((r) => setTimeout(r, 15000))]);
  return { scheduled, max_inflight: maxInflight, unfinished_at_end: inflight.size };
}

// ----- main ------------------------------------------------------------------------------------------------------------
const started = new Date().toISOString();
const owner = await ownerSession();
const warm = await warmup();
await startMemorySampling(owner);
const runTag = `${TRANSPORT}-${MODE}-${Date.now().toString(36)}`;
startIngestion(owner, runTag);
const t0 = Date.now();
const deadline = t0 + DURATION * 1000;
const modeInfo = MODE === "fixed" ? await fixedArrival(deadline) : (await closedLoop(deadline), { clients: clientsCfg.length });
const elapsed = (Date.now() - t0) / 1000;
if (ingestTimer) clearInterval(ingestTimer);
if (memTimer) clearInterval(memTimer);
await new Promise((r) => setTimeout(r, 1500));
for (const b of bridges.values()) await b.close().catch(() => {});

const total = Object.values(samples).reduce((a, s) => a + s.length, 0);
const succ = Object.values(samples).reduce((a, s) => a + s.filter((x) => x.ok).length, 0);
const result = {
  schema: "blackbox-perf-smoke/1",
  started_at: started,
  finished_at: new Date().toISOString(),
  api: API,
  transport: TRANSPORT,
  mode: MODE,
  config: { duration_s: DURATION, clients: clientsCfg.length, fixed_rate_rps: MODE === "fixed" ? RATE : null, ingest_observations_per_second: INGEST_OBS, warmup_cap_s: WARMUP, deadline_ms: DEADLINE_MS, query_mix: Object.fromEntries(CLASSES), principals: new Set(clientsCfg.map((c) => c.principal)).size, tenants: new Set(clientsCfg.map((c) => c.tenant_id)).size, mcp_server: TRANSPORT === "mcp" ? MCP_SERVER : null, project: PROJECT },
  warmup: warm,
  elapsed_s: elapsed,
  mode_info: modeInfo,
  achieved_rps: Number((total / elapsed).toFixed(2)),
  requests_total: total,
  successful_total: succ,
  success_fraction: total ? Number((succ / total).toFixed(5)) : null,
  classes: Object.fromEntries(Object.keys(samples).map((c) => [c, stats(c)])),
  requests_per_tenant_index: perTenant,
  ingestion: { connection_id: ingest.connection_id, batches: ingest.batches, observations_accepted: ingest.observations, journal_entries_committed: ingest.first_cursor != null && ingest.last_cursor != null ? ingest.last_cursor - ingest.first_cursor + INGEST_OBS * 2 : null, entries_per_second: ingest.first_cursor != null ? Number(((ingest.last_cursor - ingest.first_cursor + INGEST_OBS * 2) / elapsed).toFixed(2)) : null, durable_ack_p50_ms: pct(ingest.ack_ms, 0.5), durable_ack_p95_ms: pct(ingest.ack_ms, 0.95), lag_p50_ms: pct(ingest.lag_ms, 0.5), lag_p95_ms: pct(ingest.lag_ms, 0.95), lag_max_ms: pct(ingest.lag_ms, 1), lag_samples: ingest.lag_ms.length, errors: ingest.errors, note: "lag = at_least_cursor barrier wait plus one point read, measured right after the durable ack of each batch" },
  memory: { samples: memSamples.length, engine_mib_steady_median: pct(memSamples.map((m) => m.engine_mib).filter((x) => x != null), 0.5), engine_mib_peak: pct(memSamples.map((m) => m.engine_mib).filter((x) => x != null), 1), total_stack_mib_peak: pct(memSamples.map((m) => m.total_stack_mib), 1), total_stack_mib_median: pct(memSamples.map((m) => m.total_stack_mib), 0.5), per_container_peak_mib: Object.fromEntries(["postgres", "engine", "api", "worker", "backup-scheduler"].map((n) => [n, pct(memSamples.flatMap((m) => m.containers.filter((c) => c.name === n).map((c) => toMiB(c.mem))), 1)])), last_engine_card: memSamples.at(-1)?.engine_card ?? null, series: memSamples.map((m) => ({ at: m.at, total_stack_mib: m.total_stack_mib, engine_mib: m.engine_mib })) },
};
result.driver_faults = driverFaults;
if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ transport: TRANSPORT, mode: MODE, elapsed_s: elapsed, rps: result.achieved_rps, success_fraction: result.success_fraction, classes: Object.fromEntries(Object.entries(result.classes).map(([k, v]) => [k, { n: v.requests, p95: v.p95_ms, p99: v.p99_ms, ok: v.success_fraction }])), ingestion: { eps: result.ingestion.entries_per_second, ack_p95: result.ingestion.durable_ack_p95_ms, lag_p95: result.ingestion.lag_p95_ms }, memory: { engine_peak: result.memory.engine_mib_peak, stack_peak: result.memory.total_stack_mib_peak } }));
process.exit(0);
