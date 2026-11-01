#!/usr/bin/env node
// Writes the smoke profile section of reports/performance.json from the run outputs and the verdict.
//   node tests/perf/report.mjs --runs-dir reports/evidence/PILOT-09 --verdict reports/evidence/PILOT-09/verdict.json \
//     --manifest reports/evidence/PILOT-09/corpus-manifest.json --commit <sha> --environment "<text>" \
//     --limitations-file <text file, one per line> --commands-file <text file, one per line>
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runsDir = opt("runs-dir", "reports/evidence/PILOT-09");
const verdict = JSON.parse(readFileSync(opt("verdict"), "utf8"));
const manifest = JSON.parse(readFileSync(opt("manifest"), "utf8"));
const lines = (f) => (f && existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const report = JSON.parse(readFileSync(path.join(repo, "reports/performance.json"), "utf8"));
const runs = {};
for (const f of readdirSync(path.join(repo, runsDir))) if (/^run-.*\.json$/.test(f)) runs[f.replace(/^run-|\.json$/g, "")] = JSON.parse(readFileSync(path.join(repo, runsDir, f), "utf8"));
const measurements = {
  runs: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { transport: r.transport, mode: r.mode, duration_s: r.config.duration_s, clients: r.config.clients, fixed_rate_rps: r.config.fixed_rate_rps, achieved_rps: r.achieved_rps, requests_total: r.requests_total, success_fraction: r.success_fraction, classes: Object.fromEntries(Object.entries(r.classes).map(([c, s]) => [c, { requests: s.requests, success_fraction: s.success_fraction, p50_ms: s.p50_ms, p95_ms: s.p95_ms, p99_ms: s.p99_ms, max_ms: s.max_ms, errors: s.errors }])), ingestion: { entries_per_second: r.ingestion.entries_per_second, durable_ack_p50_ms: r.ingestion.durable_ack_p50_ms, durable_ack_p95_ms: r.ingestion.durable_ack_p95_ms, lag_p50_ms: r.ingestion.lag_p50_ms, lag_p95_ms: r.ingestion.lag_p95_ms, lag_max_ms: r.ingestion.lag_max_ms, errors: r.ingestion.errors }, memory: { engine_mib_steady_median: r.memory.engine_mib_steady_median, engine_mib_peak: r.memory.engine_mib_peak, total_stack_mib_peak: r.memory.total_stack_mib_peak, per_container_peak_mib: r.memory.per_container_peak_mib, engine_rss_bytes_last: r.memory.last_engine_card?.details?.rss_bytes ?? null }, mode_info: r.mode_info, warmup: r.warmup }])),
  recovery: { restart: existsSync(path.join(repo, runsDir, "restart.json")) ? JSON.parse(readFileSync(path.join(repo, runsDir, "restart.json"), "utf8")) : null, rebuild: existsSync(path.join(repo, runsDir, "rebuild.json")) ? JSON.parse(readFileSync(path.join(repo, runsDir, "rebuild.json"), "utf8")) : null, restore: existsSync(path.join(repo, runsDir, "restore.json")) ? JSON.parse(readFileSync(path.join(repo, runsDir, "restore.json"), "utf8")) : null },
  verdicts: verdict.verdicts,
  dataset: { tenants: manifest.totals.tenants, orders: manifest.totals.orders, journal_entries: manifest.totals.journal_entries, largest_tenant_order_fraction: manifest.totals.largest_tenant_order_fraction, order_history_entries: manifest.order_history_entries, hot_set: manifest.hot_set.length, cold_sample: manifest.cold_sample.length, reconstructed: manifest.reconstructed ?? false, requirements_met: manifest.requirements.met },
};
report.profiles.smoke = {
  status: verdict.status,
  tested_commit: opt("commit"),
  environment: opt("environment"),
  commands: lines(opt("commands-file")),
  dataset_manifest: opt("manifest"),
  measurements,
  evidence_paths: [opt("manifest"), ...Object.keys(runs).map((k) => `${runsDir}/run-${k}.json`), `${runsDir}/verdict.json`, ...["restart.json", "rebuild.json", "restore.json", "corpus-generation.txt"].filter((f) => existsSync(path.join(repo, runsDir, f))).map((f) => `${runsDir}/${f}`)],
  limitations: lines(opt("limitations-file")),
  delivery_scope: "local_pilot",
  measured_at: new Date().toISOString(),
};
report.note = "Smoke profile measured by the ops verifier on 2026-11-01 (see profiles.smoke); reference_10m and scale_100m remain deferred and unmeasured.";
writeFileSync(path.join(repo, "reports/performance.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status: verdict.status, runs: Object.keys(runs), failing: verdict.verdicts.filter((v) => !v.holds).map((v) => v.target) }));
