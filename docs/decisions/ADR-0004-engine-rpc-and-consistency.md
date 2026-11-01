# ADR-0004 Rust engine RPC, checkpoints and consistency

Status: accepted (P0)

- Engine = axum HTTP service on the private Compose network (`engine:7070`), authenticated by `X-Engine-Token` (random secret in Compose secrets). Never published to the host.
- Engine tails `journal_entries` by `(tenant_id, journal_sequence)` using `bb_engine`, applies versioned reducers (`reducer_version` constant), persists `engine_checkpoints(tenant_id, applied_sequence, reducer_version, state_hash)` and optionally a snapshot in `engine_snapshots`, then atomically swaps the in-memory tenant state (`ArcSwap`). Readers see either the old or the new consistent state with its cursor.
- Consistency: `latest_committed` reads the tenant high-water mark (`tenant_sequences.last_sequence`) and waits up to the deadline for the engine to reach it, else `projection_behind`; `at_least_cursor` same with caller cursor; `as_of` replays bounded history from the persisted journal for the entity (recorded-time cutoff) and reports effective/recorded cutoffs.
- Contract: packages/contracts/engine-rpc.json (requests/responses). TypeScript orchestrates authorization and calls the engine; no financial reducer in TypeScript.
- Memory: per-tenant hot state keyed by `(tenant_id, entity_type, entity_id)`, interned strings, bounded LRU of cold-hydrated entities; cold history read from indexed PostgreSQL.

Alternatives: engine writes projections to PostgreSQL per entity row (kept as optional persistence, not the serving path).
