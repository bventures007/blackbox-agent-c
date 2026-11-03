# ADR-0009 Hot-path round trips, exact-cursor summary cache and history residency through catch-up

Status: accepted (P4, PILOT-09 profile cycle on the perf install of commit 78d8100 + this change set)

## Context

After ADR-0008 the smoke protocol still missed every per-class latency target (reports/performance.json run 2:
hot API p95 1,147–1,645 ms vs 200; MCP fixed-arrival success 0.759 from engine `overloaded`). A profile of one
hot `GET /api/entities/order/<id>/state` and one `POST /api/questions/orders.payment_state` on the **idle** install
(reports/evidence/PILOT-09-profile/) located the cost:

- The engine answered a hot order state in 24–33 ms (p50) of its 37 ms end-to-end; the API added ≈4 ms, the
  MCP bridge ≈10 ms, the engine RPC floor was 5 ms and an authenticated API request without an engine call 2 ms.
- 35 of 40 hot orders of the largest tenant (and, per the engine log, 29k records of that tenant plus nearly all
  records of the 45 small tenants) carried `history.evicted_use_cold_read`: their history locators had been
  evicted during the **initial catch-up** of the corpus and the eviction is persisted in every snapshot. Each hot
  lookup therefore read the full entries (payload jsonb included) through the GIN index and rebuilt five track
  summaries from them — the same statement that dominated `pg_stat_activity` under load.
- The catch-up eviction compared history + undo bytes with the per-copy budget but was only allowed to drop
  history locators (undo logs are retained until every correction behind the committed cursor is applied), so the
  target was unreachable for any large tenant and *every* locator went. The 1 MiB per-tenant floor had the same
  effect on 10k-entry tenants whose history alone is 2–3 MiB.
- The API opened one tenant transaction per request only to compare the committed cursor for the readiness memo
  (four round trips on the hot path), re-wrote `sessions.last_seen_at` on every owner request, never forwarded the
  principal to the engine (the per-agent admission limit was unused; only the 16/32 limits applied) and ran a
  bb_api pool of 8 for 20 clients plus ingestion (`database_busy` while PostgreSQL itself was far from
  `max_connections = 80`).
- The engine's `latest_committed` barrier read (`tenant_sequences`) shared the main pool with cold replays and
  evicted-history reads; 51 tenants polled the tail every 250 ms (≈400 idle point reads/s) although every commit
  already wakes the loop through `LISTEN journal_appended`.

## Decision

1. **History residency through catch-up/rebuild.** History-only eviction (`evict_history_to_budget`) budgets
   the history locators alone; the retained undo logs are the floor of that phase. Mid catch-up and mid rebuild
   the periodic pass runs only under measured memory pressure (`ENGINE_RSS_TARGET_MB` exceeded). A publication
   whose last tail read returned fewer rows than requested has applied every committed correction, so it uses the
   full policy (undo logs of the oldest half first, then least recently touched history). Business values are
   still never evicted; both state copies still decide identically (fingerprint check unchanged).
2. **Exact-cursor summary cache.** Records whose history *is* evicted are served from a payload-free indexed read
   (`entity_entry_summaries`: no `payload` column) cached in a bounded LRU keyed by (tenant, entity, **applied
   cursor**), `ENGINE_SUMMARY_CACHE_MB` (32). A later publication is a different key and a rebuild drops the
   tenant, so a hit can never serve rows of another cursor; the state's `consistency` block is untouched.
3. **Barrier pool.** `committed_cursor` runs on a dedicated 2-connection pool with `statement_timeout = 2000`
   (`ENGINE_PG_BARRIER_POOL`); the point read itself is unchanged (`latest_committed` still reads the committed
   cursor at request time). The tail poll fallback is 1 s (`ENGINE_POLL_MS`); LISTEN remains the wake path.
4. **API hot path.** The readiness memo is time-bounded only (≤ 5 s, `observed_at` states its computation time,
   concurrent misses share one computation, `invalidate()` unchanged) and opens no transaction on a hit; the
   owner session row is still re-read on every request but its idle-extension write happens at most once per
   minute (`SESSION_TOUCH_MS`); the verified principal id is sent to the engine as `X-Principal-Id` (header only,
   uuid-validated) so the contract's 8-per-agent limit applies; the bb_api pool defaults to 16 (`API_PG_POOL`).

5. **Second cycle (after the first protocol run on 0.1.2-perf).** The engine log of that run showed 1,820
   churn events of the single tenant under ingestion: with RSS over target the loop dropped that tenant's ≈94 MiB
   write copy as soon as a batch was published and re-cloned it one second later (763 drops, 7 fingerprint
   divergences → full clones), ran an eviction pass at every publication (1,097) and the engine burned 170–240 %
   CPU while the smoke profile ran. Bounded rules now: under RSS pressure a write copy is dropped only after a
   10 s grace period without batches (`RSS_DROP_GRACE`; an idle tenant still drops at once after
   `ENGINE_WRITE_COPY_IDLE_SECONDS`), and an RSS-pressure eviction pass of one tenant runs at most every 10 s
   (`RSS_EVICTION_INTERVAL`). Independently: `Answer::touch` and `conflicts_for` used linear membership (quadratic
   for a tenant-wide intent touching 5,000 invoices — `invoices.outstanding` cost 117–385 ms of engine time on
   tenant 0), intents and summaries now run on the blocking pool (`spawn_blocking`, never stalling the async
   workers that serve hot lookups; the deadline still cancels the response, the CPU work of one intent is bounded
   by its own cost), and the evidence citation of an answer with evicted-history records reads cold summaries in
   touch order only until the 500-locator cap is reached (`evidence_truncated` is set when records stay unread —
   before, thousands of PostgreSQL reads were spent on a citation truncated to 500 anyway).

6. **Answer size (second cycle).** Idle profiling of resident tenant-0 orders showed 500–700 merged history
   locators (shared items and the customer) and 200 KB state answers — serialized twice in the engine, parsed and
   re-serialized by the API, pretty-printed by the bridge — and for evicted orders the engine still built that RAM
   merge before the HTTP layer replaced it. `TRACK_SUMMARIES_PER_TRACK` is 25 (each track view keeps `total` and
   `truncated`; the complete history is one `/v1/history` page away; `entry_ids`/`evidence_refs` stay complete) and
   `entity_state` skips the merge/track build entirely when any entity is cold. The PostgreSQL path applies the same
   per-track bound.

## Consequences

- Revocation semantics are unchanged: credentials and sessions are re-read per request (IDENTITY §43 "new
  requests after acknowledgment must fail"); a session-row cache was deliberately not introduced.
- Readiness/coverage attached to answers may lag a new event family or a health change by up to 5 s (the UI's
  own polling cadence); the answer's consistency cursor never does.
- Memory: a tenant now keeps its history locators resident unless the measured RSS exceeds the target; the
  structural budgets and the RSS-target eviction at publication still bound steady state. Existing snapshots
  keep their evicted `cold_history` until the tenant is rebuilt (the smoke protocol's no-snapshot rebuild).
- Tests: `crates/projections` (eviction semantics, summary cache), `tests/backend/unit/hot-path.test.ts`
  (memo, principal header, pool size), existing engine/API suites.
