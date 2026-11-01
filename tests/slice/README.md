# SLICE-01 — reproducible first-slice proof

`tests/slice/slice-01.sh` runs specs/FIRST-VERTICAL-SLICE.md P1 steps 1–6 against an **installed, running** stack (the release archive installed with `./blackbox setup` + `./blackbox up`, Compose project `blackbox-agent-c`, API on `http://127.0.0.1:19180`). It is bash + curl + node only, prints `PASS`/`FAIL` per check and exits non-zero on any failure. Artifacts go to `reports/evidence/SLICE-01/` (sanitized: no keys, cookies or secrets; a grep for `bbk_`/`bba_`/`bb_session=` is part of the run).

The provider is the synthetic Shopify-shaped fixture (`fixtures/shopify/server.mjs`, seed 42, 40 orders) on `127.0.0.1:19182`; the api/worker containers reach it as `host.docker.internal:19182`. This is provider-shaped, persisted proof of the pipeline — explicitly **not** live Shopify evidence (SLICE-02 stays blocked_external).

## Run

```sh
pnpm install && pnpm build:backend                      # MCP bridge (packages/mcp/dist) and helpers
INSTALL_DIR=/Users/<you>/blackbox-pilot-int \
OWNER_KEY_FILE=/Users/<you>/blackbox-pilot-int/owner.key \
tests/slice/slice-01.sh
```

Environment: `INSTALL_DIR` (installed release directory holding `blackbox`, `.env`, `secrets/`, `data/`), `OWNER_KEY_FILE` (0600 file with the owner key shown once by `./blackbox setup`; keep it outside the repo), `BLACKBOX_API_URL` (default `http://127.0.0.1:19180`), `FIXTURE_PORT` (19182), `SLICE_OUT` (artifact directory). Docker must be reachable (`docker exec` into the project's api/postgres containers is used for the engine admin snapshot route and the snapshot corruption).

## What each step proves

| Step | Checks | Artifacts |
| --- | --- | --- |
| 1 | owner login (session cookie), agent key created through `POST /api/agents`, agent key authorized on a read route | `step-1-session.json`, `step-1-agent.json` (key redacted) |
| 2 | fixture up; `POST /api/sources/connections` (secret sealed with the data key); `last_30_days` plan; `POST .../runs {backfill}` queues one worker run per poll group; runs complete with counters | `step-2-*.json` |
| 3 | `GET /api/journal` entries per track/event type; derived entries link their source (`input_entry_ids`), share `correlation_id`, carry `entity_refs`; a second backfill yields only duplicates and leaves the journal unchanged | `step-3-*.json` |
| 4 | `GET /api/entities/order/<id>/state?mode=latest_committed` (API) and `get_business_state` through the stdio MCP bridge with the official SDK client; normalized values/evidence identical; committed vs applied cursor recorded; a fixed-cutoff (`as_of_recorded`) answer captured | `step-4-*.json` |
| 5 | `./blackbox down` + `up`; engine snapshot written on request (`POST /v1/admin/snapshot` from inside the api container), blob corrupted in `engine_snapshots`, engine restarted → `engine.snapshot_rejected` in the shared logs, tenant rebuilt from the journal; the same cutoff query returns identical normalized values/entry ids/evidence refs via API and MCP; `latest_committed` plus the count of observations recorded after the cutoff | `step-5-*.json`, `logs-engine-restart.jsonl` |
| 6 | late `order.revised` correction with `supersedes_entry_id` through `POST /api/ingest/replay`: current answer includes it, the cutoff answer does not, the original is `superseded`; agent key revoked → MCP typed 401 and API 401 within 5 s; second synthetic tenant with the same external order id created by the host CLI (`create-tenant --seed-order`, no HTTP route) → no cross-tenant entries, 404 for the foreign entry id, owner state unchanged; `./blackbox logs --run <id>` correlates api+worker `journal.batch_committed`, engine `engine.batch_applied`, api `query.served`/`auth.access_denied` | `step-6-*.json`, `logs-*.jsonl` |

`results.json` carries `status` (`passed`/`failed`) and the observed values per step; `step-summary.json` is the same observed block.

Helpers: `mcp-state.mjs` (SDK client over stdio; the agent key is read from `BLACKBOX_AGENT_KEY_FILE`, never argv) and `normalize.mjs` (drops ephemeral consistency/readiness/timing fields; keeps business values, status, sorted entry/evidence ids and per-track entry sets).

Nothing is committed to Git by the script; the stack is left running.
