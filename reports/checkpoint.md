# P4 checkpoint — restricted preview handover (re-run on the same Mac after the Docker restart)

Recorded 2026-11-02 (UTC). Tested implementation commit: `df8cfbb` plus the verifier fixes committed together with this checkpoint (the commit that contains this file; see `git log -1`). Acceptance records cite that commit as tested_commit; the installed archive was built from the same tree before the commit, so the promotable 0.1.0 archive must be rebuilt from the committed tree before distribution (`scripts/release/build.sh 0.1.0`).

## Verdict

**Restricted preview with three honest failures, not a verified pilot.** The owner's re-run condition was met for the user journey: from a fresh empty folder, the browser-downloaded archive (build #9) was hash-checked, installed with the bundled wrapper, the API and engine containers are healthy, the full Playwright suite passed 68/68 against the real API (desktop 1440×1000 and mobile 390×844, EN and DE), all 67 reference captures were compared in a real browser (reports/evidence/UI-01/comparison.md), and `python3 scripts/validate-delivery-profile.py` passes. The `--release` gate still fails by design (unpassed gates, no independent capability review).

Active acceptance status (83 cases; deferred 37 remain not_started):

| Status | Count |
| --- | --- |


## Evidence highlights

- Fresh-folder install: reports/evidence/INSTALL-01-b, DIST-01 (landing EN/DE with version/size/sha256/prerequisites; pending, corrupted-checksum and 404 states), DIST-03 (build and manifest checks, verify-download), INSTALL-02 (byte-identical answers across down/up, restart 17–30 s).
- Archive: release/dist/blackbox-0.1.0-mac-arm64.tar.gz, sha256 2e665fe33dd55dec245e3bd0fe356a3060fba6a004b3c818d48bd7dfe7887956, 530,045,630 bytes, bundled arm64 images (not on a registry; publication is not authorized).
- Playwright: reports/evidence/E2E/playwright-fresh-install-run6.txt (68 passed) with HTML report; earlier runs 1–5 kept with the defects they exposed.
- UI comparison: 67/67 captures in the per-capture table (26 match, 2 match with additions, 24 documented deviations, 10 intentional deviations such as EN default and pilot-only views, 5 not reproducible: planned providers/absent demo states); 126 screens, focus-trap checks 4/4.
- SLICE-01 52/52 on both installs; MCP-03 with an independent client (MCP Inspector CLI 2.13.0, SDK 1.32.2, stdio) using a UI-created agent key; LOCAL-06 runtime key rotation; HEALTH/DIAG gates incl. CLI with every container down and a 23.7 KB sanitized export with 0 canary hits; PILOT-10 no external egress during local questions.
- Ops install (ports 19185): backup + isolated restore with the recovery key, interrupted and resumed populated upgrades (0.1.0→0.1.3→0.1.4), storage thresholds, data-key rotation, evidence restriction, restart with 3,000-entry tail ready in 5 s, no-snapshot rebuild 196 s.
- Question coverage (reports/question-coverage.json): positive 24/24, missing-data 24/24, API/MCP parity 24/24 on the installed stack.
- Register: implementation and four test kinds recorded for the 14 Shopify rows on df8cfbb; live tests blocked; no independent review (self-approval is not permitted).

## Not passed, with reasons

- PILOT-09 / OPS-05 failed: 18 of 26 smoke targets missed on the shared developer host (8 vCPU / 9.7 GiB Docker VM shared with ~40 containers of other projects, host load 7–132): worst per-class p95 ≈ 7 s, success 0.8 % at fixed 40 req/s, durable ack p95 32–290 s, projection lag p95 11.4 s, engine steady RSS 1,488 MiB > 1,024, rebuild 196 s > 180. Dataset, restart, restore and peak-memory bounds hold; backpressure and durability behaved (503 with Retry-After, applied = committed after every run, golden verified). The engine RSS and rebuild time are real findings, not only host noise. Full numbers: reports/performance.json.
- SEC-02 failed: no authorized tenant export flow exists yet (retention settings and audited evidence restriction do).
- PERF-01 implemented_unverified: indexed-PostgreSQL reference-path comparison not executed in this pass.
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

1. Rebuild and re-hash the promotable archive from this commit; re-run the smoke on an idle or dedicated 4 vCPU / 8 GiB host and address engine RSS and rebuild time.
2. Implement the tenant export flow (SEC-02) and the PostgreSQL reference-path comparison (PERF-01).
3. Provide an authorized read-only Shopify store token (SLICE-02, SOURCE-01) and an independent reviewer for the register rows.
4. Owner-session checks for sleep/wake and account replacement (PILOT-05).

Status log: docs/status.md. Comparison with the other agent at identical conditions was not possible on this shared host.
