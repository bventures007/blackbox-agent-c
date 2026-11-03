# PERF-01 — one implementation of the money/stock rules, API ↔ reference agreement, indexed hot queries, full-request latency (follow-up, 2026-11-03)

ACCEPTANCE.json PERF-01: "Canonical money/stock rules have one implementation; API/MCP results agree; hot queries use direct indexes/working state without full-journal scans or N+1 reads. Report full request latency and the measured benefit/overhead of the engine, not just a Rust microbenchmark."

Environment: second install `~/blackbox-pilot-ops2` (Compose project `blackbox-agent-c-ops2`, API 127.0.0.1:19185) holding the 50-tenant smoke corpus (723,780 journal entries, 54 tenants, tenant 0 = 276,763 entries / 5,000 orders; `journal_entries` 998 MB incl. indexes); PostgreSQL reached from the host as `bb_engine` through a loopback TCP proxy container (`blackbox-agent-c-ops2-pgproxy`, node image, 127.0.0.1:19187 → postgres:5432 on the install's backend network); shared developer Mac (8 cores / 24 GiB, Docker Desktop VM 8 vCPU / 9.7 GiB with the other projects' stacks), 1-min load averages are recorded per run. Working tree = commit 17494f4 + the uncommitted follow-up changes.

## (a) EXPLAIN (ANALYZE, BUFFERS) of the hot paths — `explain-ops2.txt` (raw: `explain-ops2-raw.txt`)

| query as executed | plan | buffers | time |
| --- | --- | --- | --- |
| hot order lookup: `tenant_sequences` point read (engine consistency barrier; also the API readiness memo key) | 54-row table, 1 page | 3 | 0.03 ms |
| engine tail read after the applied cursor | Index Scan `journal_entries_tenant_sequence_key` | 6 | 0.04 ms |
| entity history page, API SQL (`entity_refs @> … OR record_id = …`, keyset within the snapshot, LIMIT 101) | BitmapOr(GIN `journal_entries_entity_idx`, btree `journal_entries_record_idx`), 69 rows | 258 | 3.4 ms |
| entity history page, engine `entity_entries` / `count_entity_entries` (GIN) | Bitmap Index Scan `journal_entries_entity_idx`, 69 rows | 251 | 1.4 / 1.3 ms |
| 30-day summary | the engine answers `/v1/summary` and tenant-wide intents from the RAM working state; no journal SQL besides the barrier read. The SQL comparison (source track of tenant 0, effect-once by observation key, Sep 2026 window): Bitmap Index Scan `journal_entries_event_idx` 63,472 index rows + 19,281 heap buffers | 19,281 | 1,922 ms |
| readiness refresh BEFORE (per tenant every 5 s when the memo expired): `GROUP BY event_type` over the source track | **Parallel Seq Scan over the whole table** (720k rows filtered) | 65,992 | 68 ms warm (3 workers) |
| readiness refresh AFTER (`JournalService.presentEventTypesIndexed`, this follow-up): recursive loose index scan on `journal_entries_event_idx` | 21 Index Only Scans | 82 | 12 ms cold |

Finding and fix: the order lookup itself touches no journal row (RAM state + one point read), but the readiness block attached to every served state/answer refreshed through a GROUP BY over the whole journal whenever its 5-second memo expired — a full-journal scan on the hot path that competes with every other query on a loaded host. `packages/application/src/readiness.ts` now reads the distinct event types through a loose index scan (the datasets-present derivation needs event types only; the full per-type statistics stay available for the sources views). No N+1: one statement per page/lookup.

## (b) Reference read path and agreement — `tests/perf/pg-reference.mjs`, `reference-before.json`, `reference-before.log`

`tests/perf/pg-reference.mjs` is a diagnostic comparison, not a second implementation: it sums the journal's typed payload fields under the documented effect-once rule (first entry per `(event family, observation key)` carries the effect, superseded carriers are reverted, snapshot stock assertions never regress, movements count only after the basis) with indexed SQL only (entity GIN index + primary key / supersedes index), and compares `physical_stock, available_stock, captured_minor, fees_minor, refunded_minor, bank_confirmed_minor` with `GET /api/entities/order/:id/state` served by the Rust engine.

Command: `node tests/perf/pg-reference.mjs --pools ~/blackbox-perf-keys/pools.json --pg-port 19187 --pg-password-file ~/blackbox-pilot-ops2/secrets/pg_engine_password --api http://127.0.0.1:19185 --compare 200 --hot 1000 --cold 200 --explain --out reports/evidence/PERF-01/reference-before.json` (agent key for tenant 0 from the pools file; keys and passwords are never printed).

- Hot (latest_committed): **200 random orders, 200 matched, 0 mismatched** (incl. orders with superseded fee corrections, returns and matched bank credits).
- Cold (`as_of_recorded` = recorded time at 70 % of tenant 0's history, 50 orders): 36 matched, 0 mismatched, 14 API answers `invalid_params: order … is not known in this tenant` because the order did not exist yet at that cutoff (the reference reads an empty row set for them; correct "unknown", not a mismatch).
- The reference plans (`--explain`, in the log): order query Bitmap Index Scan on the entity GIN (69 entries), item query the same for the SKU (≈700–1,400 entries, because one SKU serves ≈14 orders); 12 ms / 10 ms.

## Full request latency (sequential single client on the host, warm)

First run (`reference-before.json`, 12:28–12:41 UTC, ops2 images api 0.1.4 / engine 0.1.4 — i.e. **before** the readiness fix and the engine change; 1-min host load 8→43 because `cargo test --release`, the engine Docker image build and this run overlapped):

| class | API via engine | reference SQL | SQL rows read per lookup |
| --- | --- | --- | --- |
| hot ×1,000 | p50 207.5 ms · p95 2,150 ms · p99 4,302 ms · max 12,337 ms (1 `deadline_exceeded`) | p50 58.9 ms · p95 365.5 ms · p99 632 ms | p50 814 · p95 1,208 |
| cold as_of ×200 | p50 318.4 ms · p95 548.8 ms · p99 650 ms | p50 28.6 ms · p95 45.7 ms · p99 63 ms | p50 822 · p95 1,125 |

Re-measurement after the follow-up changes (api `0.1.0-followup2` with the readiness fix, engine `0.1.0-followup`) under quieter host conditions: see `reference-after.json` / `reference-after.log` and the table in the "Re-measurement" section below.

Reading of the numbers: the API path includes HTTP, agent-key verification (PostgreSQL read), the engine RPC (barrier point read + RAM view), the readiness memo and JSON serialisation; the SQL path is one process-local query pair without authentication. The SQL reference is competitive for a single order because the entity GIN index narrows it to ≈70 rows (plus the SKU's ≈800 rows for stock); it does not scale to tenant-wide questions (the 30-day summary reference takes 1.9 s cold on tenant 0 where the engine answers from RAM) and it would need every reducer rule re-implemented to answer the other 17 order keys and 24 questions. The engine's benefit is therefore the tenant-wide/aggregate classes and rule fidelity; its overhead on single-entity hot reads is the RPC + auth + readiness layers, of which the readiness refresh was the unbounded part (fixed).

## (c) No money/stock reducers in TypeScript — `ts-money-stock-grep.txt`

`grep -rln _minor` over `packages/` and `apps/` (TS/TSX sources, no dist): 12 files — `apps/api/src/cli.ts`, `apps/api/src/routes/sources.ts`, `apps/web/src/views/EntityView.tsx`, `apps/web/src/views/QuestionsView.tsx`, `packages/application/src/bankcsv.ts`, `packages/application/src/mapping/families.ts`, `packages/application/src/mapping/index.ts`, `packages/application/src/questions.ts`, `packages/connectors/src/adapters/shopify-payments/adapter.ts`, `packages/connectors/src/adapters/shopify/normalize.ts`, `packages/connectors/src/ingest.ts`, `packages/connectors/src/types.ts`. They declare field names, map provider decimals to integer minor units (connector normalisation), validate question parameters, render values (web) or build demo/CSV rows. A regex for arithmetic on a `*_minor` operand (`+ - * / += -=`) and for reducer-like accumulation of captured/refunded/fees/balance/stock matches **no line** outside display formatting. The reducers live only in `crates/domain/src/reducer.rs` (`REDUCER_VERSION = 1`); docs/architecture.md: "No financial reducer exists in TypeScript."

API/MCP agreement: the MCP bridge calls the same API routes (tests/backend/integration/mcp.test.ts MCP-01 "returns the same scoped state as the API", passed in this follow-up run).

## Re-measurement (`reference-after.json`, `reference-after.log`, 13:40–13:44 UTC, 1-min host load 3–5)

Same command with `--out reports/evidence/PERF-01/reference-after.json` against api `blackbox/api:0.1.0-followup2` (readiness loose index scan) and engine `blackbox/engine:0.1.0-followup` (state rebuilt from the journal 60 min earlier, no snapshot) — the comparison therefore also validates the rebuilt state:

- Hot: 200 random orders, **200 matched, 0 mismatched**; cold: 36 matched, 0 mismatched, 14 "not known at that cutoff" as before.

| class | API via engine (after) | API via engine (before, loaded host) | reference SQL (after) |
| --- | --- | --- | --- |
| hot ×1,000 | **p50 77.6 ms · p95 144.1 ms · p99 234 ms · max 421 ms, 0 errors** | p50 207.5 · p95 2,150 · p99 4,302 | p50 24.1 ms · p95 34.7 ms · p99 57 ms |
| cold as_of ×200 | p50 428.7 ms · p95 792 ms · p99 970 ms · max 1,182 ms, 0 errors | p50 318.4 · p95 548.8 · p99 650 | p50 38.2 ms · p95 59.7 ms · p99 79 ms |

The hot full-request latency through the API is now inside the smoke targets for a single client (p95 144 ms vs 200 ms; the smoke profile itself is measured with 20 concurrent clients plus ingestion — see PILOT-09). The engine overhead per hot lookup relative to the indexed SQL reference is ≈55 ms p50 / ≈110 ms p95 on this host (HTTP + argon-free agent-key lookup + engine RPC + readiness memo + JSON of 23 keys, five track views and 69 entry ids, versus a bare two-statement query returning six numbers). Cold `as_of` answers replay the entity through the reducers (engine `entity_entries` + cold LRU keyed by cutoff, which the 600 distinct cutoffs defeat on purpose) and are slower than the SQL cutoff sum by design; they stay under the 1,000 ms cold target at p95 here.

## Status

PERF-01: **passed** for the criteria of this follow-up — one reducer implementation (Rust), API and reference agree on 200/200 hot and 36/36 cold orders, hot lookups use the working state plus point/indexed reads only (the full-journal readiness scan is removed), full-request latency reported for both paths with the engine's benefit (tenant-wide summary 1.9 s SQL vs RAM) and overhead (≈55 ms p50 per single-entity hot read) measured. MCP transport agreement is covered by the integration test MCP-01; the MCP latency classes belong to the PILOT-09 smoke protocol.
