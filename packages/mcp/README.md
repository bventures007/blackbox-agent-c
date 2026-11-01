# @blackbox/mcp

stdio MCP server (`dist/server.js`) exposing read-only business tools over the local API:
`describe_business_schema`, `list_journal_entries`, `get_journal_entry`, `get_entity_history`,
`search_events`, `get_business_state`, `get_evidence`, `query_business`, `answer_question`,
`get_readiness`. Configure `BLACKBOX_AGENT_KEY` or `BLACKBOX_AGENT_KEY_FILE` (never argv) and
`BLACKBOX_API_URL` (default `http://127.0.0.1:19180`). stdout is protocol-only; diagnostics go to
stderr. Owner keys are refused.
