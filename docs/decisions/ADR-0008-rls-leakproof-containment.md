# ADR-0008 Mark `jsonb_contains` LEAKPROOF so entity reads use the GIN index under row-level security

Status: accepted (P4, PILOT-09 follow-up on the fresh perf install of commit 9b64931)

## Context

Every entity-scoped read of the journal (`/api/entities/:type/:id/history`, the engine's cold/evicted-history
entity read `crates/storage/src/lib.rs::entity_entries` and its count, the journal filter `entity=`) selects
`journal_entries` rows with `entity_refs @> '{"<type>": "<id>"}'::jsonb`. The table carries the GIN index
`journal_entries_entity_idx (entity_refs jsonb_path_ops)` for exactly this predicate, and RLS is enabled and
forced with the `tenant_scope` policy for `bb_api`/`bb_worker` and the read-all policy for `bb_engine` (ADR-0003).

Measured on the 50-tenant / 552,798-entry smoke corpus (reports/evidence/PILOT-09-perf/explain-history-query.txt,
explain-alternatives.txt): as the superuser the planner uses the GIN index (69 rows, 4 ms, 362 buffers). As
`bb_api` it never does: `jsonb_contains` is not marked LEAKPROOF, so PostgreSQL may evaluate it only above the
security barrier and cannot push it into an index condition — the history query walked the tenant's whole
journal through `journal_entries_tenant_sequence_key` (276,694 rows removed by filter, 31,067 buffers, 470 ms on
an idle database), and `SET enable_seqscan = off` only moved it to a tenant-wide bitmap. As `bb_engine` (policy
`true`) the GIN index is permitted, but the selectivity of a leaky operator may not use the column statistics
under RLS, so the planner estimated 6,079 matching rows instead of 69 and built a BitmapAnd over the complete
tenant (276,763 index entries, 20 ms) for every read. Under the smoke profile this made PostgreSQL the bottleneck
(540–630 % CPU, `pg-activity-samples.txt`: 498 of ~700 active samples were engine entity reads, 158 the API
history query), with hot/cold/history latencies 5–35× over target and `database_busy`/`overloaded` rejections.

## Decision

`packages/database/migrations/0000_roles.sql` (executed by the bootstrap superuser on setup, upgrade and restore,
and by the test harnesses) now runs `ALTER FUNCTION pg_catalog.jsonb_contains(jsonb, jsonb) LEAKPROOF`.

Why this is safe: a LEAKPROOF function must not reveal anything about its arguments except through its return
value. `jsonb_contains` operates on already-validated `jsonb` values, raises no value-dependent error and has no
side effects; the row-security policies still filter every row before it is returned, so no cross-tenant row
leaves the database. Timing side channels are explicitly outside PostgreSQL's leakproof definition (they exist
for the built-in leakproof equality operators as well). The change is a per-database catalog flag: it is not part
of `pg_dump`, which is why it lives in the roles bootstrap (re-applied by `./blackbox restore`) rather than in a
numbered migration, and it is reversible with `NOT LEAKPROOF`.

## Alternatives considered

- A side table `journal_entity_refs(tenant_id, entity_type, entity_id, journal_sequence)` maintained by
  `append_journal_entries` with leakproof equality lookups: correct, but a schema/append-path change with a
  backfill — out of proportion for the pilot.
- `SECURITY DEFINER` lookup functions that bypass RLS and re-check the tenant themselves: moves the tenant boundary
  out of the policies (rejected; AGENTS.md requires real RLS).
- Query rewrites (`OFFSET 0` fences, post-filters): do not help, the index condition itself is forbidden.
- Better statistics (`SET STATISTICS`): RLS forbids using them for leaky operators regardless of quality.

## Evidence

Regression test `apps/engine/tests/rls_gin_index.rs` asserts the catalog flag after bootstrap and that the plans
of the API history query (as `bb_api` with `app.tenant_id`) and the engine entity read (as `bb_engine`) contain
`journal_entries_entity_idx`. The before/after protocol measurements are in reports/evidence/PILOT-09-perf/
and reports/performance.json.
