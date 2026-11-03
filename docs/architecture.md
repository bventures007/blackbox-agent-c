# Architecture — backend core (database, application, auth, logging, API, MCP)

This document describes the implemented backend core. Other components (web UI, worker, Rust engine,
connectors, Compose release) are documented by their own sections/files (`docs/engine.md`,
`docs/connectors.md`, `docs/ui.md`, `docs/release.md`, `docs/operations.md`). Binding inputs:
`docs/api-contract.md`, `packages/contracts/*.json`, ADR-0001..0006.

## Process layout

```
browser / MCP client ──HTTP 127.0.0.1:19180──▶ apps/api (Fastify 5)
                                               │  owner session + agent bearer auth, CSRF/Origin/Host
                                               │  zod-validated routes, static web UI + /landing
                                               ├─▶ packages/application  (ingestion, journal reads, readiness,
                                               │     import plans, bank CSV, signed input, review, questions)
                                               ├─▶ packages/auth         (keys, sessions, throttle, data key)
                                               ├─▶ packages/logging      (record contract, redaction, collector, query)
                                               ├─▶ packages/database     (pool, tenant transactions, migrations)
                                               │        └─▶ PostgreSQL 16 (RLS-forced, append-only journal)
                                               └─▶ engine client ──X-Engine-Token──▶ Rust engine (engine:7070 / ENGINE_URL)
packages/mcp (stdio) ──Bearer bba_…──▶ apps/api (same authorized services; no direct DB access)
```

## packages/database

- `createPool(url)` — one `pg.Pool` per runtime role (`DATABASE_URL` = `bb_api`). Passwords only in
  connection strings/env, never on the command line.
- `withTenant(pool, tenantId, fn)` — the only way application code touches tenant tables: `BEGIN;
  SELECT set_config('app.tenant_id', $1, true); … COMMIT`. The setting is transaction-local, so a
  pooled connection carries nothing to the next transaction (verified by TENANT-03). The caller must
  have verified the principal's workspace first; a payload `tenant_id` is never used.
- `withAuthenticator(pool, fn)` — sets `app.auth_context='authenticator'` for the single transaction
  that resolves a credential/session before the workspace is known. Only the identity tables of
  migration 0002 honour this context; business tables stay closed.
- `withInstallation(pool, fn)` — tables without tenant scope (`login_throttle`, probes).
- RLS and indexes: PostgreSQL uses an operator as an index condition below the row-security barrier
  only when its function is LEAKPROOF. `0000_roles.sql` therefore marks `jsonb_contains(jsonb, jsonb)`
  (`@>`) LEAKPROOF so entity reads (`entity_refs @> '{"order": …}'`) use the GIN index
  `journal_entries_entity_idx` as `bb_api`/`bb_engine` instead of scanning the tenant's journal; the
  policies still filter every row (ADR-0008; regression test `apps/engine/tests/rls_gin_index.rs`).
- `runMigrations(url)` — applies `migrations/NNNN_*.sql` in order with a `schema_migrations`
  (name, checksum) table under an advisory lock; a modified applied file is refused. `0000_roles.sql`
  is executed separately by `bootstrapRoles` as the superuser; role passwords are read from
  `BB_MIGRATE_PASSWORD`, `BB_API_PASSWORD`, `BB_WORKER_PASSWORD`, `BB_ENGINE_PASSWORD` and passed as
  bind parameters into a transaction-local setting (never inside SQL text or argv).
- `schema.ts` — drizzle mirror of the mutable tables (0002/0003); plain SQL stays the source of truth.

### Migrations added by this component

| File | Content |
| --- | --- |
| `0002_identity.sql` | `principals`, `credentials` (verifier, lookup prefix, purpose, status, expiry, revocation), `sessions` (hash, csrf, absolute/idle expiry, remembered), `login_throttle`, `security_audit` (append-only, triggers), `producer_credentials` (HMAC secrets encrypted), `producer_nonces` (replay protection). RLS forced; policies `tenant_scope` with authenticator context; grants to `bb_api` only. |
| `0003_operations.sql` | `workspace_settings`, `import_plans` (resolved UTC `[requested_from, initial_cutoff)`, timezone, preset, revisions), `import_runs` (kind/phase/state, counters requested/loaded/committed/applied/failed/duplicates, `totals_known`, outcome), `capability_health` (last successful check ≠ last new event, next check + reason, coverage interval/state/history kind, limitations), `review_cases`/`review_actions` (revisioned, history jsonb), `debug_sessions`, `backup_status`, `retention_policies`, `storage_thresholds`, `evidence_redactions` (append-only ledger). |
| `0004_scoped_references.sql` | Composite `(tenant_id, id)` unique constraints + foreign keys so a reference can never point into another tenant (FK lookups bypass RLS). |

Policies in 0002/0003 use `NULLIF(current_setting('app.tenant_id', true), '')::uuid`: after a
transaction-local `set_config`, PostgreSQL reports `''` (not NULL) on the same connection. The
binding 0001 policies keep the plain cast; an unscoped statement on those tables therefore fails
closed with `22P02` instead of returning rows — never other tenants' data. The application never
issues unscoped statements against 0001 tables.

### Roles and append-only enforcement

`bb_migrate` owns every object. `bb_api`/`bb_worker`/`bb_engine` are `NOINHERIT NOBYPASSRLS`
without `UPDATE/DELETE/TRUNCATE` on `journal_entries`, `journal_evidence`, `security_audit`,
`evidence_redactions`; defensive triggers reject mutation even for the owner/superuser. The only
append path is `append_journal_entries(jsonb)` (0001): sequences are allocated under the tenant row
lock, so `tenant_sequences.last_sequence` is a committed high-water mark usable as a snapshot.

## packages/logging

Implements `packages/contracts/log-record.json`: `sanitizeRecord` drops unknown keys, enforces
types, redacts credential-looking strings (`bbk_`/`bba_`/argon2 verifiers/Authorization/cookies/
connection strings/URLs with credentials/e-mail addresses/64-hex/personal paths), escapes control
characters and `<>`, clips strings to 512 chars (flagged `truncated`) and caps a record at 16 KiB.
`createLogger` emits JSON through pino to stderr and to sinks; DEBUG is emitted only while an
unexpired `DebugGate` session matches component/connection/run; repeated identical WARN/ERROR are
aggregated per minute with a visible count. `FileCollector` writes `LOGS_DIR/records-YYYYMMDD-HH.jsonl`
through a bounded async buffer (drops counted, DEBUG/INFO first), maintains `index.json` (per-file
min/max time, counts) and enforces 7 days / 100 MiB total including the index (size during
ingestion, age at start and hourly). `queryLogs` is a bounded cursor query (newest first,
`(occurred_at, record_id)` cursor, default 200/max 1000, default last hour INFO+), `followLogs`
tails the files, `getLogRecord` returns a record with its trace siblings.

## packages/auth

- Owner key `bbk_` + 43 base64url chars (32 CSPRNG bytes); agent key `bba_…`. Only an argon2id
  verifier (64 MiB, t=3) plus an 8-char lookup prefix is stored. A successful agent-key verification
  (key hash → credential id) is reused for ≤10 min and concurrent misses share one in-flight argon2
  run (the former 5 s TTL re-ran the ≈100–200 ms hash twelve times a minute per key and saturated the
  api container under the smoke profile); credential/session status is re-read from PostgreSQL on
  every request, so revocation is effective immediately and streams re-check every 2.5 s.
- `AuthService.setup` is atomic/idempotent (advisory lock + single-owner unique index): one workspace
  + owner + key; the key is returned once to the caller (CLI prints it on the terminal only).
- Sessions: opaque 256-bit id in `bb_session` (HttpOnly, SameSite=Lax, Path=/; `Max-Age` only when
  remembered). Server-side row with absolute/idle expiry: remembered 30 d / 7 d idle, ordinary 8 h.
- Login throttle: 5 failures per 15-minute fixed window per client (hash of IP + user agent), 429
  with `Retry-After`; no partial-match disclosure.
- CSRF: double-submit header `X-Blackbox-CSRF` + exact `Origin` allowlist on every state-changing
  owner request; exact `Host` allowlist on every `/api` request (`127.0.0.1:PORT`, `localhost:PORT`).
- Rotation requires the current key, revokes the old verifier and all owner sessions. Host-only
  reset requires read access to `SECRETS_DIR/data.key`, rotates the owner key, revokes all sessions
  and agent keys, and appends a redacted `security_audit` row. No HTTP route can reset.
- Data key: 32 bytes at `SECRETS_DIR/data.key` (0600/0700), AES-256-GCM with AAD
  `tenant_id|purpose|key_version` for connection and producer secrets; missing/corrupt/world-readable
  key → actionable `DataKeyError`, never regenerated over existing data (ingestion and connection
  creation are disabled with a 503 that names the action). Per-tenant HKDF-derived HMAC keys produce
  PII anchors (`anc_…`) for canonical payloads.

## packages/application

- **Mapping** (`src/mapping/`): validation/description table for the 19 golden kinds (required typed
  fields, entity keys, semantic notes) plus PII anchoring; the journal entry shapes come from the ONE
  builder in `@blackbox/connectors` (`buildEntryDrafts`, ADR-0007): one Source entry per observation
  (`event_type = kind`, flat sanitized payload + `observation_mode`, `record_id` per the engine
  convention, `entity_refs` augmented from payload identifiers, `correlation_id` = producer value or
  `<connection_id>:<provider_event_id>`) plus the derived fact/commitment/movement/reservation entries
  of `DERIVED_TRACKS` with the same payload, `derivation_rule = connectors.mapping.v1:<kind>-><track>`
  and `input_entry_ids`/`causation_id` = the persisted source entry. Semantics: authorizations are
  facts only; captures/fees/refunds/payouts/bank credits are cash movements; invoice payment markers
  never create cash; credit notes and payout announcements are commitments; return approval is
  intent, receipt/restock are goods movements; pending refunds are provider holds (reservation
  track) released on completion; allocations are planned work (fact only). PII keys (and any
  `*_name/_email/_phone/_address/_street/_iban`) become keyed anchors; `tenant_id`, `api_key`,
  `token`, … are dropped. Content hash = SHA-256 of canonical JSON of kind/occurred_at/source_time/
  record_id/entity/payload (identical on both paths).
- **Ingestion** (`IngestionService.ingest`) — the only writer: per observation one tenant transaction:
  connection check (RLS) → mapping/validation → `deliveries` insert `ON CONFLICT DO NOTHING` (dedupe
  boundary) → raw observation stored as evidence (`EVIDENCE_DIR/<tenant>/<yyyymm>/<id>.json`, hash +
  size in `journal_evidence`) → source entry → derived entries with `input_entry_ids`/`causation_id`
  → delivery updated with entry ids → COMMIT → `journal.batch_committed` log with
  `committed_cursor`, `record_count`, `journal_batch_id`. Duplicate = same identity+hash (attempts++
  only). Conflict = same identity, different hash → `source.conflict_observed` entry referencing the
  original + `review_cases` row (`provider_content_conflict`, upsert by identity). Producer
  `evidence_refs` naming earlier `provider_event_id`s resolve to their entry/evidence ids.
- **Journal reads** (`JournalService`): snapshot pagination over `(tenant, journal_sequence)` with the
  committed high-water mark; cursor tokens carry the tenant and are rejected for any other tenant.
- **Readiness** (`ReadinessService`): datasets present = families of committed source entries (+
  `identity` when entries carry entity links, `coverage` when a capability reported a successful
  check); per question `ready`/`partial`/`blocked` with exact missing datasets and the sources used.
  Attached to every served state/answer, so it is memoized per tenant (committed cursor + 5 s) and
  its refresh reads the distinct event types through a recursive loose index scan on
  `journal_entries_event_idx` (`JournalService.presentEventTypesIndexed`) instead of a GROUP BY over
  the journal (PERF-01 follow-up: the former refresh was a full-table scan on the hot path).
- **Import plans** (`resolveImportPlan`): presets resolved once to UTC `[requested_from,
  initial_cutoff)` in the chosen IANA zone (rolling 30×24 h; Jan 1 local; calendar-month subtraction
  with end-of-month clamp; local midnight for custom; strict from-now with explicit opening-state
  restriction). Plans are revisioned per connection; the workspace keeps its first history start as
  the proposal for later sources.
- **Connections/runs** (`ConnectionService`): connection rows with the sealed secret (`@blackbox/auth`
  codec, AAD `tenant|connection_secret|key_version`); `queueRuns` creates the queued `import_runs`
  rows the worker executes (one per poll group with `checkpoint.poll_group`, `capability_scope`;
  `check` = one credential check; 409 while a run of that kind is active; 422 for producer-driven
  providers without polling).
- **Engine client**: typed `EngineClient` (health/state/query/history/summary/schema) over HTTP with
  `X-Engine-Token`; `ENGINE_URL=stub` selects a clearly labelled test stub that answers
  `projection_behind` for state/query/summary, replays journal history and builds the schema from
  the contracts. No financial reducer exists in TypeScript.
- **Questions** (`QuestionService`): per-intent strict zod schemas generated from the 24 contract
  questions (entity params from datasets, common scope params, small override table); free text is
  never forwarded; results carry the common envelope plus readiness; engine failures become an
  explicit `unavailable` answer with the error code.
- **Bank CSV**: `date;amount;currency;reference;counterparty;booking_text`; deterministic row
  identity (hash of row content); row payloads are pure row content so re-imports are duplicates;
  payout matches become separate `bank.match_recorded` observations (basis reference|amount);
  ambiguous matches open `ambiguous_bank_match` review cases.
- **Signed input**: HMAC-SHA256 over `${timestamp}.${body}`, ±5 min window, each signature accepted
  once (`producer_nonces`), producer bound to exactly one connection; secrets encrypted with the data
  key.
- **Review**: owner-only, revision-checked, idempotent actions; decisions append `review.decision`
  facts with actor/reason/provenance and `supersedes_entry_id`.

## apps/api

Fastify 5 bound to `127.0.0.1` only (`HOST` other than `127.0.0.1` is refused at config time).
Routes exactly as in `docs/api-contract.md`; guards: `requireOwner` (session + Host + Origin/CSRF on
non-GET), `requireRead` (owner or read-only agent; agents GET-only except `POST /api/questions/:intent`).
Errors: `{error:{code,message,retryable,details?}}`. SSE log stream re-checks authorization every
2.5 s and ends within 5 s of revocation. Static: `apps/web/dist` at `/` (SPA fallback) and
`apps/landing/dist` at `/landing` when present. Maintenance fences written by the host wrapper under
`FENCE_DIR` (`writers.paused.json` → every non-GET `/api` route except login/logout/diagnostics
answers `503 maintenance` with `Retry-After`; `evidence-access.json {blocked:true}` → evidence routes
answer `restricted`/423 until the owner reconciles a restore). CLI (`apps/api/dist/cli.js`): `setup`,
`rotate-key`, `reset-access --yes`, `create-agent-key --name`, `migrate`, `bootstrap`, `logs`, `doctor`
(exit 0/1/2), `diagnostics export`, `demo` (golden scenario through the replay path), `verify`
(golden order #1001 state through the shared engine client; exit 0 only when physical/available
stock 112, captured 11900, fees 350, refunded 2380, bank-confirmed 9170 match), `maintenance-lease
acquire|release|status` (`maintenance_lease` table, migration 0101) and the test-only `create-tenant
--name [--seed-order <id>]` (second synthetic workspace created directly in the database, never
reachable over HTTP) and `create-tenant-agent-key --tenant <uuid> --name <n>` (read-only agent key for such a
synthetic workspace; performance/isolation drivers only). Health cards and the export bundle are built in `src/diagnostics.ts`.

### Environment

| Variable | Meaning |
| --- | --- |
| `HOST` | must be `127.0.0.1` (default). Single exception: `0.0.0.0` together with `BLACKBOX_CONTAINER_BIND=1`, set only by the Compose service whose port Docker publishes on the host loopback alone (`127.0.0.1:19180`; the wrapper refuses any other bind) — inside the container the interface is the only route from that publish. |
| `PORT` | default `19180` (container listener) |
| `BLACKBOX_PUBLIC_PORT` | the port Docker publishes on the host loopback (`./blackbox setup --port N`; Compose passes `${BLACKBOX_PORT}`); defaults to `PORT`. The Host/Origin allowlists accept both ports — without it an install on a non-default port answered 403 to every request (found 2026-11-01) |
| `DATABASE_URL` | `bb_api` connection string; the Compose release instead sets `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER` + `PGPASSWORD_FILE` (password as a secret file, never in env/argv) |
| `MIGRATE_DATABASE_URL` | `bb_migrate` connection string (CLI `migrate`, doctor migration check); Compose: `PGMIGRATE_USER` + `PGMIGRATE_PASSWORD_FILE`; `MIGRATIONS_DIR` overrides the migration directory |
| `FENCE_DIR` | host-wrapper fence directory (`/data/state`) |
| `DATA_KEY_FILE` | alias: `SECRETS_DIR` = its directory (`/run/secrets`) |
| `LOG_DIR`, `WEB_DIST_DIR`, `LANDING_DIST_DIR`, `BLACKBOX_VERSION` | Compose aliases for `LOGS_DIR`, `WEB_DIST`, `LANDING_DIST`, `SERVICE_VERSION` |
| `BLACKBOX_REPO_ROOT` | root holding `packages/contracts`, `specs/question-data-contracts.json`, `GOLDEN-ORDER-TO-CASH.json` (`/app` in the image) |
| `BB_SUPERUSER_URL`, `BB_*_PASSWORD`, `BB_DATABASE` | CLI `bootstrap` only |
| `SECRETS_DIR` | holds `data.key` (0600) |
| `EVIDENCE_DIR`, `LOGS_DIR`, `SNAPSHOT_DIR` | volumes |
| `ENGINE_URL` | `http://engine:7070` (default) or `stub` |
| `ENGINE_TOKEN` / `ENGINE_TOKEN_FILE` | shared secret for the engine |
| `WEB_DIST`, `LANDING_DIST` | static build directories (optional) |
| `LOG_LEVEL`, `LOG_CAP_BYTES`, `LOG_RETENTION_DAYS` | logging bounds (≤100 MiB, ≤7 days) |
| `SERVICE_VERSION`, `INSTANCE_ID` | log metadata |

## packages/mcp

stdio server on `@modelcontextprotocol/sdk`: tools `describe_business_schema`,
`list_journal_entries`, `get_journal_entry`, `get_entity_history`, `search_events`,
`get_business_state`, `get_evidence`, `query_business`, `answer_question`, `get_readiness`. It calls
the API with `BLACKBOX_AGENT_KEY` or `BLACKBOX_AGENT_KEY_FILE` (argv keys and owner keys are refused),
base `BLACKBOX_API_URL` (default `http://127.0.0.1:19180`), logs only to stderr; failures are typed
`{error:{status,code,message,retryable}}`.

## Tests

`pnpm test:backend` (unit: mapping per family, logging contract/redaction/rotation/query, keys,
data key, origin allowlist, import plans incl. DST, bank CSV, signed input, intent schemas) and
`pnpm test:backend:integration` (real PostgreSQL via Docker: JOURNAL-01/02, TENANT-01..04,
INGEST-01/02/04/05/06, AUTH-02, LOCAL-01..05, MCP-01/04/05, DIAG-03/05/06/08, IMPORT-01, HEALTH-01,
PILOT-04, QUERY-01/02 at the engine boundary). Each test file names its acceptance ids. SEC-03 is
not applicable: no AI/e-mail extraction exists. Positive QUERY-01 results require the Rust engine;
with the stub every answer is an explicit `unavailable`/`projection_behind`.
