#!/usr/bin/env node
// Reconstructs the smoke-corpus dataset manifest from the database when the corpus generator was
// stopped before writing it (the generator only writes the manifest at the end). Labeled as a
// reconstruction: counts are read from journal_entries/tenants, the hot set (2000 orders of the
// largest tenant) and the cold sample are drawn deterministically (sha256 order of ids) instead of
// the generator's RNG. Orphan tenants of an earlier aborted run are listed but excluded.
//
//   DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:19186/blackbox node tests/perf/manifest-from-db.mjs \
//     --out reports/evidence/PILOT-09/corpus-manifest.json --since 2026-11-01T12:22:00Z --seed 42
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = opt("out");
const SINCE = opt("since");
const SEED = Number(opt("seed", "42"));
const HOT = Number(opt("hot-orders", "2000"));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const tenants = (await client.query("SELECT tenant_id, display_name, created_at FROM tenants WHERE display_name LIKE 'Corpus tenant %' ORDER BY created_at")).rows;
const orphans = tenants.filter((t) => SINCE && new Date(t.created_at) < new Date(SINCE));
const live = tenants.filter((t) => !orphans.includes(t));
const stats = (await client.query(`SELECT tenant_id, count(*)::bigint AS entries, max(journal_sequence)::bigint AS last_sequence FROM journal_entries WHERE tenant_id = ANY($1::uuid[]) GROUP BY tenant_id`, [live.map((t) => t.tenant_id)])).rows;
const perOrder = (await client.query(`SELECT tenant_id, entity_refs->>'order' AS order_id, count(*)::int AS n FROM journal_entries WHERE tenant_id = ANY($1::uuid[]) AND entity_refs ? 'order' GROUP BY tenant_id, entity_refs->>'order'`, [live.map((t) => t.tenant_id)])).rows;
await client.end();
const byTenant = Object.fromEntries(stats.map((s) => [s.tenant_id, s]));
const ordersOf = {};
for (const r of perOrder) (ordersOf[r.tenant_id] ??= []).push(r.order_id);
const h = (s) => createHash("sha256").update(`${SEED}:${s}`).digest("hex");
const manifestTenants = live.map((t, i) => ({ tenant_id: t.tenant_id, display_name: t.display_name, index: Number(/tenant (\d+)/.exec(t.display_name)?.[1] ?? i), orders: (ordersOf[t.tenant_id] ?? []).length, entries: Number(byTenant[t.tenant_id]?.entries ?? 0), last_sequence: Number(byTenant[t.tenant_id]?.last_sequence ?? 0) })).sort((a, b) => a.index - b.index);
const largest = manifestTenants.reduce((a, b) => (b.orders > a.orders ? b : a), manifestTenants[0]);
const lens = perOrder.map((r) => r.n).sort((a, b) => a - b);
const pct = (p) => lens[Math.max(0, Math.min(lens.length - 1, Math.ceil(lens.length * p) - 1))];
const t0ids = [...(ordersOf[largest.tenant_id] ?? [])].sort((a, b) => h(a).localeCompare(h(b)));
const hot = t0ids.slice(0, HOT);
let cold = t0ids.slice(HOT, HOT + 500).map((o) => ({ tenant_id: largest.tenant_id, order_id: o }));
for (const t of manifestTenants) if (t.tenant_id !== largest.tenant_id && cold.length < 1000) cold = cold.concat([...(ordersOf[t.tenant_id] ?? [])].sort((a, b) => h(a).localeCompare(h(b))).slice(0, 10).map((o) => ({ tenant_id: t.tenant_id, order_id: o })));
const totals = { tenants: manifestTenants.length, orders: manifestTenants.reduce((a, t) => a + t.orders, 0), journal_entries: manifestTenants.reduce((a, t) => a + t.entries, 0) };
totals.largest_tenant_order_fraction = Number((largest.orders / totals.orders).toFixed(4));
const manifest = {
  generator: "corpus-v2 (generator stopped before completion; manifest reconstructed from the database by tests/perf/manifest-from-db.mjs)",
  seed: SEED,
  generated_at: new Date().toISOString(),
  reconstructed: true,
  source_fixture: "GOLDEN-ORDER-TO-CASH.json (mutated per order; payload shapes unchanged)",
  derived_entries: true,
  tenants: manifestTenants,
  orphan_tenants_excluded: orphans.map((t) => ({ tenant_id: t.tenant_id, display_name: t.display_name, created_at: t.created_at })),
  totals,
  order_history_entries: { p50: pct(0.5), p95: pct(0.95), max: lens.at(-1) ?? 0, min: lens[0] ?? 0 },
  features: { five_tracks: true, late_corrections: "5% fee corrections (supersedes_entry_id) + 8% late failed attempts for completed tenants; the largest tenant's late corrections were not appended (generator stopped)", high_cardinality: "random order/customer/SKU/tracking identifiers", currencies: ["EUR", "EUR", "EUR", "USD", "CHF", "GBP"], short_histories: "25% stop after delivery, 15% after restock" },
  hot_set: hot.map((o) => ({ tenant_id: largest.tenant_id, order_id: o })),
  cold_sample: cold,
  requirements: { minimum_journal_entries: 250000, minimum_distinct_orders: 10000, met: totals.journal_entries >= 250000 && totals.orders >= 10000 && pct(0.95) >= 50 && manifestTenants.length >= 50 && totals.largest_tenant_order_fraction >= 0.5 - 1e-9 },
};
writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ totals, p95: pct(0.95), largest: { index: largest.index, orders: largest.orders, entries: largest.entries }, hot: hot.length, cold: cold.length, orphans: orphans.length, met: manifest.requirements.met }));
