# P4 checkpoint — restricted preview handover (not a verified pilot)

Recorded 2026-11-01 (UTC). Tested implementation commit: `482bdf592a599102a5ddcc18cf4e48f176241177` (P1 integration, SLICE-01 passed) plus the verifier fixes committed with this checkpoint (see `git log`). Evidence recorded against the working tree at the time of each run is labelled as such in the per-case records.

## Verdict

This is a **restricted preview with blockers**, not a verified local pilot. The goal condition (fresh-folder install of the built archive, full Playwright suite passing, every screen compared in a real browser, every active case passed or blocked_external) was **not** reached within the 80-turn budget. Active acceptance status (83 cases):

- blocked_external: 2
- failed: 3
- implemented_unverified: 16
- not_applicable: 1
- not_started: 17
- passed: 44

Deferred cases (37) remain `not_started`. `python3 scripts/validate-delivery-profile.py` passes; its `--release` gate intentionally fails (unverified gates, no independent capability review).

## What exists and runs

- Local application: Fastify API + React/Vite UI on 127.0.0.1:19180, TypeScript worker (pg-boss), Rust engine (axum, reducers/projections/24 intents), PostgreSQL 16 with database-enforced append-only five-track journal, RLS and non-owner runtime roles; stdio MCP bridge (official SDK) with separate read-only agent keys; EN/DE UI and landing; host wrapper `./blackbox` (doctor/setup/up/down/status/logs/demo/verify/backup/restore/upgrade/diagnostics export/reset-access); versioned Compose release with bundled arm64 images.
- SLICE-01 passed on an installed release stack (archive 0.1.0-rc6): Shopify-shaped fixture -> worker -> journal/outbox -> Rust -> API and MCP agree; restart, corrupt-snapshot rebuild, late correction, agent revocation, colliding second tenant, correlated logs (reports/evidence/SLICE-01).
- Automated suites green on the committed tree (reports/evidence/CI-01): backend unit 139, backend PostgreSQL integration 49, worker 32, Rust workspace (golden checkpoints incl. property tests, adversarial variants, 24 intents positive + missing-data, snapshot/rebuild, admission), wrapper unit 51, catalogue/register/profile validators, 14 Shopify/Shopify Payments mapping artifacts.
- Ops rehearsals passed on an ops-only stack: encrypted fenced backup, isolated restore with recovery key, populated upgrade (tests/ops). On the populated release install: backup generation finalized; upgrade interrupted/resumed mid-image-load (see blockers).

## Exact commands

Install from archive (release/dist/blackbox-0.1.0-rc6-mac-arm64.tar.gz, sha256 b2068460b8c4cc32624a35687d22ad9b4f8e06509e47de4bb3eeb644aa486432, 594,309,750 bytes; note: this archive bundles the pre-integration web UI; rebuild with `scripts/release/build.sh 0.1.0` to bundle the current tree):

```bash
mkdir -p ~/blackbox-pilot && cd ~/blackbox-pilot && tar -xzf <repo>/release/dist/blackbox-0.1.0-rc6-mac-arm64.tar.gz --strip-components=1
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
Then open http://127.0.0.1:19180, sign in with the key shown once by setup, run the demo. Tests from the checkout: `pnpm install && pnpm build && cargo build --release --workspace`, then `pnpm test:backend`, `pnpm test:backend:integration` (needs the dev PostgreSQL container, see tests/backend), `pnpm test:worker`, `cargo test --workspace --release`, `bash tests/ops/wrapper-unit.sh`, `tests/slice/slice-01.sh`, `E2E_NO_MOCK=1 pnpm e2e`. Reset/recovery: `./blackbox reset-access`, `./blackbox backup-config <dir>`, `./blackbox backup`, `./blackbox restore <file>`, `./blackbox upgrade <archive>`, `./blackbox logs --since 1h`, `./blackbox diagnostics export --since 1h --output <file>`. Full details: INSTALL.en.md / INSTALL.de.md, docs/operations.md, docs/tester-guide.md.

## Resource conditions

macOS 27.2, Apple Silicon (8 cores, 24 GiB), Docker Desktop 27.3.1 VM with 8 vCPU / 7.6 GiB **shared with ~40 containers of other projects' verification stacks**. During P2–P4 verification the host load average was 600–980 and the Docker VM 40–65; PostgreSQL connections timed out (login 10–43 s), image builds stalled on registry sockets. All timing-dependent gates are therefore implemented_unverified, not failed on their merits, and not passed. A clean re-run on an idle Mac is the first follow-up.

## Blockers and failures (honest)

- SLICE-02, SOURCE-01 (live): blocked_external — no authorized Shopify store/Shopify Payments account or token available. Synthetic pipeline evidence exists.
- UI-01, DIST-03: failed in this run — the UI was first built against the mock and crashed on real envelopes; the verifier rewrote the API layer and e2e suite to the real contract (uncommitted at the time of the run, committed here) but the goal-defining fresh-install Playwright run and the per-screen browser comparison were not completed (partial: 01-auth 4/4 on the real stack; 74 real screenshots in reports/evidence/UI-01/screens; comparison.md lists matches and 15 intentional deviations without the per-capture table). Pending manifest, corrupted checksum and wrong-hash landing states were verified (DIST-01 evidence).
- PILOT-01: failed — backup-scheduler container started before enrollment keeps rewriting status to not_configured until restart. PILOT-07: failed — no host-authorized data-key rotation (versioned key metadata and lost-key refusal exist). PILOT-08: failed — no evidence restriction/redaction workflow yet (ledger table exists, no action/reconcile path).
- PILOT-09/OPS-05: implemented_unverified — corpus 348,233 entries / 50 tenants but 6,305 orders and largest-tenant 20.7% below profile minimums; no load run possible on the saturated host; driver and verdict scripts under tests/perf. Engine RSS on that corpus 1,220 MiB (> 1,024 MiB steady target) — a real finding.
- OPS-01/02, PILOT-02/03/05/06, LOCAL-08/09, DIAG-02/04/07, HEALTH-01/02/03, IMPORT-03/04, QUERY-01/02 (installed-stack parity), MCP-03 (Inspector tools/list passed; tools/call timed out under load), LOCAL-06/11, INSTALL-01/02, DIST-02, PILOT-10, DIAG-01: implemented_unverified with the exact reason in reports/acceptance.json.
- Release-blocking defect found and fixed by the ops verifier: installs on a port other than 19180 answered 403 (Origin/Host allowlist); fix committed, needs the release rebuilt (0.1.0) and re-recorded evidence.
- Integration register: implementation + contract/pipeline/recovery/tenant_isolation test events recorded for the 14 Shopify rows; live tests blocked; **no independent review exists** (self-approval is not permitted), so the selected rows are not approved. generic/replay/bank_csv/policy/runtime rows have no mapping artifacts yet.
- Comparison with the other agent at identical conditions was not possible: the other builds' containers were consuming the shared host throughout.

## Next steps for the owner

1. Re-run on an idle Mac: `scripts/release/build.sh 0.1.0`, fresh-folder install, `E2E_NO_MOCK=1 pnpm e2e`, browser comparison, tests/perf smoke, tests/ops full modes; record with scripts/acceptance/record.py.
2. Provide an authorized read-only Shopify test store token for SLICE-02/SOURCE-01.
3. Arrange an independent reviewer for the register rows.
4. Decide on the three failed PILOT gates (scheduler status fix is small; data-key rotation and redaction workflow are real work).

Per-case table: see reports/acceptance.json. Tester guide: docs/tester-guide.md. Status log: docs/status.md.
