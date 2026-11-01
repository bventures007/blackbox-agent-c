# ADR-0003 Journal layout, tenant scope, ordering and outbox

Status: accepted (P0)

- `journal_entries` is the single canonical five-track table (track enum: source, fact, commitment, movement, reservation). Immutable payload/link/evidence rows live in the same row plus `journal_evidence` (immutable). Both tables REVOKE UPDATE/DELETE/TRUNCATE from runtime roles and carry defensive triggers raising on UPDATE/DELETE/TRUNCATE; no FK cascades delete journal rows.
- `journal_sequence` is tenant-scoped and allocated inside the append transaction by locking the tenant row in `tenant_sequences` (`SELECT ... FOR UPDATE`). This serializes appends per tenant so a lower sequence can never commit after a higher one became visible (JOURNAL-AND-MCP §3). Cursors are `(tenant_id, journal_sequence)`.
- Deduplication: unique `(tenant_id, connection_id, provider_event_id)`; a repeat with identical content hash is a no-op delivery record in `deliveries` (mutable operational table); a repeat with different content appends nothing and opens a review case (`review_cases`, mutable) plus a `source.conflict_observed` journal entry referencing the original.
- Roles: `bb_migrate` owns schema; `bb_api`, `bb_worker`, `bb_engine` are LOGIN NOINHERIT NOBYPASSRLS. RLS is enabled and forced on all tenant tables; policies compare `tenant_id` with `current_setting('app.tenant_id', true)::uuid`, set per transaction by the application. The engine role has a documented read-all SELECT policy on journal/checkpoint tables (it serves every tenant from one process and scopes all in-memory keys by tenant).
- Outbox: `outbox` row written in the same transaction as the journal append; the worker/engine consume by `(tenant_id, journal_sequence)` cursors. Acknowledgement to producers happens only after COMMIT.
- Money: integer minor units + ISO currency; quantities: numeric(18,6) + unit string.

Alternatives: logical decoding (deferred: needs slot operations); global sequence (rejected: late-commit gap problem).
