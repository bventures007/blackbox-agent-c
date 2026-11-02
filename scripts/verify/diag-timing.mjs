#!/usr/bin/env node
// DIAG-07 measurements against a running install: first-page (200 rows, last hour, INFO+) latency p95 over N
// requests, literal-search latency p95, filtered (warnings) latency p95, live delivery latency (time from a new
// api log record to its arrival on the SSE stream), plus the storage/retention figures the API reports. Owner
// session from a key file (never printed). Output JSON to stdout.
//   node scripts/verify/diag-timing.mjs --api http://127.0.0.1:19185 --owner-key-file <file> [--n 30]
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const API = opt("api"); const N = Number(opt("n", "30"));
const key = readFileSync(opt("owner-key-file"), "utf8").trim();
const login = await fetch(API + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: API }, body: JSON.stringify({ key, remember: false }) });
if (login.status !== 204) throw new Error(`login ${login.status}`);
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const H = { cookie, origin: API };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
async function timed(url) {
  const t0 = performance.now(); const r = await fetch(API + url, { headers: H }); const j = await r.json(); return { ms: performance.now() - t0, status: r.status, rows: j.records?.length ?? j.entries?.length ?? null, dropped: j.dropped_count ?? null };
}
const since = new Date(Date.now() - 3600_000).toISOString();
const out = { api: API, measured_at: new Date().toISOString(), n: N, classes: {} };
for (const [name, url] of [["first_page_200_last_hour_info", `/api/diagnostics/logs?limit=200&since=${since}&level_min=INFO`], ["warnings_preset_200", `/api/diagnostics/logs?limit=200&since=${since}&levels=WARN,ERROR`], ["literal_search_200_6_days", `/api/diagnostics/logs?limit=200&since=${new Date(Date.now() - 6 * 86400_000).toISOString()}&q=snapshot_rejected`], ["component_filter_200_6_days", `/api/diagnostics/logs?limit=200&since=${new Date(Date.now() - 6 * 86400_000).toISOString()}&component=engine`]]) {
  const ms = []; let last = null;
  for (let i = 0; i < N; i++) { last = await timed(url); ms.push(last.ms); }
  out.classes[name] = { p50_ms: +pct(ms, 0.5).toFixed(1), p95_ms: +pct(ms, 0.95).toFixed(1), max_ms: +Math.max(...ms).toFixed(1), rows_last: last.rows, status_last: last.status };
}
// live: open the SSE stream, then trigger api records (health probes / a journal read) and measure arrival delay
const ctrl = new AbortController();
const stream = await fetch(API + "/api/diagnostics/logs/stream", { headers: H, signal: ctrl.signal });
const reader = stream.body.getReader(); const dec = new TextDecoder(); let buf = ""; const arrivals = [];
const pump = (async () => { try { while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const evt = buf.slice(0, i); buf = buf.slice(i + 2); const data = evt.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""); if (data) { try { const rec = JSON.parse(data); const occ = Date.parse(rec.occurred_at ?? rec.record?.occurred_at); if (!Number.isNaN(occ)) arrivals.push({ id: rec.record_id ?? rec.record?.record_id, delay_ms: Date.now() - occ }); } catch {} } } } } catch {} })();
await new Promise((r) => setTimeout(r, 1500));
const live = [];
for (let i = 0; i < 8; i++) { const before = arrivals.length; await fetch(API + "/api/entities/order/%231001/state", { headers: H }); /* served queries log query.served at INFO; health probes are not request-logged */ const t0 = Date.now(); while (arrivals.length === before && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50)); live.push(arrivals.length > before ? Math.max(0, arrivals[arrivals.length - 1].delay_ms) : 10000); await new Promise((r) => setTimeout(r, 400)); }
ctrl.abort(); await pump.catch(() => {});
out.live = { samples: live, p95_ms: pct(live, 0.95), max_ms: Math.max(...live), records_received: arrivals.length };
const storage = await (await fetch(API + "/api/diagnostics/storage", { headers: H })).json();
out.storage = storage;
console.log(JSON.stringify(out, null, 2));
