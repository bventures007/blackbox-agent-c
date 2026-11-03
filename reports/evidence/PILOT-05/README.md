# PILOT-05 — Mac lifecycle, suspension, reconnect and revoked access (2026-11-03)

Install: /Users/benediktsauter/blackbox-pilot-perf (project blackbox-agent-c-perf, images 0.1.1-perf built from 5b743d4, 127.0.0.1:19180), fixture-backed Shopify connection (fixtures/shopify on 127.0.0.1:19182, reached from containers via host.docker.internal). Owner approval for the sleep test was given in chat ("Sleep test ok"). No key material in this directory (checked with a bbk_/bba_ pattern scan).

## 1. Real Mac sleep/wake (short)
`pmset sleepnow` at 19:22:51Z. pmset log: "Entering Sleep state due to 'Software Sleep'" at 20:22:57 local, DarkWake 3 s later "due to smc.sysState.Wake wifibt SMC.OutboxNotEmpty" (pmset-sleep-wake.txt). A scheduled wake needs root (sudo requires a password here), and this always-connected desktop Mac wakes itself for Bluetooth/Wi-Fi maintenance, so the real sleep lasted 3 s. The stack, health and connection state after the wake are in post-sleep-*.json (unchanged, healthy).

## 2. Long suspension (process freeze of the whole stack, 400 s)
All five containers were `docker pause`d from 19:47:34Z to 19:54:14Z (freeze-state.txt shows "Paused"), spanning the scheduled poll of the orders/fulfillments/payments/receipts group at 19:51:46Z. Observed after `docker unpause`:
- exactly one coalesced `incremental` run for the due poll group at 19:54:16Z (completed_with_gaps; counters loaded 1 / duplicates 2 / rejected 1 = the fixture's unsupported SALE transaction), no run per missed interval, the allocations group (next 19:56:12Z, not yet due) was left alone — post-unfreeze-connection-detail.json, post-unfreeze-worker-logs.json (worker events since the freeze: 1 scheduler tick, 1 run, 1 batch commit, 1 input rejection; no storm).
- capability cursors retained and advanced (last successful check 19:46:19Z → 19:54:16Z, next check 19:59:36Z with reason `scheduled`), no cursor reset, no history replaced.
- health cards 20 s and 90 s after resume: postgres, api, worker (heartbeat 0–1 s), engine (applied = committed 100610), mcp, diagnostics all `healthy`; sources `degraded` because 6 of 113 capabilities are the fixture's unsupported ones (pre-existing, truthful) — post-unfreeze-health-*.json.
- journal committed cursor unchanged (100610 before and after): no synthesized events, no double effects.
- WARN/ERROR since the freeze: one WARN `source.input_rejected` (the fixture's deliberate unsupported transaction); no ERROR, no lease/fence failure.

## 3. Revoked agent cannot revive on reconnect
Agent key `pilot-05-revoked-before-sleep` (credential 87ef277e…) was created and revoked before the sleep. After the sleep and after the freeze: API `GET /api/workspace` with that key → 401 (post-revoked-agent-api.txt); MCP Inspector CLI `tools/call get_readiness` through the stdio bridge with that key → tool error `401 unauthenticated` (post-revoked-agent-mcp.txt).

## 4. Startup model, autostart, reconnect identity, disconnect
- No launchd/LaunchAgents entry contains "blackbox" (checked `launchctl list` and ~/Library/LaunchAgents); the wrapper installs no autostart or keep-awake; browser close leaves the backend running (documented in INSTALL.*.md, docs/operations.md, tester guide).
- Different provider account on reconnect → `reauthorization_required`, cursors untouched; disconnect preserves history with stale coverage; sleep/wake coalescing, clock change and lease recovery with a fake clock: tests/worker/pipeline.test.ts and scheduler.test.ts (reports/evidence/CI-01-perf/test-worker.txt, 35/35 on 5b743d4).
- Interrupted work (worker killed mid-run → no double effect): reports/evidence/OPS-RERUN (LOCAL-09).

## Limitations
The real sleep was 3 s; the 400 s suspension is a container freeze, not OS sleep. A multi-hour sleep on a laptop was not exercised.
