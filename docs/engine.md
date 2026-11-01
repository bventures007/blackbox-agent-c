# Rust query engine (`apps/engine`)

The engine is the single implementation of the canonical money/stock rules (specs/PERFORMANCE-ARCHITECTURE.md §2, ADR-0004). It tails the append-only journal in PostgreSQL, applies deterministic reducers into compact per-tenant RAM state, persists checkpoints/snapshots, and serves the HTTP contract in `packages/contracts/engine-rpc.json` on the private Compose network. TypeScript orchestrates and authorizes; it never reduces money or stock.

## Layout

| Path | Crate | Purpose |
| --- | --- | --- |
| `Cargo.toml`, `Cargo.lock` | workspace | Rust 1.83 toolchain (the lockfile was generated MSRV-aware so `cargo build --locked` works on the pinned `rust:1.83` image) |
| `crates/domain` | `blackbox-domain` | Pure deterministic reducers, compact state (`TenantState`, `Rec`), typed views, golden fixture builders. No I/O. |
| `crates/storage` | `blackbox-storage` | sqlx/PostgreSQL access as `bb_engine`: tail reads, indexed entity reads, checkpoints, snapshots, LISTEN. No journal writes. |
| `crates/projections` | `blackbox-projections` | Tenant registry, ArcSwap publication, tail apply loop, snapshot codec, memory eviction, cold-hydration LRU. |
| `crates/query` | `blackbox-query` | The 24 intents, `/v1/state` view, thirty-day summary, `describe_business_schema`. Pure functions over state. |
| `apps/engine` | `blackbox-engine` | axum service (`blackbox-engine` binary, `--healthcheck`), JSON logging, admission control, consistency barrier; `corpus` binary (smoke corpus generator). |
| `tests/engine` | `blackbox-engine-tests` | Integration harness (throwaway database, migrations, appends as `bb_api`, engine process spawn). Tests live in `apps/engine/tests/`. |
| `docs/engine.md` | this file | |

Build integration hooks expected by `infra/docker/engine.Dockerfile` and Compose: package `blackbox-engine`, binary `blackbox-engine`, `--healthcheck` exits 0 when `/health` reports `healthy`, `catching_up` or `rebuilding`. The Dockerfile copies the whole Cargo workspace (`apps/engine`, `crates/`, `tests/engine`, `packages/contracts`; trimmed by `engine.Dockerfile.dockerignore`) and runs `cargo build --release --locked -p blackbox-engine`.

## Data model in RAM

Every business record is a `Rec` keyed by `(tenant, kind, interned id)` with fixed slot arrays: `m[16]` integer minor amounts, `q[10]` decimal quantities (`rust_decimal`), `s[8]` interned symbol links (currency, unit, order, customer, ...), `t[4]` millisecond timestamps, a `status` byte and an adjacency list `links`. Slot meanings per kind are the constants in `crates/domain/src/state.rs::fields`. Strings (ids, currencies, units, event types, observation keys) are interned once per tenant. Record kinds: order, line, item, reservation, invoice, credit, transaction, attempt, refund, payout, bank_entry, shipment, return, hold, dispute, promise (customer), supply, policy, case, link (identity), coverage, communication, dispatch, entitlement, allocation (payment), account (provider account per currency), customer, ledger.

Per tenant the state also holds: history locators per record (`EntryLoc`: sequence, entry id, track, event, times, effect), per-entry metadata (observation key, effect, undo log, superseded_by), the effect-once set, source observation hashes, conflicts, the datasets present, a tracking-number index and the chain hash.

Money is `i64` minor units with an ISO currency symbol on the record; the reducers never add two currencies: a record whose currency differs from a later observation records a `currency_mismatch` conflict and skips the effect. Quantities are `Decimal` with an explicit unit symbol.

## Reducer semantics

Reducers live in `crates/domain/src/reducer.rs` (`apply(&mut TenantState, &Entry) -> Outcome`). `REDUCER_VERSION = 1` is persisted in checkpoints and snapshots.

**Idempotency.** An entry already applied (same `entry_id`) returns `AlreadyApplied` and changes nothing. Applying the same journal twice produces the same state and the same chain hash.

**Effect-once rule.** Every entry resolves an observation key: `correlation_id` if set; otherwise, for source entries, `<connection_id>:<provider_event_id>`; otherwise the observation key of the first `input_entry_ids` entry already in state; otherwise the entry id. A business effect is keyed by `(event family, observation key)` and applied once. The TypeScript ingestion appends one source entry per observation plus derived fact/commitment/movement/reservation entries for the same observation (sharing `correlation_id` and referencing the source in `input_entry_ids`). Whichever entry of the observation is applied first carries the effect; the others are recorded in history with effect `deduplicated`. A source entry alone (no derived entries) therefore carries the full effect; a source followed by derived movement/reservation entries counts the movement exactly once. Both shapes are tested (golden checkpoints hold for both). Track semantics are preserved for reporting: `/v1/state` returns five track views; movements move money/stock, reservations reserve, facts/commitments assert.

**Duplicate deliveries.** A second source entry with the same observation key and identical payload hash is `deduplicated` (no effect, no conflict). The same observation key with a different payload hash is a `conflict` (`observation_content_conflict`), recorded with both entry ids and no state change.

**Late entries.** Entries keep their effective time (`occurred_at`); the journal position is the recorded order. Additive movements apply regardless of order unless they predate the current snapshot basis of the item (see below). Snapshot-type assertions (`inventory.snapshot`, `provider.balance_observed`, carrier scans) never regress a newer basis: an older observation arriving later is recorded with effect `late_no_effect`. A late `payment.failed` attempt never reduces a capture; it is recorded as an `attempt` record linked to the transaction and order.

**Stock basis.** `inventory.snapshot` sets physical/quarantined/committed/damaged/safety/quality-control/snapshot-reserved and optional provider `available` at `basis_at = occurred_at`. Stock movements (`shipment.dispatched` with `physical_stock_delta`, `return.received`, `return.restocked`, `inventory.adjustment_observed`) apply only when they occur after the basis; reservations recorded before the basis are considered covered by the snapshot's own reserved/committed figures. `available = (provider available | physical − quarantined − committed − damaged − safety − quality_control − snapshot_reserved) − active reservations recorded after the basis`. Without any basis the item's stock is unknown (`null`), never zero. Incoming supply is reported separately and never fills stock.

**Money rules (golden invariants).** Authorizations are not captures; `invoice.payment_marked` increases reported paid markers only (never cash); credit notes reduce the invoice net and raise `refund_payable` but are not refunds; `refund.pending` holds money (`provider_held`), `refund.completed` moves it (`refunded`); `payout.announced` is a commitment (balance unchanged), `payout.sent` moves the amount from the provider balance to `in_transit`; only a booked bank credit matched to the sent payout moves it to `bank_confirmed` (unmatched or pending bank rows stay visible but do not confirm). Order view formulas: `invoice_net = original − credit`, `open_receivable = max(0, net − reported_paid)`, `refund_payable = max(0, max(0, reported_paid − net) − refunded)`, `customer_net_paid = captured − refunded`, `provider_balance = captured − fees − refunded − payouts_sent − chargebacks_net`, `provider_available = balance − held − announced`, and the conservation `captured − fees − refunded = balance + in_transit + bank_confirmed`.

**Corrections (`supersedes_entry_id`).** Every applied entry keeps an undo log of its mutations. A correcting entry first reverts the superseded entry's undo log (additive deltas are subtracted; set-values are restored only if still current), marks it `superseded` (history keeps both, `superseded_by` is exposed), then applies itself. The same record with a correction is therefore never double counted. If the superseded entry's undo log is no longer resident (evicted, see memory accounting), the tail loop applies the correction and schedules a tenant rebuild from the journal so the precise reverted effect is re-established.

**Order independence.** For independent entries the state does not depend on application order (tested: derived-before-source, delayed payment marker, duplicated snapshots). Dependent entries (derived after source, corrections after targets) always have higher sequences in the journal.

**Unknown event types** are recorded (history + counters) without effect; `unknown_event_types` appears in query coverage.

## Consistency modes (engine-rpc.json)

Every answer carries `consistency = {applied_cursor, required_cursor, reducer_version, status, recorded_cutoff, effective_cutoff, mode}`.

- `latest_committed` (default): reads `tenant_sequences.last_sequence` (indexed point read), waits up to `deadline_ms` for the published state to reach it, otherwise `503 projection_behind` with `retryable=true`, `applied_cursor` and `required_cursor`. A stale state is never served as current.
- `at_least_cursor`: same with the caller's `cursor`.
- `as_of`: `as_of_recorded` (required) is a recorded-time cutoff; `as_of_effective` optionally filters by `occurred_at`. The engine resolves the maximum sequence recorded by the cutoff and replays the scoped entries from PostgreSQL through the same reducers into a scratch state (entity-scoped for `/v1/state`, `/v1/history` and intents with `order_id`/`item_id`/`payout_id`; whole tenant for tenant-wide intents, bounded by `ENGINE_REPLAY_MAX_ENTRIES`, otherwise `413 too_large`). Status `historical`; both cutoffs are reported.
- `stale_explicit`: the published state without a barrier; status `stale`.

`deadline_ms` is capped at 5000 and enforced with `tokio::time::timeout`, which drops the in-flight work (database reads are cancelled on drop). Pages: `limit` ≤ 500 (default 100). `/v1/history` pages PostgreSQL by keyset within a fixed snapshot boundary `(snapshot sequence fixed at the first page, last sequence)`; cursors are tagged with a tenant hash and rejected for another tenant; `page.newer_available` exposes later commits. Query intents page a deterministic result list; the cursor carries the snapshot cursor at the first page.

## Admission control

Non-queuing semaphores: 32 in flight per process, 16 per workspace (tenant), 8 per agent (`X-Principal-Id`). Exceeding any limit returns `429 overloaded` with `retry_after_ms`; permits are released when the request completes or its deadline cancels it. Request bodies are capped at 256 KiB (`413 too_large`). All endpoints, including `/health`, require `X-Engine-Token` (401 otherwise; constant-time comparison).

## Publication, checkpoints and the tail loop

One task per tenant (`crates/projections/src/engine.rs`):

1. `read_tail`: `journal_entries WHERE tenant_id = $1 AND journal_sequence > applied ORDER BY tenant_id, journal_sequence LIMIT 1000` (uses `journal_entries_tenant_sequence_key`). A `LISTEN journal_appended` task is only a wake hint; polling (`ENGINE_POLL_MS`, default 250 ms) is the recovery mechanism.
2. Apply the batch into the private write copy; evict if over budget.
3. Commit `engine_checkpoints(applied_sequence, reducer_version, state_hash)` (chain hash over applied entry ids/effects).
4. Publish the write copy atomically (`ArcSwap::swap`); only then advance the applied cursor and wake waiters. Readers hold the old or the new consistent state, never a cursor ahead of the balances.
5. Log `engine.batch_applied` (after publication) with `committed_cursor` and `applied_cursor`.
6. Reclaim the retired copy once no reader references it and apply the same batch there (left-right double buffer: two copies per tenant, no clone per batch, readers never block). Divergence (never expected) resyncs from the published copy.

If the checkpoint commit fails nothing is published and the write copy is resynced from the published copy. Snapshots (`engine_snapshots`: bincode blob, sha256 checksum, `format_version` 1, reducer version, applied sequence) are written off the runtime thread every `ENGINE_SNAPSHOT_SECONDS` once at least `ENGINE_SNAPSHOT_MIN_ENTRIES` new entries were applied, and on `POST /v1/admin/snapshot`.

## Restart and rebuild

At start each tenant loads its snapshot when the checkpoint has the same reducer version, the checksum verifies, the blob decodes, the tenant matches and the snapshot's applied sequence is not ahead of the checkpoint. Otherwise the snapshot is deleted (`engine.snapshot_rejected`) and the tenant is rebuilt from sequence 1. The published cursor is the snapshot's cursor until the tail is applied; health reports phases `loading`, `catching_up`, `ready`, `rebuilding` per tenant and the process status `catching_up`/`healthy`/`rebuilding`/`degraded`. `POST /v1/admin/rebuild {tenant_id|null}` rebuilds while the previous state keeps serving; the rebuilt copy is published at once when it reaches the previously applied cursor. Tests prove restart with a snapshot, a corrupted snapshot (rejected, rebuilt, identical state and chain hash) and a 1000-entry unapplied tail applied within the 30 s target while new entries arrive.

## Memory accounting

Budgets are structural estimates (`TenantState::approx_bytes`: records, links, history locators, entry metadata, undo logs, interner), not allocator truth; `/health` reports the estimate next to process RSS (`rss_bytes`: `/proc/self/statm` on Linux, `proc_pidinfo` on macOS). `ENGINE_HOT_BUDGET_MB` (default 512) is divided by two copies and by the number of tenants (`ENGINE_TENANT_BUDGET_MB` caps a tenant). When a copy exceeds its share the engine evicts deterministically (both copies decide identically): first undo logs of the oldest half of resident entries (a later correction of such an entry triggers a rebuild), then history locators of the least recently touched records. Business values are never evicted. Records with evicted history are marked cold: `/v1/state` serves their track summaries from the indexed PostgreSQL entity read (`journal_entries_entity_idx` GIN on `entity_refs`) and reports `history.evicted_use_cold_read`. Cold/as-of replays are cached in a bounded LRU (`ENGINE_COLD_CACHE_MB`, default 64) keyed by entity and cutoff. Historical growth therefore grows PostgreSQL, not RAM beyond the record set; the smoke corpus (≈1,000 orders/tenant) stays far below the default budget.

## HTTP endpoints

`GET /health`, `POST /v1/state`, `POST /v1/query`, `POST /v1/history`, `POST /v1/summary`, `POST /v1/admin/rebuild`, `POST /v1/admin/snapshot` (testing/operations hook), `GET /v1/schema`. Errors use `{error: {code, message, retryable, retry_after_ms, ...}}` with codes `unauthorized`, `tenant_unknown`, `projection_behind`, `deadline_exceeded`, `unsupported_intent`, `invalid_params`, `too_large`, `overloaded`.

`/v1/state` for an order returns exactly the 23 keys of the contract (`physical_stock ... bank_confirmed_minor, shipment_status, currency, unit`), stock values as decimal strings or `null` when no basis exists, plus `tracks` (five track views, latest 100 summaries per track with totals), `evidence_refs`/`entry_ids`, `coverage {datasets_present, datasets_missing}`, `conflicts [{case_id, reason, entry_id, related_entry_id}]`, `status` and `missing_inputs`. Other entity types return their typed record view.

`/v1/query` returns the common result envelope: `status complete|partial|unknown|conflict|unsupported`, `intent`, `result` (typed; integer minor amounts, decimal quantity strings, `null` for unknown values), `calculation` (steps with formulas and numbers), `rule_version`, `evidence_refs` (`journal:<entry_id>`), `entry_ids`, `missing_inputs` (dataset/capability ids such as `stock.basis`, `policy.priority_method`, `bank`), `conflicts`, `coverage` (datasets present/missing, population, coverage assertions), `effective_at`, `page`, `consistency`. Unknown parameters and wrong types are rejected (`invalid_params`); each intent's parameters are listed by `/v1/schema`.

## Query intents and payload conventions

Intents are the 24 ids of specs/question-data-contracts.json (`crates/query/src/intents.rs`). Required inputs come from the datasets present in the tenant's journal; absent datasets yield `unknown`/`partial` with explicit `missing_inputs` (for example no `holds` dataset → `held` is an unknown component, never zero; no `bank` dataset → bank arrival unknown; no `entitlements` → refund due unknown while the credit stays listed as "credit without entitlement"). Policies (`business.rule_recorded`: `priority_method`, `invoicing_trigger`, `reminder_policy`, `attention_rule`, `stale_scan_seconds`, `risk_hours`) and coverage assertions (`coverage.observed`: `capability`, `backfill_complete`, `complete_through`) are read from the journal; some intents accept explicit overrides (`priority`, `rule`, `stale_after_seconds`, `risk_hours`, `now`).

Payload field names follow the golden examples in `packages/contracts/events.json`; the additional fields the reducers read for non-golden families are listed by `/v1/schema` and in `crates/domain/src/reducer.rs` (for example `payment.failed {transaction, attempt, amount_minor, reason}`, `provider.hold_recorded {hold, account, amount_minor, currency, reason, release_promised_at}`, `provider.ledger_posted {ledger_entry, account, transaction, payout, posting_type, gross_minor, fee_minor, net_minor}`, `customer.commitment_recorded {promise, promised_at, timezone, promise_kind}`, `supply.commitment_recorded {promise, item, quantity, unit, promised_at, allocation_links}`, `refund.entitlement_recorded {entitlement, original_transaction, amount_minor, destination}`). Entity links are read from `entity_refs` first and from same-named payload keys second; the ingestion should populate `entity_refs` for every linked entity so that indexed cold reads and `/v1/history` find all entries of an entity.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` | `127.0.0.1`, `5432`, `blackbox`, `bb_engine` | PostgreSQL connection (engine role) |
| `PGPASSWORD_FILE` / `PGPASSWORD` | – | Password file (preferred) or value; never logged |
| `ENGINE_TOKEN_FILE` / `ENGINE_TOKEN` | – (required) | Shared secret for `X-Engine-Token` |
| `ENGINE_LISTEN` / `ENGINE_BIND` | `0.0.0.0:7070` | Bind address. Private Compose network only; the engine is never published to the host and has no public/LAN mode. |
| `ENGINE_HOT_BUDGET_MB` | 512 | Total structural hot budget (two copies per tenant share it) |
| `ENGINE_TENANT_BUDGET_MB` | 0 (derived) | Per-tenant cap |
| `ENGINE_COLD_CACHE_MB` | 64 | LRU for cold/as-of replays |
| `ENGINE_REPLAY_MAX_ENTRIES` | 200000 | Bound for one as_of/cold replay |
| `ENGINE_BATCH_SIZE` | 1000 | Tail batch |
| `ENGINE_POLL_MS` | 250 | Tail poll interval (LISTEN is a hint) |
| `ENGINE_SNAPSHOT_SECONDS`, `ENGINE_SNAPSHOT_MIN_ENTRIES` | 60, 200 | Snapshot cadence |
| `ENGINE_PG_POOL` | 8 | Pool size |
| `LOG_LEVEL` / `RUST_LOG` | info | Log level |
| `BLACKBOX_VERSION` | crate version | Reported `service_version` |
| `LOG_DIR` | – | When set (Compose: `/data/logs`), every log record is also appended to `records-YYYYMMDD-HH-engine.jsonl` there, so `./blackbox logs --component engine` and the diagnostics view correlate engine records with api/worker records |

Logs are JSON lines on stderr following `packages/contracts/log-record.json` (allowlisted fields, 512-character strings, 16 KiB records). No payloads, ids of customers/orders or secrets are logged; tenant ids are workspace scope.

## Measured sample (2026-11-01, this Apple Silicon Mac, PostgreSQL 16 in Docker Desktop)

`load_sample_hot_state_p95` (engine RPC only, `latest_committed`, 16 clients over 2 workspaces, 200 orders / 12,600 entries, 1,200 requests, 0 errors): release binary p50 55.8 ms, p95 125.3 ms, p99 162.1 ms, 250 req/s, RSS 56.7 MiB; debug binary p50 83.7 ms, p95 282.1 ms, p99 1,096.6 ms, 102 req/s. These are engine-only numbers on a loaded developer machine, not the PILOT-09 API/MCP measurement; the smoke corpus and the full per-class runs belong to the orchestrator. Snapshot restart of a 1,260-entry tenant was ready in well under a second; a 1,260-entry unapplied tail applied within the 30 s target while new entries arrived (see `ops_http.rs` output).

## Running the tests

Unit and property tests (no database):

```sh
cargo test -p blackbox-domain
```

Integration tests need the throwaway PostgreSQL container and the debug engine binary:

```sh
docker run -d --name blackbox-agent-c-enginepg -e POSTGRES_PASSWORD=enginepg -p 127.0.0.1:19184:5432 postgres:16-alpine
cargo build -p blackbox-engine
cargo test -p blackbox-engine --test golden_http --test intents_http
cargo test -p blackbox-engine --test ops_http -- --test-threads=2
```

Each test creates its own database (`engine_test_<name>_<rand>`), applies `0000_roles.sql` and `0001_journal.sql`, sets test passwords for `bb_api`/`bb_engine`, appends through `append_journal_entries(jsonb)` as `bb_api` with `app.tenant_id`, and spawns `target/debug/blackbox-engine` as `bb_engine` on a free `127.0.0.1` port. `ENGINE_TEST_PGHOST`/`ENGINE_TEST_PGPORT` and `ENGINE_BINARY` override the defaults. The load sample writes `target/engine-load-sample.json`. Stop the container with `docker rm -f blackbox-agent-c-enginepg`.

Smoke corpus (`PILOT-09` dataset) into a prepared database (migrations applied, `bb_api` password known):

```sh
PGHOST=127.0.0.1 PGPORT=19184 PGDATABASE=corpus PGUSER=bb_api PGPASSWORD=... \
  cargo run --release -p blackbox-engine --bin corpus -- --seed 42 --tenants 50 \
  --min-entries 250000 --min-orders 10000 --parallel 6 --manifest reports/corpus-manifest.json
```

`corpus-v2` generates tenants concurrently (`--parallel`, default 6) from per-tenant RNGs derived from the seed;
sequence allocation stays serialized per tenant by the journal's tenant row lock, so the largest tenant bounds the
wall time (~50 entries/s per connection on this Mac, PostgreSQL CPU-bound in `append_journal_entries`). If the
generator is stopped early, `tests/perf/manifest-from-db.mjs` reconstructs a labeled manifest from the database.

The manifest records seed, generator version, per-tenant order/entry counts, order-history percentiles, the largest-tenant fraction, the designated hot set (2,000 orders of the largest tenant) and a cold sample.
