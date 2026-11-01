#!/usr/bin/env node
// DIAG-07 helper: writes a synthetic, contract-shaped technical log corpus into a LOGS_DIR so the
// retained store approaches the 100 MiB cap (hour files records-YYYYMMDD-HH-synthetic.jsonl spread
// over the last N days, mixed components/levels/event names, workspace scope with the real tenant
// id, opaque ids only). The api collector enforces the cap/age on restart and on every write; the
// query path and the diagnostics view read these files like any other retained records.
//   node tests/diag/log-corpus.mjs --dir <LOGS_DIR> --total-mib 96 --days 6 --tenant <uuid> --version 0.1.0-rc6b
import { appendFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const DIR = opt("dir");
const TOTAL = Number(opt("total-mib", "96")) * 1024 * 1024;
const DAYS = Number(opt("days", "6"));
const TENANT = opt("tenant");
const VERSION = opt("version", "0.1.0-rc6b");
mkdirSync(DIR, { recursive: true });
const components = ["api", "worker", "engine", "ingestion", "auth", "mcp"];
const events = {
  INFO: ["journal.batch_committed", "engine.batch_applied", "query.served", "source.run_completed", "scheduler.tick", "outbox.dispatched", "auth.session_created", "import.page_processed"],
  WARN: ["source.rate_limited", "engine.sqlx.query", "auth.access_denied", "source.run_retry", "storage.warning"],
  ERROR: ["source.run_failed", "outbox.dispatch.failed", "engine.snapshot_rejected", "worker.job_failed"],
  DEBUG: ["import.page_debug", "engine.tail_poll"],
};
const levels = ["INFO", "INFO", "INFO", "INFO", "INFO", "INFO", "WARN", "WARN", "ERROR", "DEBUG"];
const conns = Array.from({ length: 6 }, () => randomUUID());
const runs = Array.from({ length: 40 }, () => randomUUID());
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const hours = DAYS * 24;
const perHour = Math.floor(TOTAL / hours);
const now = Date.now();
let written = 0;
let files = 0;
let records = 0;
for (let h = hours; h >= 1; h--) {
  const hourStart = Math.floor((now - h * 3600_000) / 3600_000) * 3600_000;
  const d = new Date(hourStart);
  const name = `records-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}-synthetic.jsonl`;
  const file = path.join(DIR, name);
  if (existsSync(file)) continue;
  let bytes = 0;
  const lines = [];
  while (bytes < perHour) {
    const level = pick(levels);
    const component = pick(components);
    const t = new Date(hourStart + Math.floor(rnd() * 3600_000)).toISOString();
    const rec = { schema_version: 1, record_id: randomUUID(), occurred_at: t, observed_at: t, level, event_name: pick(events[level]), message: `Synthetic ${level.toLowerCase()} record for DIAG-07 load (${component})`, component, service_version: VERSION, instance_id: `${component}-synthetic-${h % 3}`, scope: rnd() < 0.85 ? "workspace" : "installation" };
    if (rec.scope === "workspace") {
      rec.tenant_id = TENANT;
      if (rnd() < 0.7) rec.connection_id = pick(conns);
      if (rnd() < 0.5) rec.run_id = pick(runs);
      if (rnd() < 0.3) rec.trace_id = randomUUID();
    }
    if (rnd() < 0.5) rec.duration_ms = Math.floor(rnd() * 900);
    if (rnd() < 0.4) rec.record_count = Math.floor(rnd() * 500);
    if (level === "ERROR" || level === "WARN") {
      rec.error_code = pick(["provider_unavailable", "throttled", "unexpected", "unauthenticated", "snapshot_invalid"]);
      rec.retryable = rnd() < 0.6;
    }
    if (rnd() < 0.2) rec.committed_cursor = Math.floor(rnd() * 400000);
    const line = JSON.stringify(rec) + "\n";
    lines.push(line);
    bytes += Buffer.byteLength(line);
  }
  appendFileSync(file, lines.join(""));
  written += bytes;
  files += 1;
  records += lines.length;
}
console.log(JSON.stringify({ dir: DIR, files, records, bytes_written: written, mib: Number((written / 1048576).toFixed(1)) }));
