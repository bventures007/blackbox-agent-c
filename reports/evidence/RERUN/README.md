# P4 re-run (2026-11-01, second verification pass)

Verifier re-run of the P4 goal condition on the same developer Mac after the first restricted-preview handover
(`reports/checkpoint.md`). Everything in this directory and in the per-case directories referenced from
`reports/evidence/results-rerun.json` was produced by the commands listed there, on the commit named there.

## Environment events (host conditions are part of the evidence)

| Time (UTC) | Event |
| --- | --- |
| 16:46 | Start of the re-run. `uptime`: load averages 172 / 226 / 386 on 8 cores (24 GiB; Docker Desktop VM shared with ~40 containers of other projects: `blackbox-a*`, `blackbox-agent-a*`, `blackbox-b*`, `reality-local-site-main` — never touched). |
| 16:46–17:0x | Owner restarted Docker Desktop (announced by the coordinator). Every docker/compose command failed or hung during this window; none of those failures is a product defect. The verifier paused container work, polled `docker info` and resumed afterwards. |
| 16:54 | load averages 129 / 131 / 271; 16:55: 214 / 153 / 272 (other projects' builds). |
| 17:09 | Docker Desktop still not answering: its restart is blocked on a macOS administrator-privileges prompt ("Docker Desktop requires privileged access to configure privileged port mapping") that only the owner can confirm. Load averages 12.6 / 35 / 126 with the VM down. Verifier continued with non-container work (PILOT-07 data-key rotation implementation, unit tests) and kept polling. The previous verifier's `./blackbox upgrade --resume` on the old ops install (still in `docker load api.tar` since ~13:00) died at 16:49:37Z with `Bad Gateway ... /images/load` — recorded by its own log `reports/evidence/OPS-02/upgrade-run2-resume.txt` (environment event, not a product defect; that install stays in the interrupted `images` phase with the fence kept, which is the documented behaviour). |
| 18:14 | Docker Desktop still down (admin prompt untouched for 88 min); load averages 4.7 / 5.9 / 7.7 (idle host, exactly the condition the re-run was waiting for). Container-dependent steps (build, fresh install, Playwright, browser comparison, MCP/ops/perf gates) could not start. |
| 19:16 | Docker Desktop still down after 2 h 30 min (admin prompt PID 17474 untouched); load 4.2 / 4.3 / 4.5. The verifier stopped waiting and handed over: every container-dependent step of this pass is still to do, all code fixes and the draft results-rerun.json are on disk (uncommitted). |

## Defects found and fixed before the final build (details in `docs/status.md`)

- Engine container healthcheck stayed `unhealthy` for good after one transient PostgreSQL error: `TenantSlot.last_error` was set on a failed tail read and never cleared on the next successful read, so `/health` reported `degraded` forever (`crates/projections/src/engine.rs`). Fixed: cleared on recovery with an `engine.tail_recovered` log event.
- `./blackbox backup-config` on a running stack left the pre-enrollment `backup-scheduler` container with the placeholder destination mount; it rewrote `status.json` to `not_configured` every 10 minutes (PILOT-01). Fixed: the wrapper recreates the scheduler with the enrolled destination before writing the `scheduled` status.
- PILOT-08: no owner action existed to restrict raw evidence. Added `POST /api/evidence/:id/restrict {reason}` (ledger row + audit in one transaction, content removed after commit, explicit `restricted` status on API/MCP/UI paths, idempotent) with an integration test.
- PILOT-07: no host-authorized data-key rotation existed. Added `./blackbox rotate-data-key [--resume]` (fenced, resumable phases in `data/state/key-rotation.json`) backed by `api cli rotate-data-key` (one transaction re-sealing every connection/producer secret, verified with the candidate before COMMIT, audited per tenant), the versioned key layout `data.key.version` + `anchor.key` (anchors stay joinable), Compose secret mounts and backup inclusion; unit + integration tests (`tests/backend/unit/auth-and-plans.test.ts`, `tests/backend/integration/sources.test.ts`). Runtime proof on an installed stack still pending (Docker).
- Register: the 14 Shopify rows reference `crates/projections/src/engine.rs` and `packages/mcp/src/server.ts`; both changed, so `invalidate` events were appended (`integrations/history.jsonl`, INTEGRATIONS.md regenerated). They need a new implementation event on the committed revision plus reruns of the four test kinds before counting again.
