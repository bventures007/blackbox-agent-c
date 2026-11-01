#!/usr/bin/env node
// Updates reports/question-coverage.json from tests/questions/coverage.mjs state (QUERY-01/02 evidence).
//   node tests/questions/report.mjs --state reports/evidence/QUERY-01/state.json --commit <sha> \
//     --evidence-dir reports/evidence/QUERY-01 [--engine-test reports/evidence/CI-01/cargo-test-release.txt]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const state = JSON.parse(readFileSync(opt("state"), "utf8"));
const dir = opt("evidence-dir", "reports/evidence/QUERY-01");
const commit = opt("commit");
const engineTest = opt("engine-test", "reports/evidence/CI-01/cargo-test-release.txt");
const report = JSON.parse(readFileSync(path.join(repo, "reports/question-coverage.json"), "utf8"));
const byIntent = (arr) => Object.fromEntries((arr ?? []).map((r) => [r.intent, r]));
const pos = byIntent(state.positive);
const miss = byIntent(state.missing);
const asOf = byIntent(state.as_of);
const restart = Object.fromEntries((state.restart?.results ?? []).map((r) => [r.group, r]));
const GROUP_OF = (intent) => ({ inventory: "order", orders: "order", shipments: "delivery", customer: "delivery", invoices: "invoice", receivables: "collection", payments: "collection", providers: "settlement", payouts: "settlement", returns: "reversal", credits: "reversal", cancellations: "reversal", refunds: "reversal" })[intent.split(".")[0]];
const contracts = JSON.parse(readFileSync(path.join(repo, "specs/question-data-contracts.json"), "utf8")).questions;
const intentOf = Object.fromEntries(contracts.map((q) => [q.id, q.intent]));
const st = (r) => (r == null ? "not_run" : r.passed ? "passed" : "failed");
let passedPos = 0, passedMiss = 0, parity = 0, restartOk = 0;
for (const q of report.questions) {
  const intent = intentOf[q.id];
  const p = pos[intent];
  const m = miss[intent];
  const a = asOf[intent];
  const rg = restart[GROUP_OF(intent)];
  q.implementation = "implemented";
  q.positive_path_test = st(p);
  q.missing_data_test = st(m);
  q.api_mcp_parity_test = p == null ? "not_run" : p.api_mcp_parity && (m == null || m.api_mcp_parity) ? "passed" : "failed";
  q.restart_cold_path_test = a == null ? "not_run" : rg && rg.intent === intent ? (rg.identical_to_pre_restart ? "passed" : "failed") : a.passed ? "passed_as_of_same_group_restart_checked" : "failed";
  q.tested_commit = commit;
  q.evidence_paths = [`${dir}/positive-${intent}.json`, `${dir}/missing-${intent}.json`, `${dir}/asof-${intent}.json`, `${dir}/state.json`, engineTest];
  q.observed = { positive: p ? { api_status: p.api_status, status: p.status, checks: p.checks, entry_ids: p.entry_ids, evidence_refs: p.evidence_refs, consistency: p.consistency?.status } : null, missing: m ? { api_status: m.api_status, status: m.status, missing_inputs: m.missing_inputs, checks: m.checks } : null, as_of: a ? { status: a.status, passed: a.passed, parity: a.api_mcp_parity } : null, restart: rg && rg.intent === intent ? rg : null };
  q.live_verification = "not_verified";
  if (p?.passed) passedPos++;
  if (m?.passed) passedMiss++;
  if (q.api_mcp_parity_test === "passed") parity++;
  if (rg && rg.intent === intent && rg.identical_to_pre_restart) restartOk++;
}
report.version = "1.1";
report.reviewed_date = new Date().toISOString().slice(0, 10);
report.review_kind = "installed_stack_run";
report.product_tests_run = true;
report.run = { api: state.api, started_at: state.started_at, finished_at: state.finished_at, tested_commit: commit, cutoff: state.cutoff, ingest: state.ingest, restart: state.restart?.at ?? null, note: "Positive scenario ported from apps/engine/tests/intents_http.rs into the owner workspace (ids suffixed -Q next to the labeled GOLDEN demo and perf ingestion data); missing-data cases on a sparse synthetic workspace queried through its own read-only agent key; API and stdio MCP bridge (official SDK client) compared on normalized envelopes; one as_of query per group re-run after ./blackbox down && ./blackbox up." };
report.counts = { ...report.counts, positive_passed: passedPos, missing_passed: passedMiss, parity_passed: parity, restart_groups_identical: restartOk, total: report.questions.length };
writeFileSync(path.join(repo, "reports/question-coverage.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report.counts));
