/**
 * Mirror of packages/contracts/log-record.json (schema_version 1). A unit test asserts that this
 * TypeScript constant equals the JSON contract so the two cannot drift.
 */
export const LOG_SCHEMA_VERSION = 1;

export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export const LOG_SCOPES = ["installation", "workspace"] as const;
export type LogScope = (typeof LOG_SCOPES)[number];

export const REQUIRED_FIELDS = [
  "schema_version",
  "record_id",
  "occurred_at",
  "observed_at",
  "level",
  "event_name",
  "message",
  "component",
  "service_version",
  "instance_id",
  "scope",
] as const;

export const OPTIONAL_FIELDS = [
  "tenant_id",
  "connection_id",
  "capability_id",
  "run_id",
  "operation_id",
  "attempt",
  "trace_id",
  "span_id",
  "parent_span_id",
  "duration_ms",
  "record_count",
  "error_code",
  "retryable",
  "next_retry_at",
  "action_code",
  "journal_batch_id",
  "committed_cursor",
  "applied_cursor",
  "truncated",
  "termination",
] as const;

export const LIMITS = { max_string: 512, max_record_bytes: 16384 } as const;

export const ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

/** Field value types enforced before emission (anything else is dropped). */
export const FIELD_TYPES: Record<string, "string" | "number" | "boolean"> = {
  schema_version: "number",
  record_id: "string",
  occurred_at: "string",
  observed_at: "string",
  level: "string",
  event_name: "string",
  message: "string",
  component: "string",
  service_version: "string",
  instance_id: "string",
  scope: "string",
  tenant_id: "string",
  connection_id: "string",
  capability_id: "string",
  run_id: "string",
  operation_id: "string",
  attempt: "number",
  trace_id: "string",
  span_id: "string",
  parent_span_id: "string",
  duration_ms: "number",
  record_count: "number",
  error_code: "string",
  retryable: "boolean",
  next_retry_at: "string",
  action_code: "string",
  journal_batch_id: "string",
  committed_cursor: "number",
  applied_cursor: "number",
  truncated: "boolean",
  termination: "string",
};

export interface LogRecord {
  schema_version: number;
  record_id: string;
  occurred_at: string;
  observed_at: string;
  level: LogLevel;
  event_name: string;
  message: string;
  component: string;
  service_version: string;
  instance_id: string;
  scope: LogScope;
  tenant_id?: string;
  connection_id?: string;
  capability_id?: string;
  run_id?: string;
  operation_id?: string;
  attempt?: number;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  duration_ms?: number;
  record_count?: number;
  error_code?: string;
  retryable?: boolean;
  next_retry_at?: string;
  action_code?: string;
  journal_batch_id?: string;
  committed_cursor?: number;
  applied_cursor?: number;
  truncated?: boolean;
  termination?: string;
}

/** Optional context fields a caller may pass with an emit call or bind on a child logger. */
export type LogFields = Partial<Omit<LogRecord, "schema_version" | "record_id" | "occurred_at" | "observed_at" | "level" | "event_name" | "message" | "component" | "service_version" | "instance_id">> & {
  scope?: LogScope;
};
