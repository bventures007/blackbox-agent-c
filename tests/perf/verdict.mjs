#!/usr/bin/env node
// Compares smoke runs (tests/perf/smoke.mjs outputs) plus restart/rebuild/restore measurements with
// benchmarks/performance-contract.json profile "smoke" and prints the per-target verdict as JSON.
//   node tests/perf/verdict.mjs --api-closed a.json --api-fixed b.json --mcp-closed c.json --mcp-fixed d.json \
//     [--restart restart.json] [--rebuild rebuild.json] [--restore restore.json] [--manifest corpus-manifest.json]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : null;
};
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const contract = JSON.parse(readFileSync(path.join(repo, "benchmarks/performance-contract.json"), "utf8"));
const T = contract.profiles.smoke.targets;
const D = contract.profiles.smoke.dataset;
const load = (k) => (opt(k) ? JSON.parse(readFileSync(opt(k), "utf8")) : null);
const runs = { api_closed: load("api-closed"), api_fixed: load("api-fixed"), mcp_closed: load("mcp-closed"), mcp_fixed: load("mcp-fixed") };
const restart = load("restart");
const rebuild = load("rebuild");
const restore = load("restore");
const manifest = load("manifest");

const verdicts = [];
function v(target, limit, observed, cmp = "<=", note) {
  const holds = observed == null ? false : cmp === "<=" ? observed <= limit : observed >= limit;
  verdicts.push({ target, limit, observed, comparator: cmp, holds, ...(note ? { note } : {}) });
}
function worst(keys, pick) {
  const vals = keys.map((k) => runs[k]).filter(Boolean).map(pick).filter((x) => x != null);
  return vals.length ? Math.max(...vals) : null;
}
function worstMin(keys, pick) {
  const vals = keys.map((k) => runs[k]).filter(Boolean).map(pick).filter((x) => x != null);
  return vals.length ? Math.min(...vals) : null;
}
const api = ["api_closed", "api_fixed"];
const mcp = ["mcp_closed", "mcp_fixed"];
const all = [...api, ...mcp];
// dataset
if (manifest) {
  v("dataset.tenants", D.tenants, manifest.totals.tenants, ">=");
  v("dataset.minimum_journal_entries", D.minimum_journal_entries, manifest.totals.journal_entries, ">=");
  v("dataset.minimum_distinct_orders", D.minimum_distinct_orders, manifest.totals.orders, ">=");
  v("dataset.order_history_entries_p95_minimum", D.order_history_entries_p95_minimum, manifest.order_history_entries.p95, ">=");
}
// per-class latency (targets apply to both load modes; the worse one is reported)
v("hot_current_state_api_p95_ms", T.hot_current_state_api_p95_ms, worst(api, (r) => r.classes.hot.p95_ms));
v("hot_current_state_api_p99_ms", T.hot_current_state_api_p99_ms, worst(api, (r) => r.classes.hot.p99_ms));
v("hot_current_state_mcp_p95_ms", T.hot_current_state_mcp_p95_ms, worst(mcp, (r) => r.classes.hot.p95_ms));
v("hot_current_state_mcp_p99_ms", T.hot_current_state_mcp_p99_ms, worst(mcp, (r) => r.classes.hot.p99_ms));
v("cold_order_state_api_p95_ms", T.cold_order_state_api_p95_ms, worst(api, (r) => r.classes.cold.p95_ms));
v("cold_order_state_mcp_p95_ms", T.cold_order_state_mcp_p95_ms, worst(mcp, (r) => r.classes.cold.p95_ms));
v("entity_history_100_entries_api_p95_ms", T.entity_history_100_entries_api_p95_ms, worst(api, (r) => r.classes.history.p95_ms));
v("entity_history_100_entries_mcp_p95_ms", T.entity_history_100_entries_mcp_p95_ms, worst(mcp, (r) => r.classes.history.p95_ms));
v("bounded_30_day_summary_api_p95_ms", T.bounded_30_day_summary_api_p95_ms, worst(api, (r) => r.classes.summary.p95_ms));
v("bounded_30_day_summary_mcp_p95_ms", T.bounded_30_day_summary_mcp_p95_ms, worst(mcp, (r) => r.classes.summary.p95_ms));
v("current_state_api_p95_ms (mixed ceiling)", T.current_state_api_p95_ms, worst(api, (r) => Math.max(r.classes.hot.p95_ms ?? 0, r.classes.cold.p95_ms ?? 0)));
v("successful_query_fraction_minimum", T.successful_query_fraction_minimum, worstMin(all, (r) => r.success_fraction), ">=");
v("durable_ack_p95_ms", T.durable_ack_p95_ms, worst(all, (r) => r.ingestion.durable_ack_p95_ms));
v("projection_lag_p95_ms", T.projection_lag_p95_ms, worst(all, (r) => r.ingestion.lag_p95_ms), "<=", "barrier wait + one point read after each durable ack");
v("engine_steady_rss_mib_maximum", T.engine_steady_rss_mib_maximum, worst(all, (r) => r.memory.engine_mib_steady_median), "<=", "docker stats container memory (cgroup, includes page cache) median over the run");
v("engine_peak_rss_mib_maximum", T.engine_peak_rss_mib_maximum, worst(all, (r) => r.memory.engine_mib_peak));
v("total_stack_peak_memory_mib_maximum", T.total_stack_peak_memory_mib_maximum, worst(all, (r) => r.memory.total_stack_mib_peak), "<=", "sum of docker stats memory of postgres+engine+api+worker+backup-scheduler");
if (restart) v("snapshot_restart_ready_seconds_maximum", T.snapshot_restart_ready_seconds_maximum, restart.ready_seconds, "<=", `tail of ${restart.unapplied_tail_entries} unapplied entries`);
if (rebuild) v("no_snapshot_rebuild_ready_seconds_maximum", T.no_snapshot_rebuild_ready_seconds_maximum, rebuild.ready_seconds);
if (restore) v("backup_restore_query_ready_seconds_maximum", T.backup_restore_query_ready_seconds_maximum, restore.machine_seconds);
const ingestionRate = worstMin(all, (r) => r.ingestion.entries_per_second);
v("load.ingested_journal_entries_per_second (achieved)", contract.profiles.smoke.load.ingested_journal_entries_per_second, ingestionRate, ">=");
const samplesOk = all.every((k) => !runs[k] || Object.values(runs[k].classes).every((c) => c.requests >= 1000));
verdicts.push({ target: "measurement_rules.min_1000_samples_per_class_transport_mode", limit: 1000, observed: Object.fromEntries(all.filter((k) => runs[k]).map((k) => [k, Object.fromEntries(Object.entries(runs[k].classes).map(([c, s]) => [c, s.requests]))])), comparator: ">=", holds: samplesOk });
const missingRuns = all.filter((k) => !runs[k]);
const status = verdicts.every((x) => x.holds) && missingRuns.length === 0 && restart && rebuild ? "passed" : "failed";
console.log(JSON.stringify({ status, missing_runs: missingRuns, verdicts }, null, 2));
