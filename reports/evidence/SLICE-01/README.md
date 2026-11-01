# SLICE-01 — first persisted Shopify-shaped-to-answer slice (provider-shaped, synthetic)

Status: **passed** (52/52 scripted checks, `tests/slice/slice-01.sh`, exit 0). This is the P1 persisted
acceptance gate of specs/FIRST-VERTICAL-SLICE.md steps 1–6 against the installed release stack. The
provider is the synthetic Shopify-shaped fixture; nothing here is live Shopify evidence (SLICE-02 stays
`blocked_external`: no authorized store or credentials exist in this environment).

## Environment

- Host: macOS 27.2 arm64, Docker 27.3.1, Compose v2.30.3-desktop.1, node v25.9.0, pnpm 11.20.0, cargo 1.83.0 (5ffbef321 2024-10-29)
- Repository commit: `aa18411ee6f77725cf1fa13d77596d08ec9efdab` with an **uncommitted working tree** at the time of the run (the P1 integration changes are not yet committed; `git status --short | wc -l` = 56)
- Release: `release/dist/blackbox-0.1.0-rc6-mac-arm64.tar.gz` (sha256 `b2068460b8c4cc32624a35687d22ad9b4f8e06509e47de4bb3eeb644aa486432`, 594309750 bytes), built by `scripts/release/build.sh 0.1.0-rc6`, `check-manifest.sh` PASS
- Image ids (release.json): api=`sha256:113a50917418565ee4a4c5c41cec4280ce0ff7f29e3b0e7bfb885b039444fc3e`, worker=`sha256:16c9191e39d3c9dfd771d986daa86a6bdfb3c2658b1dc5f439cf5189e8da2211`, engine=`sha256:29d80c9e5a3896f83ee8aad574cdaf5c156e1847acd98ae5d6932f7e98423802`, backup=`sha256:c6d3bee4ebc7f8689bb2834529697192d75a8f9de9dce710ff6b0387c300d4a3`, postgres=`sha256:1d04b9ba1d4996401f2552b51beda8187f175c0645c091e4781134fc9c9a3eef`
- Installation: `/Users/benediktsauter/blackbox-pilot-int` (archive extracted, `./blackbox doctor` ok, `./blackbox setup` → owner key shown once on the terminal and kept in a 0600 file outside the repo; never in these reports), Compose project `blackbox-agent-c`, API `127.0.0.1:19180` only
- Services during the run (`docker compose -p blackbox-agent-c ps`): api healthy, engine healthy, postgres healthy, worker running, backup-scheduler running
- Run window: 2026-11-01T11:49:48Z .. 2026-11-01T11:52:00.909Z (UTC)

## Commands

```sh
scripts/release/build.sh 0.1.0-rc6                                   # images + archive + manifest check
mkdir -p ~/blackbox-pilot-int && cd ~/blackbox-pilot-int
tar -xzf <repo>/release/dist/blackbox-0.1.0-rc6-mac-arm64.tar.gz --strip-components=1
./blackbox doctor && ./blackbox setup                                 # owner key shown once → saved to ./owner.key (0600)
./blackbox status                                                     # api health {"status":"ok","version":"0.1.0-rc6"}
cd <repo> && pnpm install && pnpm build:backend
INSTALL_DIR=~/blackbox-pilot-int OWNER_KEY_FILE=~/blackbox-pilot-int/owner.key tests/slice/slice-01.sh
./blackbox demo --confirm && ./blackbox verify                       # golden order #1001 through the installed stack: passed
```

Console output of the run: `run-output.txt`; machine-readable summary: `results.json` (`status`, `observed`).

## Observed results per step

**Step 1 — owner/agent.** Login 204 with the HttpOnly session cookie; workspace `8be1eca2-f369-4389-abe1-cd2cfb9bab3c`; agent key `d6e8c5c0-bea7-43d3-a62c-43802b0a0a20` created through `POST /api/agents` and accepted on `GET /api/workspace` (200).

**Step 2 — connect, plan, backfill.** Fixture (seed 42, 40 orders) on 127.0.0.1:19182; connection `00712d35-a1a2-4706-ae56-9277610dd1c6` (secret sealed with the data key); plan `last_30_days` 2026-10-02T11:49:53.388Z .. 2026-11-01T11:49:53.388Z; `POST .../runs {backfill}` queued three worker runs (one per poll group):

| run | poll group | state | requested | loaded | committed | applied | duplicates | conflicts | rejected | pages | committed_cursor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4e9eeaed-6263-4316-8db5-f48f7c6e6aa4 | shopify:stock | completed | 0 | 6 | 12 | 12 | 0 | 0 | 0 | 1 | 24 |
| 5b119491-74f1-4074-a53a-dc81140c0541 | shopify:allocations | completed | 0 | 10 | 10 | 10 | 0 | 0 | 0 | 1 | 44 |
| c98c076b-77c8-428d-a976-eaf7bf9b8163 | shopify:orders | completed_with_gaps | 31 | 31 | 99 | 99 | 0 | 0 | 5 | 5 | 437 |

The five rejected inputs are the fixture's deliberate `SALE/PENDING` transactions: the adapter records them as explicit `unsupported_event` dead letters ("has no canonical family, recorded as unsupported, not as cash"), never as cash — hence `completed_with_gaps`, not a defect. `requested` is only set where the provider states an exact count (orders); stock/allocations report `totals_known=false`.

**Step 3 — journal and dedupe.** 437 entries for the connection (by track: commitment 65, fact 159, movement 40, reservation 14, source 159); every derived entry references its source in `input_entry_ids`, shares `correlation_id` and carries `entity_refs` (0 violations). Second backfill: 159 duplicates, 0 new records, journal unchanged (437 entries, committed_cursor 437).

**Step 4 — state via API and MCP.** Order `gid://shopify/Order/5021` (capture + completed refund). `GET /api/entities/order/<id>/state?mode=latest_committed` → 200, status `partial` (missing input `stock.basis`: the order's item has no linked stock basis, so stock values are `null`, never zero). Values compared (normalized, identical through API and the stdio MCP bridge with the official SDK client): {"captured_minor":6250,"refunded_minor":3200,"customer_net_paid_minor":3050,"provider_balance_minor":3050,"provider_available_minor":3050,"fees_minor":0,"bank_confirmed_minor":0,"shipment_status":"dispatched","currency":"EUR"}. Cursors: journal committed=437, engine applied=437 (health card agrees); fixed cutoff captured: as_of_recorded=`2026-11-01T11:50:21.000Z` (cursor 437), status `historical`. Fees are 0 because the orders connector carries no Shopify Payments ledger (separate provider connection, not part of this slice).

**Step 5 — restart and corrupted snapshot.** `./blackbox down` + `./blackbox up`; owner session still valid. Engine snapshot forced via `POST /v1/admin/snapshot` (private network, from inside the api container): 1 row (`437|46bc79f25e67534d40f989551addefc96dd81a16ab6e953772717c947a40feb0|308656` = applied_sequence|checksum|bytes), blob overwritten in `engine_snapshots`, engine restarted → log `engine.snapshot_rejected`, corrupted row deleted (0 left), tenant rebuilt from the journal. Same-cutoff query after the rebuild: identical normalized values, entry ids and evidence refs (API and MCP). `latest_committed` afterwards: status `current`, applied=437; observations recorded after the cutoff: 0 (disclosed).

**Step 6 — correction, revocation, second tenant, logs.** `order.revised` with `supersedes_entry_id` appended through `POST /api/ingest/replay` (entry `2969eb57-7b7a-4c33-a6d6-2265717104b9` supersedes `c2d8be11-4bd4-4cb3-81f1-d873173785b7`): the cutoff answer is unchanged, the current answer includes the correction and marks the original `superseded` (no double count). Agent key revoked → MCP typed 401 error and API 401 within 2 s. Second synthetic tenant `04cff41a-be67-4daa-a1d8-e50f1394389d` seeded by the host CLI (`create-tenant --seed-order`, no HTTP route) with the same external order id: owner journal shows 28 own entries and 0 from tenant B, tenant B's entry id is 404 for the owner, owner state unchanged. `./blackbox logs --run <orders run>`: 12 correlated api+worker records including `journal.batch_committed`; engine `engine.batch_applied` with committed/applied cursors; api `query.served` and `auth.access_denied`.

## Sanitized log excerpts

```
{"tenant_id":"8be1eca2-f369-4389-abe1-cd2cfb9bab3c","connection_id":"00712d35-a1a2-4706-ae56-9277610dd1c6","run_id":"c98c076b-77c8-428d-a976-eaf7bf9b8163","attempt":1,"duration_ms":44,"record_count":31,"committed_cursor":135,"journal_batch_id":"c98c076b-77c8-428d-a976-eaf7bf9b8163:1","schema_version":1,"record_id":"7ae1a363-773f-48aa-b35b-234436d43043","occurred_at":"2026-11-01T11:50:00.863Z","obs
{"tenant_id":"8be1eca2-f369-4389-abe1-cd2cfb9bab3c","connection_id":"00712d35-a1a2-4706-ae56-9277610dd1c6","run_id":"c98c076b-77c8-428d-a976-eaf7bf9b8163","attempt":1,"record_count":1,"error_code":"input_rejected","schema_version":1,"record_id":"5a459e3e-ab0f-4383-b5b3-00156fa67130","occurred_at":"2026-11-01T11:50:00.874Z","observed_at":"2026-11-01T11:50:00.874Z","level":"WARN","event_name":"sourc
{"schema_version":1,"record_id":"engine-0e76549a-1","occurred_at":"2026-11-01T11:50:56.248Z","observed_at":"2026-11-01T11:50:56.248Z","level":"WARN","event_name":"engine.snapshot_rejected","message":"snapshot checksum mismatch","component":"engine","service_version":"0.1.0-rc6","instance_id":"engine-0e76549a","scope":"workspace","error_code":"snapshot_invalid","tenant_id":"8be1eca2-f369-4389-abe1-
{"schema_version":1,"record_id":"engine-092549df-2","occurred_at":"2026-11-01T11:49:55.251Z","observed_at":"2026-11-01T11:49:55.251Z","level":"INFO","event_name":"engine.batch_applied","message":"applied 24 entries (24 with effect)","component":"engine","service_version":"0.1.0-rc6","instance_id":"engine-092549df","scope":"workspace","applied_cursor":24,"committed_cursor":24,"duration_ms":3,"recor
{"error_code":"unauthenticated","trace_id":"f0a047d2-28ed-4c9a-bc0c-e84e75e782f5","action_code":"GET","schema_version":1,"record_id":"6ec8ade8-2252-4312-b27f-61da5ffe82e6","occurred_at":"2026-11-01T11:51:24.096Z","observed_at":"2026-11-01T11:51:24.096Z","level":"WARN","event_name":"auth.access_denied","message":"Request denied","component":"api","service_version":"0.1.0-rc6","instance_id":"de1e4d3
```

## Artifacts

`step-*.json` per step (see tests/slice/README.md), `logs-*.jsonl` (records from the shared logs directory, already sanitized by the logging contract; a grep for `bbk_`/`bba_`/`bb_session=` is part of the run), `run-output.txt`, `results.json`. No key, cookie or secret appears in this directory.

## Limits of this evidence

Synthetic provider-shaped fixture only; one owner workspace plus one synthetic second tenant; the orders connector without the Shopify Payments ledger/payout groups; the Compose stack on a developer Mac (not the DIST-02/03 browser-download journey). The stack is left running after the run.
