# Shared contracts

Binding wire contracts shared by TypeScript (api/worker/mcp/web) and Rust (engine). Changing a file here requires updating both sides and the conformance tests in `tests/contracts`.

- `journal-entry.schema.json` — logical journal entry (JOURNAL-AND-MCP §2) as stored and as exposed by API/MCP.
- `events.json` — canonical event vocabulary: event_type -> track(s), required payload fields, money/quantity semantics. Derived from GOLDEN-ORDER-TO-CASH.json and specs/question-data-contracts.json journal_event_families.
- `engine-rpc.json` — engine HTTP endpoints, request/response envelopes, consistency modes and error codes.
- `log-record.json` — structured log record allowlist (SYSTEM-AND-DIAGNOSTICS.md).
