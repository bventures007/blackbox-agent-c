# ADR-0006 Logging and diagnostics

Status: accepted (P0)

- One JSON record contract (packages/contracts/log-record.json, schema_version 1): record_id, occurred_at, observed_at, level, event_name, message, component, service_version, instance_id, scope, tenant_id, connection_id, capability_id, run_id, operation_id, attempt, trace_id, span_id, duration_ms, record_count, error_code, retryable, next_retry_at, action_code, journal_batch_id, committed_cursor, applied_cursor. Allowlist enforced before emission; strings clipped to 512 chars, control characters escaped, record capped at 16 KiB.
- Sink: pino (TS) / tracing-subscriber JSON (Rust) to stderr, collected by the api process collector into `logs/records-*.jsonl` on the `logs` volume with size+age rotation (7 days or 100 MiB total including index). SQLite-free: a small in-process index (per-file min/max time, component counts) is rebuilt on start.
- CLI `./blackbox logs|doctor|diagnostics export` reads the files directly on the host-mounted volume path without API login.
- Debug: `debug_sessions` table with expiry ≤15 min enforced by the logger on each emit; reset on restart.
