# PILOT-09 profile — where the ≈60 ms of a hot request went (2026-11-03, perf install `~/blackbox-pilot-perf`)

Scripts: `scripts/verify/perf-profile-hot.mjs` (40 sequential hot orders of one tenant through the API with the agent
key of that tenant's first principal; the same 40 directly against `engine:7070` from inside the api container with the
engine token; `POST /api/questions/orders.payment_state` for the same orders through both paths; RPC/auth floors) and
`scripts/verify/perf-profile-mcp.mjs` (the same calls through the real stdio bridge with the official SDK client).
Host 1-min load is printed in every file (10–37; the Mac was shared with ≈11 foreign containers throughout).

## Before (images 0.1.1-perf = commit 5b743d4/78d8100, `profile-idle-tenant0-before.jsonl`, `engine-health-before.json`)

| path | p50 | p95 | notes |
| --- | --- | --- | --- |
| API `GET /api/entities/order/<id>/state` (tenant 0) | 37.6 ms | 111 ms | engine `duration_ms` p50 24 ms; response 26 KB p50 / 253 KB max |
| engine direct `POST /v1/state` | 37.4 ms | 88 ms | engine `duration_ms` p50 33 ms — **the engine is the cost**; API adds ≈4 ms |
| API `POST /api/questions/orders.payment_state` | 61.2 ms | 168 ms | |
| engine direct `/v1/query` | 41.9 ms | 58 ms | engine `duration_ms` p50 40 ms |
| engine RPC floor (`GET /v1/schema`) | 5 ms | 8 ms | token check + JSON |
| API authenticated, no engine (`/api/questions/search`) | 2.2 ms | 3.7 ms | credential re-read (one authenticator transaction) |
| API unauthenticated `/api/health` | 0.9 ms | 2.5 ms | |
| MCP `get_business_state` | 47.5 ms | 70 ms | bridge adds ≈10 ms over the API (36 KB pretty-printed text) |
| MCP `answer_question` payment_state | 49.7 ms | 59 ms | |
| MCP bridge startup | 246 ms | | once per principal |

Breakdown of the 37 ms engine time: **35 of the 40 hot orders carried `history.evicted_use_cold_read`** — their history
locators had been evicted and every lookup read the full entries (`payload` jsonb included) through the GIN index
and rebuilt the five track summaries from them. The engine log of the corpus catch-up (`engine.evicted`) shows the
cause: the catch-up eviction compared history + undo bytes with the per-copy budget but could only drop history
(undo logs are retained until every correction behind the committed cursor is applied), so the target was unreachable
and every locator went: 10,295 + 12,773 + 5,848 records of tenant 0 and 1,200–2,000 records of each small tenant
(budget floor 1 MiB per tenant vs 2–3 MiB of history). Snapshots persist `cold_history`, so the state survived every
restart. Engine health before: RSS 791–820 MiB, structural 443–464 MiB, evictable 183 MiB, `rss_evictions` 0 (no
memory pressure — the eviction was structural).

API-side costs on the hot path (code reading, confirmed by the 2 ms auth-only path): one authenticator transaction per
request (BEGIN, set_config, SELECT, COMMIT — kept, revocation must stay immediate), **one more tenant transaction per
request only to compare the committed cursor for the readiness memo** (BEGIN, set_config, SELECT tenant_sequences,
COMMIT), an `UPDATE sessions` on every owner request, and no `X-Principal-Id` to the engine (the per-agent admission
limit was unused). Engine side: `committed_cursor` on the shared 8-connection pool next to cold replays; 51 tenants
polling the tail every 250 ms (≈400 idle point reads/s) despite LISTEN wake-ups.

## After (images 0.1.2-perf = ADR-0009 working tree; `profile-idle-tenant0-after-upgrade-snapshots.jsonl`, `profile-idle-after-rebuild.jsonl`)

Same install right after `./blackbox upgrade` (engine loaded from the 0.1.1-perf snapshots, so the 35 evicted
records are still evicted and are served through the payload-free read + exact-cursor summary cache):

| path | pass 1 (cache cold) p50 / p95 | pass 2 (cache warm) p50 / p95 | before p50 |
| --- | --- | --- | --- |
| API hot state | 10.0 / 17.7 ms (engine 4 ms) | 7.1 / 11.5 ms (engine 2 ms) | 37.6 ms |
| engine direct `/v1/state` | 3.8 / 6.8 ms | 3.3 / 5.3 ms | 37.4 ms |
| API question payment_state | 6.7 / 13.2 ms | 4.8 / 6.7 ms | 61.2 ms |
| engine direct `/v1/query` | 1.8 / 4.7 ms | 2.1 / 5.8 ms | 41.9 ms |
| MCP `get_business_state` | 10.1 / 17.8 ms | | 47.5 ms |
| MCP `answer_question` | 6.6 / 11.3 ms | | 49.7 ms |

After the protocol's no-snapshot rebuild (history resident where the budget allows): tenant 5 (10k entries) has no
evicted record (API hot p50 12.4 ms, engine 2 ms, `missing_inputs` empty); tenant 0 (276k entries) still has 28 of
the 40 sample orders evicted — its per-copy budget is halved while the write copy is resident and the engine's RSS
already sits at 1,009 MiB with the history that stayed (the per-entry floor the follow-up identified) — those are
served from the summary cache after the first read at a cursor (first pass after the rebuild: engine 9 ms p50 /
14 ms p95 with cache misses; warm: 2 ms). `engine.evicted` after the rebuild: 31 full-policy evictions at tail-exhausted
publications (undo logs first, then history), 0 under RSS pressure.
