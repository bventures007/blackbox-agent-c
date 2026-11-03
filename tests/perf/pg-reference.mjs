#!/usr/bin/env node
// PERF-01 diagnostic comparison: an INDEXED SQL reference read path for the order state keys
// physical_stock / available_stock / captured_minor / fees_minor / refunded_minor / bank_confirmed_minor,
// compared against the API (which serves the Rust engine's RAM state), plus full-request latency
// of both paths. This script is a DIAGNOSTIC COMPARISON ONLY: it is not a second implementation of
// the business rules. It sums the journal's typed payload fields under the documented effect-once
// rule (docs/engine.md "Reducer semantics": one effect per (event family, observation key), the
// first entry of the observation carries it, a superseded carrier is reverted, snapshot-type
// stock assertions never regress, movements count only after the basis). Anything beyond those
// documented rules (currency conflicts, bank.match_recorded, provider ledger fees, reservation
// revisions) is out of scope and would show up as a mismatch, never be papered over.
//
//   node tests/perf/pg-reference.mjs --pools ~/blackbox-perf-keys/pools.json \
//     --pg-port 19187 --pg-password-file ~/blackbox-pilot-ops2/secrets/pg_engine_password \
//     --api http://127.0.0.1:19185 --compare 200 --hot 1000 --cold 200 --out reports/evidence/PERF-01/reference.json
//
// Secrets (agent key, database password) are read from files and never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import pg from "pg";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const POOLS = JSON.parse(readFileSync(opt("pools"), "utf8"));
const API = opt("api", POOLS.api);
const COMPARE = Number(opt("compare", "200"));
const HOT = Number(opt("hot", "1000"));
const COLD = Number(opt("cold", "200"));
const OUT = opt("out");
const EXPLAIN = argv.includes("--explain");
const TENANT_INDEX = Number(opt("tenant-index", "0"));
const client = POOLS.clients.find((c) => c.tenant_index === TENANT_INDEX);
const TENANT = client.tenant_id;
const KEY = readFileSync(client.key_file, "utf8").trim();
const pool = POOLS.pools[TENANT];
const db = new pg.Pool({
  host: opt("pg-host", "127.0.0.1"),
  port: Number(opt("pg-port", "19187")),
  user: opt("pg-user", "bb_engine"),
  password: readFileSync(opt("pg-password-file"), "utf8").trim(),
  database: opt("pg-database", "blackbox"),
  max: 4,
});

let seed = 0x2545f491;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)].toFixed(1));
};

// ---- the reference SQL -------------------------------------------------------------------------------
// Effect carriers of one entity: entries referencing the entity (GIN entity_refs), keyed by the
// observation key (correlation_id | connection:provider_event_id for source entries | the first
// input entry's own key | entry_id), first entry per (event_type, key) carries the effect, carriers
// superseded by a later entry are reverted (dropped), optional recorded-time cutoff for as_of.
const EFFECTIVE = (refKey) => `
WITH e AS (
  SELECT entry_id, journal_sequence, track::text AS track, event_type, occurred_at, recorded_at, payload, entity_refs,
         correlation_id, provider_event_id, connection_id, input_entry_ids
    FROM journal_entries
   WHERE tenant_id = $1 AND entity_refs @> jsonb_build_object('${refKey}', $2::text)
     AND ($3::timestamptz IS NULL OR recorded_at <= $3)
), keyed AS (
  SELECT e.*, COALESCE(
      NULLIF(e.correlation_id, ''),
      CASE WHEN e.track = 'source' AND NULLIF(e.provider_event_id, '') IS NOT NULL THEN COALESCE(e.connection_id::text, '-') || ':' || e.provider_event_id END,
      (SELECT COALESCE(NULLIF(i.correlation_id, ''),
                       CASE WHEN i.track = 'source' AND NULLIF(i.provider_event_id, '') IS NOT NULL THEN COALESCE(i.connection_id::text, '-') || ':' || i.provider_event_id END,
                       i.entry_id::text)
         FROM journal_entries i WHERE i.tenant_id = $1 AND i.entry_id = e.input_entry_ids[1]),
      e.entry_id::text) AS obs
    FROM e
), carriers AS (
  SELECT DISTINCT ON (event_type, obs) * FROM keyed ORDER BY event_type, obs, journal_sequence
), effective AS (
  SELECT c.* FROM carriers c
   WHERE NOT EXISTS (SELECT 1 FROM journal_entries s WHERE s.tenant_id = $1 AND s.supersedes_entry_id = c.entry_id AND ($3::timestamptz IS NULL OR s.recorded_at <= $3))
)`;

const ORDER_SQL = `${EFFECTIVE("order")}
SELECT
  (SELECT COALESCE(SUM(COALESCE((payload->>'captured_minor')::bigint, (payload->>'amount_minor')::bigint, 0)), 0) FROM effective WHERE event_type = 'payment.captured') AS captured_minor,
  (SELECT COALESCE(SUM(COALESCE((payload->>'fee_minor')::bigint, 0)), 0) FROM effective WHERE event_type = 'payment.fee_booked') AS fees_minor,
  (SELECT COALESCE(SUM(amount), 0) FROM (
      SELECT DISTINCT ON (payload->>'refund') COALESCE((payload->>'amount_minor')::bigint,
             (SELECT (p.payload->>'amount_minor')::bigint FROM effective p WHERE p.event_type = 'refund.pending' AND p.payload->>'refund' = f.payload->>'refund' ORDER BY p.journal_sequence LIMIT 1), 0) AS amount
        FROM effective f WHERE event_type = 'refund.completed' ORDER BY payload->>'refund', journal_sequence) r) AS refunded_minor,
  (SELECT COALESCE(SUM(b.amount), 0) FROM (
      SELECT DISTINCT ON (payload->>'bank_entry') (payload->>'amount_minor')::bigint AS amount, payload->>'payout' AS payout, payload->>'currency' AS cur
        FROM effective WHERE event_type = 'bank.credit_booked' AND COALESCE(payload->>'status', payload->>'booking_status', 'booked') NOT IN ('pending', 'PENDING')
       ORDER BY payload->>'bank_entry', journal_sequence) b
     WHERE EXISTS (SELECT 1 FROM effective p WHERE p.event_type = 'payout.sent' AND p.payload->>'payout' = b.payout AND (p.payload->>'currency' IS NULL OR b.cur IS NULL OR p.payload->>'currency' = b.cur))
       AND NOT EXISTS (SELECT 1 FROM effective p WHERE p.event_type = 'payout.reversed' AND p.payload->>'payout' = b.payout)) AS bank_confirmed_minor,
  (SELECT COALESCE(array_agg(DISTINCT entity_refs->>'item') FILTER (WHERE entity_refs->>'item' IS NOT NULL), '{}') FROM e) AS items,
  (SELECT count(*) FROM e) AS entries_read`;

// Item stock under the documented basis rule: the effective basis is the inventory.snapshot with the
// greatest occurred_at (ties: the later sequence); movements count only with sequence after the
// basis entry and occurred_at after the basis time; reservations are active only when recorded with
// occurred_at after the basis known at their application, net of releases.
const ITEM_SQL = `${EFFECTIVE("item")}
, basis AS (
  SELECT journal_sequence, occurred_at,
         COALESCE((payload->>'physical')::numeric, 0) AS physical,
         COALESCE((payload->>'quarantined')::numeric, (payload->>'quality_control')::numeric, 0) AS quarantined,
         CASE WHEN payload ? 'quarantined' THEN COALESCE((payload->>'quality_control')::numeric, 0) ELSE 0 END AS qc,
         COALESCE((payload->>'reserved')::numeric, 0) AS snapshot_reserved,
         COALESCE((payload->>'committed')::numeric, 0) AS committed,
         COALESCE((payload->>'damaged')::numeric, 0) AS damaged,
         COALESCE((payload->>'safety_stock')::numeric, 0) AS safety,
         COALESCE((payload->>'available')::numeric, (payload->>'provider_available')::numeric) AS provider_available
    FROM effective WHERE event_type = 'inventory.snapshot' ORDER BY occurred_at DESC, journal_sequence DESC LIMIT 1
), moves AS (
  SELECT m.journal_sequence, m.occurred_at,
         CASE m.event_type
           WHEN 'shipment.dispatched' THEN COALESCE((m.payload->>'physical_stock_delta')::numeric, 0)
           WHEN 'return.received' THEN COALESCE((m.payload->>'physical_stock_delta')::numeric, (m.payload->>'quantity')::numeric, 0)
           WHEN 'return.restocked' THEN COALESCE((m.payload->>'physical_stock_delta')::numeric, 0)
           WHEN 'inventory.adjustment_observed' THEN COALESCE((m.payload->>'physical_delta')::numeric, 0) ELSE 0 END AS physical_delta,
         CASE m.event_type
           WHEN 'shipment.dispatched' THEN 0
           WHEN 'return.received' THEN COALESCE((m.payload->>'quarantine_delta')::numeric, (m.payload->>'quantity')::numeric, 0)
           WHEN 'return.restocked' THEN COALESCE((m.payload->>'quarantine_delta')::numeric, -(m.payload->>'quantity')::numeric, 0)
           WHEN 'inventory.adjustment_observed' THEN COALESCE((m.payload->>'quarantine_delta')::numeric, 0) ELSE 0 END AS quarantine_delta
    FROM effective m, basis b
   WHERE m.event_type IN ('shipment.dispatched', 'return.received', 'return.restocked', 'inventory.adjustment_observed')
     AND m.journal_sequence > b.journal_sequence AND m.occurred_at > b.occurred_at
     AND (m.event_type <> 'shipment.dispatched' OR m.payload ? 'physical_stock_delta')
), reservations AS (
  SELECT r.payload->>'reservation' AS reservation, r.journal_sequence, r.occurred_at, COALESCE((r.payload->>'quantity')::numeric, 0) AS qty,
         (SELECT max(s.occurred_at) FROM effective s WHERE s.event_type = 'inventory.snapshot' AND s.journal_sequence < r.journal_sequence) AS basis_at
    FROM (SELECT DISTINCT ON (payload->>'reservation') * FROM effective WHERE event_type = 'inventory.reserved' ORDER BY payload->>'reservation', journal_sequence) r
), reserved_active AS (
  SELECT COALESCE(SUM(GREATEST(0, r.qty - LEAST(r.qty, COALESCE((
      SELECT SUM(CASE x.event_type WHEN 'shipment.dispatched' THEN COALESCE((x.payload->>'reservation_released')::numeric, (x.payload->>'quantity')::numeric, 0)
                                   ELSE COALESCE((x.payload->>'quantity')::numeric, 0) END)
        FROM effective x WHERE x.event_type IN ('shipment.dispatched', 'inventory.reservation_released') AND x.payload->>'reservation' = r.reservation AND x.journal_sequence > r.journal_sequence), 0)))), 0) AS qty
    FROM reservations r WHERE r.basis_at IS NULL OR r.occurred_at > r.basis_at
)
SELECT b.physical + COALESCE((SELECT SUM(physical_delta) FROM moves), 0) AS physical,
       b.quarantined + COALESCE((SELECT SUM(quarantine_delta) FROM moves), 0) AS quarantined,
       COALESCE(b.provider_available, b.physical + COALESCE((SELECT SUM(physical_delta) FROM moves), 0) - (b.quarantined + COALESCE((SELECT SUM(quarantine_delta) FROM moves), 0)) - b.committed - b.damaged - b.safety - b.qc - b.snapshot_reserved)
         - (SELECT qty FROM reserved_active) AS available,
       (SELECT count(*) FROM e) AS entries_read
  FROM basis b`;

async function referenceOrder(orderId, cutoff = null) {
  const t0 = performance.now();
  const r = await db.query(ORDER_SQL, [TENANT, orderId, cutoff]);
  const row = r.rows[0];
  let physical = null;
  let available = null;
  let itemEntries = 0;
  for (const item of row.items ?? []) {
    const ir = await db.query(ITEM_SQL, [TENANT, item, cutoff]);
    const x = ir.rows[0];
    if (!x) continue; // no basis → unknown stock
    physical = (physical ?? 0) + Number(x.physical);
    available = (available ?? 0) + Number(x.available);
    itemEntries += Number(x.entries_read);
  }
  const ms = performance.now() - t0;
  return {
    ms,
    entries_read: Number(row.entries_read) + itemEntries,
    state: {
      physical_stock: physical === null ? null : String(physical),
      available_stock: available === null ? null : String(available),
      captured_minor: Number(row.captured_minor),
      fees_minor: Number(row.fees_minor),
      refunded_minor: Number(row.refunded_minor),
      bank_confirmed_minor: Number(row.bank_confirmed_minor),
    },
  };
}

async function apiOrder(orderId, cutoff = null) {
  const url = `${API}/api/entities/order/${encodeURIComponent(orderId)}/state${cutoff ? `?mode=as_of&as_of_recorded=${encodeURIComponent(cutoff)}` : ""}`;
  const t0 = performance.now();
  const res = await fetch(url, { headers: { authorization: `Bearer ${KEY}` } });
  const json = await res.json().catch(() => null);
  const ms = performance.now() - t0;
  if (res.status !== 200 || !json?.state) return { ms, status: res.status, error: json?.error?.code ?? `http_${res.status}`, message: json?.error?.message ?? null, state: null };
  const s = json.state;
  const num = (v) => (v === null || v === undefined ? null : String(Number(v)));
  return { ms, status: res.status, consistency: json.consistency?.status, state: { physical_stock: num(s.physical_stock), available_stock: num(s.available_stock), captured_minor: s.captured_minor, fees_minor: s.fees_minor, refunded_minor: s.refunded_minor, bank_confirmed_minor: s.bank_confirmed_minor } };
}

function same(a, b) {
  const keys = ["physical_stock", "available_stock", "captured_minor", "fees_minor", "refunded_minor", "bank_confirmed_minor"];
  const diff = keys.filter((k) => String(a[k]) !== String(b[k]));
  return { ok: diff.length === 0, diff };
}

async function main() {
  const out = { generated_at: new Date().toISOString(), api: API, tenant_id: TENANT, note: "diagnostic comparison; the Rust engine is the only implementation of the business rules (docs/engine.md)" };
  if (EXPLAIN) {
    const o = pool.hot[0];
    const plan = await db.query(`EXPLAIN (ANALYZE, BUFFERS) ${ORDER_SQL}`, [TENANT, o, null]);
    const items = (await db.query(ORDER_SQL, [TENANT, o, null])).rows[0].items;
    const iplan = await db.query(`EXPLAIN (ANALYZE, BUFFERS) ${ITEM_SQL}`, [TENANT, items[0], null]);
    out.explain = { order: o, order_plan: plan.rows.map((r) => r["QUERY PLAN"]), item: items[0], item_plan: iplan.rows.map((r) => r["QUERY PLAN"]) };
    console.log(out.explain.order_plan.join("\n"));
    console.log(out.explain.item_plan.join("\n"));
  }
  // ---- correctness comparison on random hot orders (plus a cold as_of sample) ----
  const sample = [];
  const all = pool.hot.concat(pool.cold ?? []);
  const seen = new Set();
  while (sample.length < COMPARE && seen.size < all.length) {
    const o = pick(all);
    if (seen.has(o)) continue;
    seen.add(o);
    sample.push(o);
  }
  const mismatches = [];
  let matched = 0;
  const apiErrors = {};
  for (const o of sample) {
    const a = await apiOrder(o);
    if (!a.state) {
      apiErrors[a.error] = (apiErrors[a.error] ?? 0) + 1;
      continue;
    }
    const r = await referenceOrder(o);
    const c = same(a.state, r.state);
    if (c.ok) matched += 1;
    else mismatches.push({ order: o, diff: c.diff, api: a.state, reference: r.state });
  }
  out.compare = { orders: sample.length, matched, mismatched: mismatches.length, api_errors: apiErrors, mismatches: mismatches.slice(0, 25) };
  console.log(JSON.stringify({ compare: { orders: sample.length, matched, mismatched: mismatches.length, api_errors: apiErrors } }));
  for (const m of mismatches.slice(0, 5)) console.log("MISMATCH", JSON.stringify(m));
  // cold comparison: cutoff at a recorded time inside the corpus history (as_of replay vs SQL cutoff)
  const cutoffRow = await db.query("SELECT recorded_at FROM journal_entries WHERE tenant_id = $1 ORDER BY journal_sequence OFFSET (SELECT (count(*) * 0.7)::bigint FROM journal_entries WHERE tenant_id = $1) LIMIT 1", [TENANT]);
  const cutoff = cutoffRow.rows[0]?.recorded_at?.toISOString() ?? null;
  const coldSample = sample.slice(0, Math.min(50, sample.length));
  let coldMatched = 0;
  const coldMism = [];
  const coldErrors = {};
  for (const o of coldSample) {
    const a = await apiOrder(o, cutoff);
    if (!a.state) {
      coldErrors[a.error] = (coldErrors[a.error] ?? 0) + 1;
      if (!out.cold_error_sample) out.cold_error_sample = { order: o, code: a.error, message: a.message };
      continue;
    }
    const r = await referenceOrder(o, cutoff);
    const c = same(a.state, r.state);
    if (c.ok) coldMatched += 1;
    else coldMism.push({ order: o, diff: c.diff, api: a.state, reference: r.state });
  }
  out.compare_cold = { cutoff, orders: coldSample.length, matched: coldMatched, mismatched: coldMism.length, api_errors: coldErrors, mismatches: coldMism.slice(0, 10) };
  console.log(JSON.stringify({ compare_cold: { cutoff, orders: coldSample.length, matched: coldMatched, mismatched: coldMism.length, api_errors: coldErrors } }));

  // ---- latency: full request, sequential single client, warm ----
  const lat = { hot_api: [], hot_sql: [], cold_api: [], cold_sql: [] };
  const errs = { hot_api: {}, cold_api: {} };
  const entriesRead = { hot_sql: [], cold_sql: [] };
  for (let i = 0; i < 20; i++) await apiOrder(pick(pool.hot)); // warm-up
  for (let i = 0; i < HOT; i++) {
    const o = pick(pool.hot);
    const a = await apiOrder(o);
    lat.hot_api.push(a.ms);
    if (!a.state) errs.hot_api[a.error] = (errs.hot_api[a.error] ?? 0) + 1;
    const r = await referenceOrder(o);
    lat.hot_sql.push(r.ms);
    entriesRead.hot_sql.push(r.entries_read);
  }
  const cutoffs = Array.from({ length: 600 }, (_, i) => new Date(Date.now() - (i + 1) * 1000).toISOString());
  for (let i = 0; i < COLD; i++) {
    const o = pick(pool.cold ?? pool.hot);
    const cut = pick(cutoffs);
    const a = await apiOrder(o, cut);
    lat.cold_api.push(a.ms);
    if (!a.state) errs.cold_api[a.error] = (errs.cold_api[a.error] ?? 0) + 1;
    const r = await referenceOrder(o, cut);
    lat.cold_sql.push(r.ms);
    entriesRead.cold_sql.push(r.entries_read);
  }
  const summarize = (arr) => ({ n: arr.length, p50_ms: pct(arr, 0.5), p95_ms: pct(arr, 0.95), p99_ms: pct(arr, 0.99), max_ms: pct(arr, 1) });
  out.latency = {
    method: "sequential single client on the host; full request latency (API: HTTP → Fastify auth → engine RPC → readiness memo; SQL: node pg over the loopback proxy → PostgreSQL), warm",
    hot: { requests: HOT, api_via_engine: summarize(lat.hot_api), reference_sql: summarize(lat.hot_sql), api_errors: errs.hot_api, sql_entries_read: { p50: pct(entriesRead.hot_sql, 0.5), p95: pct(entriesRead.hot_sql, 0.95), max: pct(entriesRead.hot_sql, 1) } },
    cold: { requests: COLD, api_as_of_via_engine: summarize(lat.cold_api), reference_sql_cutoff: summarize(lat.cold_sql), api_errors: errs.cold_api, sql_entries_read: { p50: pct(entriesRead.cold_sql, 0.5), p95: pct(entriesRead.cold_sql, 0.95), max: pct(entriesRead.cold_sql, 1) } },
  };
  console.log(JSON.stringify(out.latency, null, 1));
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
