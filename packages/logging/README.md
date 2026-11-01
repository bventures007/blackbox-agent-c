# @blackbox/logging

Shared structured logger implementing `packages/contracts/log-record.json`: allowlist + typing,
redaction of credential/PII-looking strings before emission, control-character escaping, 512-char
clipping, 16 KiB record cap, pino JSON to stderr, DEBUG gated by server-side debug sessions with
expiry, repeated-failure aggregation, a bounded file collector (`LOGS_DIR/records-YYYYMMDD-HH.jsonl`
+ `index.json`, 7 days / 100 MiB total, dropped counter) and the cursor query/follow functions used
by the API (`/api/diagnostics/logs`) and the CLI (`logs`, `doctor`, `diagnostics export`).
