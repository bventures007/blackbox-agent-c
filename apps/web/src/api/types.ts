// Contract-shaped types mirroring docs/api-contract.md. The UI never computes business values;
// it renders what these envelopes carry.

export type Locale = 'en' | 'de';

export interface ApiError {
  error: { code: string; message: string; retryable: boolean; details?: unknown };
}

export interface SessionInfo {
  principal: { id: string; kind: 'owner' };
  workspace: { tenant_id: string; display_name: string; locale: Locale };
  csrf_token: string;
  session: { expires_at: string; remembered: boolean };
}

export interface Workspace {
  tenant_id: string;
  display_name: string;
  locale: Locale;
  created_at: string;
  backups: { status: BackupStatus };
  unresolved_review_count: number;
}

export type Track = 'source' | 'fact' | 'commitment' | 'movement' | 'reservation';
export const TRACKS: Track[] = ['source', 'fact', 'commitment', 'movement', 'reservation'];

export interface Consistency {
  applied_cursor: number | null;
  committed_cursor: number | null;
  required_cursor: number | null;
  status: 'current' | 'behind' | 'unknown';
  recorded_cutoff: string | null;
  effective_cutoff: string | null;
  reducer_version: string | null;
}

export type SourceStatus = 'current' | 'delayed' | 'paused' | 'error' | 'initial_import' | 'disconnected' | 'unknown';

export interface ReadinessSource {
  connection_id: string;
  provider: string;
  last_successful_check_at: string | null;
  last_new_event_at: string | null;
  coverage_from: string | null;
  coverage_to: string | null;
  status: SourceStatus;
}

export interface Readiness {
  datasets_present: string[];
  datasets_missing: string[];
  sources: ReadinessSource[];
}

// Journal
export interface JournalEntry {
  entry_id: string;
  tenant_id: string;
  journal_sequence: number;
  track: Track;
  record_id: string;
  event_type: string;
  schema_version: number;
  connection_id: string | null;
  provider: string | null;
  account_ref: string | null;
  provider_event_id: string | null;
  occurred_at: string;
  recorded_at: string;
  entity_refs: Record<string, string>;
  payload: Record<string, unknown>;
  evidence_refs: string[];
  input_entry_ids: string[];
  derivation_rule: string | null;
  derivation_version: number | null;
  supersedes_entry_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  source_time: string | null;
  summary?: string;
  history_kind?: 'backfill' | 'live';
}

export interface JournalEntryDetail extends JournalEntry {
  superseded_by_entry_id: string | null;
  derived_entry_ids: string[];
  evidence: EvidenceMeta[];
}

export interface JournalPage {
  entries: JournalEntry[];
  page: { next_cursor: string | null; snapshot_cursor: number; truncated: boolean };
  consistency: Consistency;
}

export interface EvidenceMeta {
  evidence_id: string;
  status: 'available' | 'redacted' | 'expired' | 'unavailable';
  reason?: string;
  provider?: string;
  content_type?: string;
  received_at?: string;
  excerpt?: string;
  size_bytes?: number;
}

export interface EntityState {
  entity: { type: string; id: string };
  status: 'complete' | 'partial' | 'insufficient_data' | 'conflict' | 'unsupported';
  lifecycle: { state: string; label_key?: string };
  positions: Array<{ key: string; amount_minor?: number; currency?: string; quantity?: string; unit?: string; note_key?: string }>;
  fields: Array<{ key: string; value: string | number | null; kind?: 'money' | 'quantity' | 'date' | 'text'; currency?: string; unit?: string }>;
  consistency: Consistency;
  readiness: Readiness;
  missing_inputs: string[];
  conflicts: Array<{ code: string; description: string; entry_ids: string[] }>;
  evidence: EvidenceRef[];
  effective_at: string | null;
  recorded_cutoff: string | null;
}

export interface EvidenceRef {
  evidence_id: string;
  entry_id: string;
  record_id: string;
  track: Track;
  label: string;
}

// Sources
export type ProviderState = 'implemented' | 'configured' | 'syncing' | 'degraded' | 'unsupported' | 'planned';
export type SourceCategory = 'shops' | 'payment' | 'billing' | 'shipping' | 'other';

export interface Capability {
  id: string;
  state: 'active' | 'partial' | 'unsupported' | 'planned' | 'paused';
  schedule: string | null;
  last_successful_check_at: string | null;
  last_new_event_at: string | null;
  next_check_at: string | null;
  next_check_reason: string | null;
  coverage_from: string | null;
  coverage_to: string | null;
  limitations: string[];
}

export interface ConnectionSummary {
  connection_id: string;
  provider: string;
  display_name: string;
  account_label: string | null;
  demo: boolean;
  state: SourceStatus;
  mode: 'local_standalone';
  created_at: string;
  last_import_completed_at: string | null;
  last_import_outcome: 'complete' | 'complete_with_gaps' | 'failed' | 'canceled' | 'paused' | null;
  last_successful_check_at: string | null;
  last_new_event_at: string | null;
  next_check_at: string | null;
  next_check_reason: string | null;
  pending_count: number;
  failed_count: number;
}

export interface CatalogueItem {
  provider: string;
  category: SourceCategory;
  state: ProviderState;
  capabilities: Capability[];
  connections: ConnectionSummary[];
  connect_kind: 'shopify' | 'shopify_payments' | 'generic' | 'bank_csv' | 'replay' | null;
}

export interface Catalogue {
  catalogue: CatalogueItem[];
}

export type ImportPreset = 'last_30_days' | 'this_year' | 'last_12_months' | 'custom' | 'from_now';

export interface ImportPlan {
  plan_id: string;
  plan_revision: number;
  preset: ImportPreset;
  timezone: string;
  requested_from: string | null;
  initial_cutoff: string;
  include_open_context: boolean;
  include_opening_state: boolean;
  strict_from_now: boolean;
  selected_by: string;
  selected_at: string;
  restrictions: string[];
  inherited_from_workspace: boolean;
}

export interface ImportRun {
  run_id: string;
  run_kind: 'initial' | 'history_expansion' | 'incremental' | 'reconciliation' | 'check';
  state: 'queued' | 'running' | 'paused' | 'completed' | 'completed_with_gaps' | 'failed' | 'canceled';
  phase: 'check_connection' | 'import_records' | 'link_and_process' | 'ready_for_queries';
  counters: { requested: number | null; loaded: number; committed: number; applied: number; failed: number };
  totals_known: boolean;
  percent: number | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  outcome: string | null;
  cohort: string;
  error_code?: string | null;
  next_action?: string | null;
}

export interface ConnectionHealth {
  observed_at: string;
  state: SourceStatus;
  last_attempt_at: string | null;
  last_import_completed_at: string | null;
  last_successful_check_at: string | null;
  last_new_event_at: string | null;
  last_journal_commit_at: string | null;
  last_applied_at: string | null;
  next_check_at: string | null;
  next_check_reason: string | null;
  coverage: Array<{ capability_id: string; from: string | null; to: string | null; completeness: 'complete_for_declared_scope' | 'partial' | 'unknown' | 'unavailable'; history_kind: 'event_history' | 'snapshot_only' | 'mixed' | 'unknown' }>;
  limitations: string[];
  pending_count: number;
  failed_count: number;
  oldest_pending_age_seconds: number | null;
  committed_cursor: number | null;
  applied_cursor: number | null;
}

export interface ConnectionDetail {
  connection: ConnectionSummary & { config_summary: Record<string, string> };
  health: ConnectionHealth;
  import_plan: ImportPlan | null;
  runs: ImportRun[];
  readiness: Readiness;
}

export interface QuestionReadiness {
  question_id: string;
  intent: string;
  status: 'ready' | 'partial' | 'blocked' | 'not_applicable';
  missing: string[];
  sources: ReadinessSource[];
}

// Questions
export interface ParamSchemaProperty {
  type: 'string' | 'integer' | 'number' | 'boolean';
  title?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  format?: 'date' | 'date-time';
  'x-entity'?: 'item' | 'order' | 'customer' | 'invoice' | 'shipment' | 'provider';
}

export interface ParamsSchema {
  type: 'object';
  properties: Record<string, ParamSchemaProperty>;
  required?: string[];
}

export interface QuestionTemplate {
  id: string;
  intent: string;
  group: string;
  params_schema: ParamsSchema;
  supported: boolean;
  readiness: QuestionReadiness;
}

export interface CalculationStep {
  label_key: string;
  label: string;
  value: string | number | null;
  unit?: string;
  currency?: string;
  operator?: '-' | '+' | '=' | '×' | '÷' | null;
}

export interface ResultRow {
  id: string;
  cells: Array<{ key: string; value: string | number | null; kind?: 'money' | 'quantity' | 'date' | 'text' | 'status'; currency?: string; unit?: string }>;
  evidence_ids: string[];
}

export interface QuestionResult {
  intent: string;
  status: 'complete' | 'partial' | 'insufficient_data' | 'conflict' | 'unsupported';
  headline: { value: string | number | null; unit?: string; currency?: string; kind?: 'money' | 'quantity' | 'count' | 'text' } | null;
  summary_key: string | null;
  summary_params?: Record<string, string | number>;
  result: { columns?: string[]; rows: ResultRow[]; truncated: boolean; page?: { next_cursor: string | null } } | null;
  calculation: { rule: string; version: string; steps: CalculationStep[] };
  evidence: EvidenceRef[];
  effective_at: string | null;
  recorded_cutoff: string | null;
  consistency: Consistency;
  readiness: Readiness;
  coverage: Array<{ capability_id: string; population: string; interval_from: string | null; interval_to: string | null; completeness: string }>;
  missing_inputs: string[];
  conflicts: Array<{ code: string; description: string; entry_ids: string[] }>;
  warnings: string[];
  scope: { params: Record<string, unknown>; period_from: string | null; period_to: string | null; entity?: { type: string; id: string; label: string } };
}

export interface SearchResult {
  templates: Array<{ id: string; intent: string }>;
  entities: Array<{ type: string; id: string; label: string; secondary?: string }>;
}

// Agents
export interface AgentCredential {
  credential_id: string;
  name: string;
  status: 'active' | 'revoked' | 'expired';
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  grant: 'workspace.read_business';
}

export interface McpConfig {
  transport: 'stdio';
  key_placeholder: string;
  env_var: string;
  key_file_env_var: string;
  config_json: string;
  bridge_command: string;
  tested_clients: Array<{ name: string; version: string; transport: string }>;
}

// Review
export type ReviewAction = 'retry' | 'confirm_link' | 'reject_link' | 'append_correction' | 'leave_open';
export interface ReviewCase {
  case_id: string;
  type: 'quarantined_input' | 'unresolved_link' | 'content_conflict' | 'failed_derivation' | 'contradictory_assertion';
  state: 'open' | 'in_progress' | 'resolved';
  revision: number;
  reason: string;
  stage: string;
  source: { connection_id: string; provider: string; account_label: string | null };
  run_id: string | null;
  affected: { records: string[]; questions: string[] };
  evidence_ref: string | null;
  proposed_link?: { from: string; to: string } | null;
  available_actions: ReviewAction[];
  recalculating: boolean;
  required_cursor: number | null;
  applied_cursor: number | null;
  history: Array<{ actor: string; at: string; action: string; reason?: string }>;
  created_at: string;
  updated_at: string;
}

// Settings
export type BackupStatus = 'not_configured' | 'scheduled' | 'running' | 'failed' | 'overdue';
export interface BackupSettings {
  status: BackupStatus;
  destination_label: string | null;
  last_attempt_at: string | null;
  last_completed_at: string | null;
  last_cutoff: string | null;
  next_due_at: string | null;
  recoverable_age_seconds: number | null;
  retention: { daily: number; weekly: number };
  same_device: boolean;
  last_restore_test_at: string | null;
  last_error?: string | null;
}

export interface RetentionSettings {
  classes: Array<{ id: string; days: number; min_days: number; max_days: number; provider_limit_days: number | null }>;
}

export interface StorageSettings {
  thresholds: { warning_percent: number; warning_bytes: number; critical_percent: number; critical_bytes: number };
  volumes: Array<{ id: string; used_bytes: number; free_bytes: number; total_bytes: number; state: 'ok' | 'warning' | 'critical' | 'unknown' }>;
}

export interface SecurityAudit {
  counts: Record<string, number>;
  last_events: Array<{ at: string; event: string; actor: string }>;
  owner_sessions_active: number;
  agent_keys_active: number;
}

// Diagnostics
export type HealthState = 'healthy' | 'working' | 'degraded' | 'unavailable' | 'unknown';
export interface HealthCard {
  id: 'api' | 'worker' | 'postgres' | 'engine' | 'sources' | 'mcp' | 'diagnostics';
  state: HealthState;
  observed_at: string;
  reason: string;
  next_action: string | null;
  details: Record<string, string | number | null>;
}

export interface HealthResponse {
  cards: HealthCard[];
  backups: { status: BackupStatus; last_completed_at: string | null; recoverable_age_seconds: number | null };
  unresolved_review_count: number;
  maintenance: { phase: string | null };
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
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
  scope: 'installation' | 'workspace';
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
  aggregated_count?: number;
}

export interface LogsPage {
  records: LogRecord[];
  page: { next_cursor: string | null };
  retained_from: string | null;
  retained_to: string | null;
  dropped_count: number;
  state: 'ok' | 'empty' | 'out_of_retention' | 'debug_not_recorded' | 'collector_failed' | 'rotated';
}

export interface DebugState {
  active: boolean;
  expires_at: string | null;
  scope: { component: string; connection_id?: string | null; run_id?: string | null } | null;
}

export interface ExportPreview {
  preview: { size_bytes: number; truncated: boolean; unavailable: string[]; categories: string[]; since: string; until: string };
}

export interface DiagnosticsStorage {
  volumes: Array<{ id: string; used_bytes: number; free_bytes: number; total_bytes: number; state: 'ok' | 'warning' | 'critical' | 'unknown' }>;
  logs: { retained_from: string | null; retained_to: string | null; retained_bytes: number; cap_bytes: number; cap_days: number; dropped_count: number; index_bytes: number };
  thresholds: { warning_percent: number; warning_bytes: number; critical_percent: number; critical_bytes: number };
}
