# CI-01 — automated suites re-run on the committed tree (ops verifier, 2026-11-01)

Commit under test: `482bdf592a599102a5ddcc18cf4e48f176241177` (HEAD at the start of the run). Where a suite was
re-run later on the working tree with the verifier's uncommitted changes (public-port allowlist fix, corpus-v2
generator, test-only CLI command, worker test port parameterization, `tests/worker/extend.test.ts`), the output
file header says so; such results need re-recording after the orchestrator commits.

Environment: macOS 27.2 Apple Silicon (8 cores, 24 GiB host; Docker Desktop VM 8 CPUs / 7.6 GiB shared with
other projects' containers), Docker 27.3.1, node v25.9.0, pnpm 11.20.0, cargo 1.83.0, images blackbox/*:0.1.0-rc6.
Throwaway PostgreSQL containers: `blackbox-agent-c-devpg` (19183, backend integration), `blackbox-agent-c-enginepg`
(19184, Rust), `blackbox-agent-c-workerpg` (19185 at run time, worker). Every file carries `# command`, `# started`,
`# exit` lines; an exit other than 0 is a failure.

| Output file | Command | Result | Acceptance ids named in the test headers |
| --- | --- | --- | --- |
| `test-backend-unit.txt` | `pnpm test:backend` | 3 files, 138 tests passed (139 after the public-port regression test was added) | LOCAL-01, LOCAL-05, IMPORT-01, INGEST-01, INGEST-04, PILOT-07 (data-key cipher/AAD/lost-key), PILOT-08 (PII anchoring), DIAG-03, DIAG-05, DIAG-06, SOURCE-04 (bank CSV parsing) |
| `test-backend-integration.txt` | `pnpm test:backend:integration` | 6 files, 49 tests passed | AUTH-02, LOCAL-01..05, JOURNAL-01, JOURNAL-02, TENANT-01..04, INGEST-01/02/04/05/06, SEC-03 (not applicable), MCP-01, MCP-04, MCP-05, IMPORT-01, HEALTH-01, HEALTH-02, IMPORT-04, PILOT-04, QUERY-01/02 (boundary with the engine stub), DIAG-03, DIAG-05, DIAG-06, DIAG-08, DIAG-04 (CLI fallback: logs/doctor/export without database), SOURCE-04 (bank CSV preview/commit/dedupe/ambiguous match) |
| `test-worker.txt` | `pnpm test:worker` | 3 files, 32 tests passed | LOCAL-07, INGEST-02/03/04/05, SLICE-01 (adapter steps), SOURCE-01 (synthetic subset), JOURNAL-01/02, HEALTH-01, IMPORT-02, IMPORT-05, TENANT-01, TENANT-02, PILOT-05, PILOT-06 |
| `cargo-test-release.txt` | `cargo build --release -p blackbox-engine && ENGINE_BINARY=target/release/blackbox-engine cargo test --workspace --release -- --test-threads=2` | all test binaries ok: domain golden 14 (DOMAIN-01..07 incl. proptests and adversarial variants), golden_http 4, intents_http 1 (24 intents positive + missing data = QUERY-01/02), ops_http 5 (snapshot restart, corrupt snapshot rebuild, projection_behind/admission, 1000-entry tail ≤30 s, eviction/cold reads, load sample), projections 1 | DOMAIN-01..07, QUERY-01, QUERY-02, PERF-01 (one reducer implementation), LOCAL-09, JOURNAL-02 |
| `bash_tests_ops_wrapper-unit.sh.txt` | `bash tests/ops/wrapper-unit.sh` | 51 passed, 0 failed (bash 3.2 syntax, bind refusal, doctor on a fresh dir, refusals without setup, manifest checker, compose/dockerfile invariants) | LOCAL-05, LOCAL-08 (wrapper part), DIAG-04 (doctor exit codes), DIST-03 (manifest checker) |
| `python3_scripts_validate-question-catalogue.py.txt` | `python3 scripts/validate-question-catalogue.py` | ok | catalogue consistency (preparation check) |
| `python3_scripts_integration-register.py_check.txt` | `python3 scripts/integration-register.py check` | ok (before the P1 events were appended; re-checked after append: 466 records valid) | LOCAL-10 (register part) |
| `python3_scripts_validate-delivery-profile.py.txt` | `python3 scripts/validate-delivery-profile.py` | ok (83 active, 37 deferred, 68 rows) | LOCAL-10 |
| `python3_-m_unittest_discover_-s_scripts_tests_-p_test_.py.txt` | `python3 -m unittest discover -s scripts/tests -p 'test_*.py'` | 45 tests OK | LOCAL-10 (tooling regression) |
| `python3_integrations_mappings_validate-mappings.py.txt` | `python3 integrations/mappings/validate-mappings.py` | 14 mapping artifacts valid | SOURCE-01 (mapping), LOCAL-07 |

Additional suite added by the verifier: `reports/evidence/EXTEND-01/test-worker-extend.txt`
(`tests/worker/extend.test.ts`, 1 test passed against a throwaway PostgreSQL on 19191).

Preparation validators prove consistency of the control files only; the product behaviour is evidenced by the
test suites above and by the installed-stack evidence under `reports/evidence/*`.
