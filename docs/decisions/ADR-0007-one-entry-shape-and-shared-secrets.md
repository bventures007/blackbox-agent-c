# ADR-0007 One journal entry shape for both ingestion paths; one secret codec

Status: accepted (P1 integration, 2026-11-01)

Context: the API replay/producer path (`packages/application/src/mapping`) and the worker connector
path (`packages/connectors/src/mapping.ts`, `ingest.ts`) were built in parallel and produced
different journal entry shapes for the same observation (nested `payload.observation` with
API-specific event types such as `movement.cash_captured` versus the flat golden payload with
`event_type = family kind`). The Rust reducers read the flat golden field names on entries whose
`event_type` is the family kind and resolve the effect-once observation key from `correlation_id`
or `connection:provider_event_id` (docs/engine.md); the nested shape would have been recorded
without effect.

Decision:
- `@blackbox/connectors` owns the single entry-draft builder (`buildEntryDrafts`, `linkDerived`,
  `recordIdFor`, `entityRefsFor`, `sanitizePayload`, `observationHash`) and the derived-track table
  (`DERIVED_TRACKS`, validated against `packages/contracts/events.json`). Every observation yields one
  Source entry plus the derived fact/commitment/movement/reservation entries with the same flat
  sanitized payload (`observation_mode` added), `event_type = kind`, `record_id` per the engine's
  record convention, `entity_refs` augmented from same-named payload identifiers (`sku -> item`), a
  shared `correlation_id` (`obs.correlation_id ?? "<connection_id>:<provider_event_id>"`),
  `derivation_rule = connectors.mapping.v1:<kind>-><track>` and `input_entry_ids`/`causation_id`
  pointing at the persisted source entry. `@blackbox/application` validates producer input
  (required typed fields per golden family, PII anchors) and delegates the shapes to that builder.
  A unit test ingests the 19 golden kinds through the worker's real `ingestObservations` with a
  capturing client and asserts byte-equality with the API `mapObservation` drafts.
- Allocations (`allocation.revised`) derive a fact only (planned fulfillment work is not a stock
  reservation); authorizations, invoice paid markers, payout announcements, return approvals and
  carrier scans never derive a movement.
- Connection secrets use exactly one codec: `@blackbox/auth` AES-256-GCM with the installation data
  key (`SECRETS_DIR/data.key` or `DATA_KEY_FILE`) and AAD `tenant_id|connection_secret|key_version`.
  The worker reads the same key file (Compose secret mount); `BLACKBOX_SECRET_KEY` is gone.
- Evidence written by the worker uses the API layout (`EVIDENCE_DIR/<tenant>/<yyyymm>/<hash>.json`,
  relative `storage_ref`) so `GET /api/evidence/:id` serves both.
- Logs: worker and engine append `records-YYYYMMDD-HH-{worker,engine}.jsonl` to the shared logs
  directory; the api collector owns `index.json` and the retention bound.
- Migrations: `schema_migrations(version, checksum, applied_at)` with the file name minus `.sql` as
  version, shared by the api CLI migrator and the wrapper's SQL fallback.

Alternatives: keep two mappings and translate in the engine (rejected: two sources of truth for
business semantics); a separate `@blackbox/mapping` package (deferred: connectors already has no
API dependencies and is the natural owner).

Evidence: tests/backend/unit/mapping.test.ts ("one mapping" block), tests/worker, reports/evidence/SLICE-01.
