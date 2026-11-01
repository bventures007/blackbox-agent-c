# HTTP API contract (apps/api, origin http://127.0.0.1:19180)

All JSON. Owner routes need the session cookie `bb_session` plus header `X-Blackbox-CSRF` (value from GET /api/auth/session) on non-GET requests and an exact `Origin`/`Host` allowlist. Read routes marked (A) also accept an agent key `Authorization: Bearer bba_...` (read-only grant). Errors: `{error:{code, message, retryable, details?}}`; 401 unauthenticated, 403 forbidden, 404 not found (never reveals existence across tenants), 409 conflict/revision, 422 validation, 429 throttled, 503 projection_behind/unavailable.

Common envelopes: question/state responses follow `specs/question-data-contracts.json` `common_result_envelope` plus `consistency {applied_cursor, committed_cursor, required_cursor, status, recorded_cutoff, effective_cutoff, reducer_version}`, `readiness {datasets_present, datasets_missing, sources:[{connection_id, provider, last_successful_check_at, last_new_event_at, coverage_from, coverage_to, status}]}`.

## Auth and workspace
- POST /api/auth/login {key, remember:boolean} → 204 + cookie. Throttled (5 failures / 15 min per client).
- POST /api/auth/logout → 204 (revokes session server-side).
- GET /api/auth/session → {principal:{id,kind:"owner"}, workspace:{tenant_id, display_name, locale}, csrf_token, session:{expires_at, remembered}}.
- POST /api/auth/rotate-key {current_key} → {new_key} (shown once; invalidates old verifier + all owner sessions).
- GET /api/workspace (A) → {tenant_id, display_name, locale, created_at, backups:{status}, unresolved_review_count}
- PATCH /api/workspace {display_name?, locale?: "en"|"de"} → workspace.

## Sources, import, readiness, health
- GET /api/sources (A) → {catalogue:[{provider, category, state: implemented|configured|syncing|degraded|unsupported|planned, capabilities:[{id, state, schedule, last_successful_check_at, last_new_event_at, next_check_at, next_check_reason, coverage_from, coverage_to, limitations:[]}], connections:[connection summary]}]}
- POST /api/sources/connections {provider, display_name, config:{...}, secret?:{...}} → connection.
- GET /api/sources/connections/:id (A) → {connection, health, import_plan, runs:[...], readiness}
- POST /api/sources/connections/:id/import-plan {preset: "last_30_days"|"this_year"|"last_12_months"|"custom"|"from_now", from?, to?, timezone, include_open_context:boolean} → persisted plan with resolved UTC boundaries.
- POST /api/sources/connections/:id/runs {kind: "backfill"|"incremental"|"reconcile"|"check"} → run.
- POST /api/sources/connections/:id/pause | /resume | /disconnect → connection.
- GET /api/sources/connections/:id/runs/:run_id (A) → run with counters {requested, loaded, committed, applied, failed}, phase, totals_known, percent|null, started_at, finished_at, outcome.
- GET /api/sources/readiness (A) → per-question readiness {question_id, intent, status: ready|partial|blocked, missing:[dataset ids], sources:[...]}.

## Ingestion producers
- POST /api/ingest/replay {connection_id, events:[{provider_event_id, kind, occurred_at, entity:{}, payload:{}, evidence_refs:[]}]} owner session; returns {accepted, duplicate, conflict, rejected, committed_cursor}.
- POST /api/ingest/generic — typed signed input: headers `X-Producer-Id`, `X-Producer-Timestamp`, `X-Producer-Signature` (HMAC-SHA256 over timestamp+body with the producer's secret); body {connection_id, records:[...]}.
- POST /api/ingest/bank-csv {connection_id, csv:string, mapping?} → preview {rows, parsed, ambiguous, errors} when `?preview=1`, otherwise commits.
- POST /api/ingest/policy {connection_id, policy:{version, rules}}.
- POST /api/demo/run → loads the labeled GOLDEN scenario into demo connections of the owner workspace (idempotent; never over user data: refuses if non-demo connections have data unless {confirm:true}).

## Journal, entities, evidence (A)
- GET /api/journal?track=&event_type=&record_id=&entity=<type:id>&occurred_from=&occurred_to=&recorded_from=&recorded_to=&cursor=&limit= → {entries, page:{next_cursor, snapshot_cursor, truncated}, consistency}
- GET /api/journal/:entry_id → entry with supersedes/superseded_by/derivation links.
- GET /api/entities/:type/:id/state?mode=latest_committed|at_least_cursor&cursor=&as_of_recorded=&as_of_effective= → state envelope (engine /v1/state).
- GET /api/entities/:type/:id/history?cursor=&limit= → entries.
- GET /api/search?q=&track=&from=&to=&cursor=&limit= → literal search over record ids/event types/entity refs.
- GET /api/evidence/:evidence_id → metadata + content when permitted; {status:"restricted"|"redacted"|"expired"|"unavailable", reason, restricted_at?} otherwise. GET /api/evidence/:id/content → bytes.
- POST /api/evidence/:evidence_id/restrict {reason} (owner session + CSRF, PILOT-08) → 201 {status:"restricted", evidence_id, redaction_id, already_restricted:false, content_removed, audited:true}; appends an immutable `evidence_redactions` row (action `restricted`, policy_ref `owner_restriction`) and a `security_audit` event `evidence.restricted` in one transaction, then removes the live content. Idempotent: a second call answers 200 with already_restricted:true and no new row. Journal entries and their evidence_refs are untouched; every content path (GET /api/evidence, /content → 410 evidence_restricted, MCP get_evidence) answers the explicit status. A restore that predates the restriction keeps raw access blocked (evidence-access.json, status "restricted"/reason restore_policy_unreconciled) until the owner reconciles.
- GET /api/schema → describe_business_schema.

## Questions (A)
- GET /api/questions → the 24 templates with {id, intent, group, params_schema, supported, readiness}.
- POST /api/questions/:intent {params, consistency?} → result envelope (engine /v1/query). Free text is never sent anywhere; `GET /api/questions/search?q=` only matches template titles/entities.

## Agents (owner)
- GET /api/agents → [{credential_id, name, status, created_at, last_used_at, expires_at, revoked_at, grant:"workspace.read_business"}]
- POST /api/agents {name, expires_at?} → {credential_id, key} (key shown once).
- POST /api/agents/:id/revoke → 204.
- GET /api/agents/mcp-config → copyable stdio config snippet (key placeholder, env/file instructions).

## Review cases (owner; agents GET only)
- GET /api/review/cases?state= (A) → cases; POST /api/review/cases/:id/actions {action: retry|confirm_link|reject_link|append_correction|leave_open, revision, reason, payload?} → case; 409 on stale revision.

## Settings (owner)
- GET/PATCH /api/settings/backups → {status: not_configured|scheduled|running|failed|overdue, destination_label, last_attempt_at, last_completed_at, last_cutoff, next_due_at, recoverable_age_seconds, retention:{daily:7, weekly:4}, same_device:boolean, last_restore_test_at}; POST /api/settings/backups/run → run (only to the enrolled destination).
- GET/PATCH /api/settings/retention → per evidence class days; GET/PATCH /api/settings/storage → thresholds + usage.
- GET /api/settings/security → audit summary (counts, last events; never secrets).

## Diagnostics (owner only; never agents)
- GET /api/diagnostics/health → cards (api, worker, postgres, engine, sources, mcp, diagnostics) with {state: healthy|working|degraded|unavailable|unknown, observed_at, reason, next_action, details}.
- GET /api/diagnostics/logs?level_min=&levels=&since=&until=&component=&provider=&connection_id=&run_id=&trace_id=&q=&cursor=&limit= (default 200, max 1000; last hour INFO+ newest first by default) → {records, page:{next_cursor}, retained_from, retained_to, dropped_count, state}.
- GET /api/diagnostics/logs/stream (SSE, same filters) ; GET /api/diagnostics/logs/:record_id → record + trace siblings.
- POST /api/diagnostics/debug {component, connection_id?, run_id?, minutes (1-15)} / DELETE /api/diagnostics/debug → {active, expires_at, scope}.
- POST /api/diagnostics/export {since, until, categories:[...]} → {preview:{size_bytes, truncated, unavailable}} with `?preview=1`, else application/zip attachment ≤10 MiB.
- GET /api/diagnostics/storage → volumes, usage, thresholds, retained log range/bytes.

## Internal
- GET /api/health (unauthenticated, loopback): {status, version} only — no tenant data.
