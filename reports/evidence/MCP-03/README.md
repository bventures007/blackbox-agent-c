# MCP-03 — independent local client (partial)

- Client: `@modelcontextprotocol/inspector` 2.13.0 (`npx --yes @modelcontextprotocol/inspector --cli`), transport stdio, node v25.9.0, bridge `packages/mcp/dist/server.js` (@blackbox/mcp 0.1.0, SDK @modelcontextprotocol/sdk 1.32.2), API http://127.0.0.1:19180 (release stack 0.1.0-rc6, Compose project blackbox-agent-c).
- Key: agent key `workspace.read_business` created through `POST /api/agents` with the owner session (curl), stored in a 0600 file, passed as `-e BLACKBOX_AGENT_KEY_FILE=<file>` (never as a key argument); revoked afterwards (`POST /api/agents/<id>/revoke` → 204). A key created in the browser UI was NOT used (time-box).
- `--method tools/list` → tools: describe_business_schema, list_journal_entries, get_journal_entry, get_entity_history, search_events, get_business_state, get_evidence, get_readiness, answer_question, query_business (PASS, 2026-11-01 13:00Z).
- `--method tools/call --tool-name get_business_state --tool-arg entity_type=invoice --tool-arg entity_id=INV-1001` → `{"error":{"code":"bridge_error","message":"The operation was aborted due to timeout","retryable":true}}` (the bridge's 10 s request timeout fired while the shared Docker VM was saturated: host load 600–980, API argon2 key verification took >10 s). NOT passed.
- Claude Desktop / Claude Code were not launched; `docs/tester-guide.md` §5 carries the config snippet in their documented format.
- Note: the inspector does not inherit the parent environment; the env must be passed with `-e`.
