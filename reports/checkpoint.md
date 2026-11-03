# P4 checkpoint — restricted preview handover (re-run on the same Mac after the Docker restart)

Recorded 2026-11-02 (UTC). Tested implementation commit: `90a0fd23af5e866e3f3b1df173a5545dd252ce05` (re-run evidence) and the promotable archive built from exactly that commit. Final archive: `blackbox-0.1.0-mac-arm64.tar.gz`, sha256 `6c8a9503252c5bff74b44579289009cc59885fcfbf81a6eb8eccbf7a01cb6114`, 530,036,455 bytes, bundled arm64 images, manifest check PASS. It was downloaded from the independently served landing into a new empty folder, hash-checked, installed (`./blackbox doctor/setup/up`), demo-verified against the golden values and passed the full Playwright suite 68/68 with api and engine healthy (reports/evidence/INSTALL-01-committed, DIST-03, E2E/playwright-final-committed-archive.txt).

## Verdict

**Restricted preview with two honest failures (PILOT-09, OPS-05), not a verified pilot.** The owner's re-run condition was met for the user journey: from a fresh empty folder, the browser-downloaded archive (build #9) was hash-checked, installed with the bundled wrapper, the API and engine containers are healthy, the full Playwright suite passed 68/68 against the real API (desktop 1440×1000 and mobile 390×844, EN and DE), all 67 reference captures were compared in a real browser (reports/evidence/UI-01/comparison.md), and `python3 scripts/validate-delivery-profile.py` passes. The `--release` gate still fails by design (unpassed gates, no independent capability review).

Active acceptance status (83 cases; deferred 37 remain not_started):

| Status | Count |
| --- | --- |
| blocked_external | 2 |
| failed | 2 |
| implemented_unverified | 1 |
| not_applicable | 1 |
| passed | 77 |


## Evidence highlights

- Fresh-folder install: reports/evidence/INSTALL-01-b, DIST-01 (landing EN/DE with version/size/sha256/prerequisites; pending, corrupted-checksum and 404 states), DIST-03 (build and manifest checks, verify-download), INSTALL-02 (byte-identical answers across down/up, restart 17–30 s).
- Archive (promotable, from the committed tree): release/dist/blackbox-0.1.0-mac-arm64.tar.gz, sha256 6c8a9503252c5bff74b44579289009cc59885fcfbf81a6eb8eccbf7a01cb6114, 530,036,455 bytes, bundled arm64 images (not on a registry; publication is not authorized). The earlier build #9 (sha256 2e665fe3…) used for most re-run evidence came from the same code before the commit and is superseded.
- Playwright: reports/evidence/E2E/playwright-fresh-install-run6.txt (68 passed) with HTML report; earlier runs 1–5 kept with the defects they exposed.
- UI comparison: 67/67 captures in the per-capture table (26 match, 2 match with additions, 24 documented deviations, 10 intentional deviations such as EN default and pilot-only views, 5 not reproducible: planned providers/absent demo states); 126 screens, focus-trap checks 4/4.
- SLICE-01 52/52 on both installs; MCP-03 with an independent client (MCP Inspector CLI 2.13.0, SDK 1.32.2, stdio) using a UI-created agent key; LOCAL-06 runtime key rotation; HEALTH/DIAG gates incl. CLI with every container down and a 23.7 KB sanitized export with 0 canary hits; PILOT-10 no external egress during local questions.
- Ops install (ports 19185): backup + isolated restore with the recovery key, interrupted and resumed populated upgrades (0.1.0→0.1.3→0.1.4), storage thresholds, data-key rotation, evidence restriction, restart with 3,000-entry tail ready in 5 s, no-snapshot rebuild 196 s.
- Question coverage (reports/question-coverage.json): positive 24/24, missing-data 24/24, API/MCP parity 24/24 on the installed stack.
- Register: the 14 Shopify rows were invalidated on 2026-11-03 because a bound Rust artifact changed in the follow-up; implementation and the four test kinds must be re-recorded on the new commit; live tests blocked; no independent review (self-approval is not permitted).

## Not passed, with reasons

Follow-up on 2026-11-03 (same commit lineage): SEC-02 now passes (authorized tenant export with audit, two-tenant isolation test, exercised on the install); PERF-01 now passes (EXPLAIN evidence, indexed-SQL reference agrees with the API for 200 hot and 36 cold orders, a full-journal scan on the readiness hot path was removed, reducers exist only in Rust). The engine's no-snapshot rebuild dropped from 196 s to 45 s and steady memory to about 1.1 GiB on a corpus that grew to roughly 900k entries, but the full smoke protocol still fails on this shared host (9 of 26 targets hold; see reports/performance.json and reports/evidence/PILOT-09-followup). Evidence: reports/evidence/SEC-02, PERF-01, PILOT-09-followup.

- PILOT-09 / OPS-05 failed: 18 of 26 smoke targets missed on the shared developer host (8 vCPU / 9.7 GiB Docker VM shared with ~40 containers of other projects, host load 7–132): worst per-class p95 ≈ 7 s, success 0.8 % at fixed 40 req/s, durable ack p95 32–290 s, projection lag p95 11.4 s, engine steady RSS 1,488 MiB > 1,024, rebuild 196 s > 180. Dataset, restart, restore and peak-memory bounds hold; backpressure and durability behaved (503 with Retry-After, applied = committed after every run, golden verified). The engine RSS and rebuild time are real findings, not only host noise. Full numbers: reports/performance.json.
- PILOT-05 implemented_unverified: real Mac sleep/wake/reboot and provider-account replacement need the owner's session and an authorized account.
- SLICE-02, SOURCE-01 blocked_external: no authorized Shopify store or token. SEC-03 not_applicable (no extraction feature).

## Environment events

Docker Desktop restart on 2026-11-01 ~16:46Z left the daemon down for 2.5 h behind a macOS admin prompt; after it returned (daemon 29.9.2) the re-run executed. All measurements are from this one developer Mac, never from a separate machine or the contract's dedicated 4 vCPU / 8 GiB host.

## Exact commands

```bash
mkdir -p ~/blackbox-pilot && cd ~/blackbox-pilot && tar -xzf <download>/blackbox-0.1.0-mac-arm64.tar.gz --strip-components=1
```
```bash
./blackbox doctor
```
```bash
./blackbox setup
```
```bash
./blackbox up
```
Open http://127.0.0.1:19180, sign in with the key shown once by setup, run the demo, ask a question. Recovery and maintenance: `./blackbox backup-config <dir>`, `./blackbox backup`, `./blackbox restore <file>`, `./blackbox upgrade <archive>`, `./blackbox rotate-key`, `./blackbox rotate-data-key`, `./blackbox reset-access`, `./blackbox logs --since 1h`, `./blackbox diagnostics export --since 1h --output <file>`. Tests from the checkout: `pnpm install && pnpm build && cargo build --release --workspace`, then `pnpm test:backend`, `pnpm test:backend:integration`, `pnpm test:worker`, `cargo test --workspace --release`, `bash tests/ops/wrapper-unit.sh`, `tests/slice/slice-01.sh`, `E2E_NO_MOCK=1 pnpm e2e`, `node tests/perf/smoke.mjs`. Guides: INSTALL.en.md / INSTALL.de.md, docs/operations.md, docs/tester-guide.md.

## Remaining blockers and next steps

1. Re-run the performance smoke on an idle or dedicated 4 vCPU / 8 GiB host and address engine RSS and rebuild time.
2. Reduce the per-entry metadata floor in the engine and the PostgreSQL work per request; re-run the smoke on a quiet host.
3. Provide an authorized read-only Shopify store token (SLICE-02, SOURCE-01) and an independent reviewer for the register rows.
4. Owner-session checks for sleep/wake and account replacement (PILOT-05).

Status log: docs/status.md. Comparison with the other agent at identical conditions was not possible on this shared host.
