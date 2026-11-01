# Local pilot implementation status

## Progress log (newest first)

### 2026-11-01 — P1 integration: SLICE-01 passed on the installed release stack
Done (uncommitted working tree on aa18411, integrator): one journal entry shape for both ingestion paths (connectors `buildEntryDrafts`; ADR-0007) with a 19-golden-kind equality test; one connection-secret codec (auth data key, AAD tenant|connection_secret|version) for api and worker; API-created queued `import_runs` per poll group executed by the worker; Compose env aliases (PG*/secret files, container bind flag), maintenance fences honoured by api (503 maintenance) and worker (idle); shared log files for worker/engine; api CLI `demo`/`verify`/`maintenance-lease`/`create-tenant`; `schema_migrations(version, checksum, applied_at)` shared with the wrapper; images api/worker/engine/backup built, release `0.1.0-rc6` archive installed into `~/blackbox-pilot-int` with `./blackbox doctor/setup/up/status`, all services healthy; `tests/slice/slice-01.sh` 52/52 PASS (reports/evidence/SLICE-01, reports/acceptance.json SLICE-01 = passed); `./blackbox demo --confirm` + `./blackbox verify` golden check passed through the installed stack. Tests: backend unit 138, backend integration 49, worker 32, Rust release build.
Open: commit of the integrated tree (not done by the integrator), SLICE-02 blocked_external, remaining acceptance cases, UI/landing verification against the real API, DIST-01–03 journey, PILOT/DIAG evidence.
Next: commit P1 with the recorded results, continue P2.

### 2026-11-01 — P1 components built, integration running
Done (uncommitted-tree test runs by the builders, to be re-verified in the integrated stack): backend core (packages/database/application/auth/logging/mcp, apps/api; 121 unit + 49 PostgreSQL integration tests), Rust engine (crates + apps/engine; golden checkpoints, adversarial variants, 24 intents, snapshot/rebuild, admission; release-binary load sample p95 125 ms engine-only), worker/connectors/fixture (32 tests through PostgreSQL; 14 Shopify/Shopify Payments mapping artifacts valid), web UI + landing + i18n (1,448 EN/DE keys; 68 Playwright tests against the mock API only), ops (wrapper, Compose, Dockerfiles, backup/restore/upgrade round trips passed with the ops-only stack, release builder/manifest checker).
Open: full-stack integration in Compose project blackbox-agent-c, SLICE-01 proof, real-API Playwright run, release archive with bundled images, acceptance evidence for every active case.
Next: integrator finishes wiring, SLICE-01 evidence under reports/evidence/SLICE-01, then P1 commit with recorded results.

### 2026-11-01 — P0 done
Done: build environment recorded (docs/build-environment.md), six ADRs (docs/decisions), binding shared contracts (packages/contracts), base journal migration with append-only triggers/RLS/roles (packages/database/migrations/0000, 0001), HTTP API contract (docs/api-contract.md), acceptance evidence recorder (scripts/acceptance/record.py). Shopify authorization feasibility: merchant-owned custom app Admin API token (read-only scopes) over GraphQL Admin API; no store/credentials are available in this environment, so SLICE-02 and all live provider rows are blocked_external.
Open: api/worker/engine/web/landing/wrapper implementation running in parallel; SLICE-01 proof; nothing runs end-to-end yet.
Next: integrate components in Compose project blackbox-agent-c (127.0.0.1:19180), run SLICE-01, commit P1.


## Current assignment

Baseline-v14 / brief 2.3: P0–P4 local pilot, then handover and stop. The owner approved a personal saved access key and local testing before deciding later product/hosting scope. Passkeys, invitations, public SaaS/servers, gateways, native packaging and large capacity certification are deferred. Read delivery-profile.json and specs/LOCAL-PILOT.md.

Product implementation has not started. The prototype is static/simulated. No production login, importer, database/engine, local MCP bridge or installer exists yet. All 120 acceptance records remain not_started: 83 active pilot cases and 37 deferred cases. The exact previous 86 case descriptions remain preserved; 11 local cases define the simpler delivery and eight DIAG cases make operational visibility a required part of it. Three DIST cases additionally require the landing-page download-to-install journey. Two SLICE and ten PILOT cases additionally require early feasibility and the seven operational refinements. No actual software, diagnostics or download artifact exists yet.

## Milestones

- [ ] P0 — environment and minimal contracts; start implementation
- [ ] P1 — local key/session, automatic owner/workspace and persisted Rust/journal slice, structured logging/CLI and SLICE-01; earliest authorized SLICE-02
- [ ] P2 — Golden Scenario, all 24 query contracts, UI/locales, import/readiness, System & Diagnostics and restart
- [ ] P3 — Shopify/Shopify Payments and supplemental producers; local agent keys/MCP
- [ ] P4 — real landing download/archive Mac install (DIST-01–03), local performance/memory, backup/restore/upgrade, DIAG-01–08/PILOT-01–10 evidence, feedback guide and handover

## Preserved foundation

Keep the append-only five-track journal, exact Rust business reducers, durable PostgreSQL/outbox, bounded RAM/cold reads, tenant/RLS boundaries, snapshots/replay and provenance. All 24 questions need positive/missing-data evidence. Keep 30-day plus disclosed open/related import defaults, exact date plans, real progress and central source/answer readiness. EN-default/full-DE UI and landing page and all English engineering content remain required.

The visual reference is unchanged: 67 desktop/mobile captures plus original assets. The catalogue remains 24 questions, 26 datasets, 11 tenant-scoped projections and 22 source/internal producers. All 127 integration rows remain; the profile selects 68 current rows and preserves all existing work history. Legacy first_release labels are broader platform plans, not current pilot gates. All rows remain unassigned/unimplemented; no provider or customer account has been used.

## Next action and prerequisites

Read START-HERE.md, AGENTS.md and the local contract, inspect the prototype and record actual tools/resources in build-environment.md. Begin P1 after the minimum P0 decisions. Synthetic work needs no merchant or LLM credentials. Later verify Shopify/Shopify Payments API grants/installation/account access, an actual compatible local MCP client and a real Apple Silicon install. Missing prerequisites are blocked proof, never success; complete unrelated work.

## Evidence policy

Keep reports/acceptance.json, question-coverage.json, performance.json and source history current with actual code commits, commands, environment and artifacts. Ordinary validators check preparation consistency only; the profile --release gate checks current evidence/selected independent approvals. No checker independently proves execution truth. Deferred requirements are not passed or automatic next work. Preserve the P4 comparison commit/report and stop for owner feedback.

Previous preparation findings and decisions are preserved in docs/history/baseline-v10-status.md, docs/history/baseline-v11-status.md and older Git tags. They describe the prior assignment, not current obligations.

## Diagnostics addition for baseline-v12

The owner approved a central System & Diagnostics view with source/run links, measured/stale health, common correlated structured logs, filters/live/history, local setup/outage access, bounded seven-day/100-MiB technical retention, 15-minute scoped debug and explicit sanitized export. The new specification defines permissions, redaction, failure behavior, performance bounds and P1–P4 implementation order. DIAG-01–08 are selected release gates; reports remain not_started. Start/Goal/build/review instructions include the new contract. Source capability selection, all previous acceptance semantics, journal/data contracts, integration history and visual references are unchanged.

The question catalogue validator, integration register check against 8d67454b4a8fd3556312bf5160ecbb0655ab0e13, delivery-profile validator and all 45 existing tooling regression tests passed. An additional consistency check confirms all 97 previous acceptance cases are byte-equivalent as parsed records, all 105 results remain not_started, and integration history/source selection, golden data and visual assets are unchanged. These checks verify specification/control consistency only; no runtime, diagnostic feature or product result is claimed.

## Landing download addition for baseline-v13

The owner required installation access directly from the landing page. The local deployment contract now defines prominent consistent EN/DE download actions, independent static landing/guide delivery before backend setup, actual versioned Mac archives with pinned prebuilt images, prerequisites, release metadata/checksums, truthful pending/unsupported/private access states and a tested browser-download-to-first-start journey. DIST-01–03 are active release gates; build/Goal/review entry points include them. This does not authorize public publication or require a native DMG. All 105 previous case definitions, source history and visual/business references are unchanged. All product evidence remains not_started.

The question catalogue validator, integration register check against 1b9de2522960cb48c5499b26d3ade28e81921f5c, delivery-profile validator and all 45 existing tooling regression tests passed. A consistency check confirms all 105 previous case definitions are unchanged, all 108 results remain not_started, and source history/business/reference assets are unchanged. These are preparation checks only; no actual downloadable product or installation proof is claimed.

## Operational refinements for baseline-v14

The owner approved seven refinements after the Buzz/source/specification audit: configured daily encrypted backups and independent recovery; explicit version-compatible updates and rule rebuilds; owner review/correction; Mac sleep/wake/account/disk behavior; protected keys and field-level content/retention policy; stronger pilot per-class latency/memory/recovery targets; and deterministic local questions with external MCP conversation. SLICE-01 proves a narrow actual persisted adapter-to-MCP/restart path before broad UI; SLICE-02 attempts real Shopify access as early as authorized. External blockers remain honest and do not halt independent work. PILOT-01–10 are mandatory current gates. All 108 prior case definitions and source/business/reference inputs are preserved; source selection and future scope are unchanged.

The smoke contract now includes hot p95 <=200 ms API / <=350 ms MCP, separate cold/history/aggregate targets, memory/lag/restart/rebuild/restore bounds and both concurrency/fixed-arrival measurements. These are unmeasured acceptance goals, not capacity claims. All reports remain not_started. The question catalogue validator, register check against d989fcea99f8241e5d78963166d5e91be1486810, delivery-profile validator and all 45 existing tooling regression tests passed. Additional consistency checks confirm all 108 previous cases are unchanged, all 120 results remain unexecuted, prior smoke targets were not loosened, deferred benchmark profiles are identical and source history/business/reference assets are preserved. These are specification/control checks, not product or performance evidence.
