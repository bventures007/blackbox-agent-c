# ADR-0001 Stack and repository layout

Status: accepted (P0, 2026-11-01)

Decision: pnpm workspace + Cargo workspace. `apps/api` (Fastify 5, TypeScript, serves the built web UI and the HTTP API on 127.0.0.1:19180), `apps/worker` (TypeScript, pg-boss jobs: provider polling, outbox dispatch, backups, retention), `apps/engine` (Rust, axum HTTP service on the private Compose network, canonical reducers/projections/queries), `apps/web` (React 18 + Vite), `packages/database` (SQL migrations, roles, RLS, drizzle schema), `packages/contracts` (shared JSON schemas: journal entry, engine RPC, question envelopes), `packages/logging` (shared structured log contract/redaction/rotation), `packages/mcp` (stdio bridge, official `@modelcontextprotocol/sdk`), `packages/i18n` (EN/DE resources), `infra/compose` (versioned Compose release), `scripts/blackbox` wrapper, `tests/` (Playwright + acceptance harness), `fixtures/`.

Alternatives: single Node process without Rust (rejected: PERFORMANCE-ARCHITECTURE.md binds Rust reducers); gRPC between API and engine (rejected: plain authenticated HTTP/JSON is maintained, simpler to test and sufficient for one engine process).

Evidence: see reports/checkpoint.md for the tested commit.
