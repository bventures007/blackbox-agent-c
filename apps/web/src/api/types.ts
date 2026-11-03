// Types of the real HTTP API (apps/api, docs/api-contract.md) plus the few view-model fields the
// adapters in ./adapters.ts derive from them (marked "derived"). The UI never computes business
// values; it renders what these envelopes carry.

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

/** Engine consistency block (question/state envelopes). The journal list carries only cursors. */
export interface Consistency {
  applied_cursor?: number | null;
  committed_cursor?: number | null;
  required_cursor?: number | null;
  snapshot_cursor?: number | null;
  status?: 'current' | 'behind' | 'unknown';
  recorded_cutoff?: string | null;
  effective_cutoff?: string | null;
  reducer_version?: string | number | null;
  mode?: string;
}

/** Capability/connection status vocabulary of the real API (connections.status, capability_health.status). */
export type SourceStatus = 'healthy' | 'working' | 'degraded' | 'unavailable' | 'unknown' | 'paused' | 'configured' | 'validating' | 'backfilling' | 'catching_up' | 'disconnected' | string;

export interface ReadinessSource {
  connection_id: string;
  provider: string;
  capability_id?: string;
  status: SourceStatus;
  last_successful_check_at: string | null;
  last_new_event_at: string | null;
  next_check_at?: string | null;
  next_check_reason?: string | null;
  coverage_from: string | null;
  coverage_to: string | null;
  coverage_state?: string;
  history_kind?: string;
  limitations?: string[];
}

export interface Readiness {
  datasets_present: string[];
  datasets_missing: string[];
  sources: ReadinessSource[];
}

export interface QuestionReadiness {
  question_id: string;
  intent: string;
  status: 'ready' | 'partial' | 'blocked' | 'not_applicable';
  required?: string[];
  optional?: string[];
  missing: string[];
  missing_optional?: string[];
  reasons?: string[];
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
  payload_hash?: string;
  evidence_refs: string[];
  input_entry_ids: string[];
  derivation_rule: string | null;
  derivation_version: number | null;
  supersedes_entry_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  source_time: string | null;
}

/** GET /api/journal/:id — the entry plus its link neighbourhood. */
export interface JournalEntryDetail extends JournalEntry {
  supersedes: JournalEntry | null;
  superseded_by: JournalEntry[];
  derived_from: JournalEntry[];
  derivations: JournalEntry[];
}

export interface JournalPage {
  entries: JournalEntry[];
  page: { next_cursor: string | null; snapshot_cursor: number; truncated: boolean };
  consistency: Consistency;
}

/** GET /api/evidence/:id */
export interface EvidenceResponse {
  status: 'available' | 'redacted' | 'expired' | 'unavailable' | 'restricted' | string;
  reason?: string;
  since?: string;
  evidence: {
    evidence_id: string;
    connection_id?: string | null;
    kind?: string;
    media_type?: string;
    byte_size?: number;
    content_hash?: string;
    received_at?: string;
    evidence_class?: string;
  } | null;
  content?: unknown;
  content_encoding?: 'inline' | 'binary_use_content_endpoint';
}

export interface EntityTrackSummary {
  entries: Array<{ entry_id: string; journal_sequence: number; track: Track; record_id: string; event_type: string; occurred_at: string; recorded_at: string; supersedes_entry_id: string | null; superseded_by: string | null; effect: string }>;
  total: number;
  truncated: boolean;
}

/** GET /api/entities/:type/:id/state — engine state envelope. `state` holds the typed projection fields. */
export interface EntityState {
  entity: { type: string; id: string };
  state: (Record<string, unknown> & { status?: string; currency?: string; unit?: string; links?: Array<{ type: string; id: string }>; last_sequence?: number }) | null;
  tracks?: Record<Track, EntityTrackSummary>;
  evidence_refs: string[];
  entry_ids: string[];
  coverage: { datasets_present: string[]; datasets_missing: string[] };
  conflicts: Array<Record<string, unknown>>;
  status: AnswerStatus;
  missing_inputs: string[];
  consistency: Consistency;
  readiness: Readiness;
  duration_ms?: number;
}

// Sources
export type ProviderState = 'implemented' | 'configured' | 'syncing' | 'degraded' | 'unsupported' | 'planned';
export type SourceCategory = 'shops' | 'payment' | 'billing' | 'shipping' | 'other';

export interface Capability {
  id: string;
  state: SourceStatus;
  schedule: string | null;
  last_successful_check_at: string | null;
  last_new_event_at: string | null;
  next_check_at: string | null;
  next_check_reason: string | null;
  coverage_from: string | null;
  coverage_to: string | null;
  coverage_state?: string;
  limitations: string[];
  connection_id?: string;
}

/** connections row as returned by the API, plus derived presentation fields. */
export interface ConnectionSummary {
  connection_id: string;
  provider: string;
  display_name: string;
  account_ref: string | null;
  status: SourceStatus;
  config: Record<string, unknown>;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
  disconnected_at: string | null;
  // derived (adapters.ts)
  account_label: string | null;
  demo: boolean;
  state: SourceStatus;
  last_successful_check_at: string | null;
  last_new_event_at: string | null;
  next_check_at: string | null;
  next_check_reason: string | null;
  degraded: boolean;
}

export interface CatalogueItem {
  provider: string;
  name: string;
  category: SourceCategory;
  api_category?: 'connector' | 'producer' | string;
  state: ProviderState;
  capabilities: Capability[];
  connections: ConnectionSummary[];
  connect_kind: 'shopify' | 'shopify_payments' | 'generic' | 'bank_csv' | 'replay' | null;
  /** false when the provider is only part of the UI's planned-provider list (not returned by the API). */
  from_api: boolean;
}

export interface Catalogue {
  catalogue: CatalogueItem[];
  readiness_observed_at?: string;
}

export type ImportPreset = 'last_30_days' | 'this_year' | 'last_12_months' | 'custom' | 'from_now';

export interface ImportPlan {
  plan_id: string;
  plan_revision: number;
  connection_id: string;
  preset: ImportPreset;
  timezone: string;
  requested_from: string | null;
  initial_cutoff: string;
  include_open_context: boolean;
  include_opening_state: boolean;
  strict_from_now: boolean;
  local_from_label?: string | null;
  local_cutoff_label?: string | null;
  restrictions: string[];
  created_by: string;
  created_at: string;
  superseded_at: string | null;
}

export interface ImportRun {
  run_id: string;
  connection_id: string;
  plan_id: string | null;
  kind: 'backfill' | 'incremental' | 'reconcile' | 'check' | string;
  phase: 'check_connection' | 'import_records' | 'link_and_process' | 'ready_for_queries' | string;
  state: 'queued' | 'running' | 'paused' | 'completed' | 'completed_with_gaps' | 'failed' | 'canceled' | string;
  counters: { requested: number | null; loaded: number; committed: number; applied: number; failed: number; duplicates?: number; conflicts?: number; rejected?: number };
  totals_known: boolean;
  pages?: number;
  poll_group?: string | null;
  capability_scope?: string[];
  coverage_from?: string | null;
  coverage_to?: string | null;
  percent: number | null;
  attempt?: number;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  outcome: string | null;
  error_code?: string | null;
  next_action?: string | null;
  committed_cursor?: number | null;
}

/** capability_health row (GET /api/sources/connections/:id → health[]). */
export interface CapabilityHealth {
  connection_id: string;
  capability_id: string;
  observed_at: string;
  status: SourceStatus;
  last_attempt_at: string | null;
  last_successful_check_at: string | null;
  last_new_event_at: string | null;
  last_journal_commit_at: string | null;
  next_check_at: string | null;
  next_check_reason: string | null;
  coverage_from: string | null;
  coverage_to: string | null;
  history_kind: string;
  coverage_state: string;
  limitations: string[];
  schedule_seconds: number | null;
  pending_count: number;
  failed_count: number;
  poll_group: string | null;
  mode: string;
  method: string | null;
  incremental_cursor: string | null;
  backfill_cursor: string | null;
  backfill_run_id: string | null;
  last_reconciliation_at: string | null;
  next_reconciliation_at: string | null;
  consecutive_failures: number;
  last_error_code: string | null;
  last_error_at: string | null;
  retry_after_until: string | null;
  throttle_status: string | null;
  missing_grants: string[];
  next_action: string | null;
  updated_at: string;
}

/** Aggregate over the capability rows (derived, adapters.ts). */
export interface ConnectionHealth {
  observed_at: string | null;
  state: SourceStatus;
  last_attempt_at: string | null;
  last_successful_check_at: string | null;
  last_new_event_at: string | null;
  last_journal_commit_at: string | null;
  next_check_at: string | null;
  next_check_reason: string | null;
  coverage: Array<{ capability_id: string; from: string | null; to: string | null; completeness: string; history_kind: string }>;
  limitations: string[];
  pending_count: number;
  failed_count: number;
  consecutive_failures: number;
  last_error_code: string | null;
  missing_grants: string[];
  next_action: string | null;
}

export interface ConnectionDetail {
  connection: ConnectionSummary;
  capabilities: CapabilityHealth[];
  health: ConnectionHealth;
  import_plan: ImportPlan | null;
  import_plan_proposal: { history_start: string; timezone: string } | null;
  runs: ImportRun[];
  readiness: QuestionReadiness[];
}

// Questions
export interface ParamSchemaProperty {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array';
  required?: boolean;
  title?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  format?: 'date' | 'date-time';
  items?: { type: string; enum?: string[] };
}

export interface ParamsSchema {
  type: 'object';
  properties: Record<string, ParamSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface QuestionTemplate {
  id: string;
  intent: string;
  group: string;
  question: string;
  required_datasets: string[];
  optional_datasets: string[];
  params_schema: ParamsSchema;
  supported: boolean;
  query_rule?: string;
  readiness: QuestionReadiness;
}

export type AnswerStatus = 'complete' | 'partial' | 'unknown' | 'conflict' | 'unsupported' | 'insufficient_data';

export interface CalculationStep {
  step: string;
  formula: string;
  values: Record<string, unknown>;
}

export interface AnswerCoverage {
  datasets_present: string[];
  datasets_missing: string[];
  population?: { records_considered?: number; returned?: number };
  evidence_truncated?: boolean;
  coverage_assertions?: Array<Record<string, unknown>>;
  incoming_supply_known?: boolean;
}

/** POST /api/questions/:intent — engine /v1/query envelope. */
export interface QuestionResult {
  intent: string;
  question_id: string;
  params: Record<string, unknown>;
  status: AnswerStatus;
  result: Record<string, unknown> | null;
  calculation: CalculationStep[];
  evidence_refs: string[];
  entry_ids: string[];
  missing_inputs: string[];
  conflicts: Array<Record<string, unknown>>;
  coverage: AnswerCoverage;
  consistency: Consistency;
  readiness: QuestionReadiness;
  page?: { next_cursor: string | null; truncated: boolean; returned?: number; total?: number; snapshot_cursor?: number };
  warnings?: string[];
}

export interface SearchResult {
  templates: Array<{ id: string; intent: string; question?: string }>;
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
  command: string;
  args: string[];
  env: Record<string, string>;
  snippet: string;
  notes: string[];
}

// Review
export type ReviewAction = 'retry' | 'confirm_link' | 'reject_link' | 'append_correction' | 'leave_open';
export interface ReviewCase {
  case_id: string;
  tenant_id: string;
  connection_id: string | null;
  run_id: string | null;
  type: string;
  state: 'open' | 'in_progress' | 'resolved';
  revision: number;
  reason: string;
  refs: Record<string, unknown>;
  history: Array<{ at: string; actor: string; action: string; reason?: string; entry_id?: string | null }>;
  resolution_entry_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  // derived
  available_actions: ReviewAction[];
  affected_records: string[];
  proposed_link: { from: string; to: string } | null;
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
  same_device: boolean | null;
  last_restore_test_at: string | null;
  last_error?: string | null;
  protection?: string;
}

export interface RetentionSettings {
  default_days: number;
  classes: Record<string, { days: number; source: string }>;
}

export interface StorageThresholds {
  warn_percent: number;
  warn_min_bytes: number;
  critical_percent: number;
  critical_min_bytes: number;
  log_cap_bytes: number;
  log_retention_days: number;
}

export interface StorageVolume {
  total_bytes?: number;
  free_bytes?: number;
  state: 'ok' | 'warning' | 'critical' | 'unavailable' | 'unknown' | string;
  reason?: string;
}

/** GET /api/settings/storage and GET /api/diagnostics/storage share this shape. */
export interface StorageInfo {
  thresholds: StorageThresholds | null;
  volumes: Record<string, StorageVolume>;
  evidence: { bytes: number; available: boolean };
  logs: { bytes: number; cap_bytes: number; retained_from: string | null; retained_to: string | null; files: number; dropped_count: number; state: string };
}

export interface SecurityAudit {
  counts: Record<string, number>;
  last_events: Array<{ occurred_at: string; event: string; actor_kind: string; channel: string }>;
}

// SEC-02 workspace export (POST /api/settings/export; owner only)
export type WorkspaceExportCategory = 'journal' | 'evidence_metadata' | 'settings';
export const WORKSPACE_EXPORT_CATEGORIES: WorkspaceExportCategory[] = ['journal', 'evidence_metadata', 'settings'];
export interface WorkspaceExportRequest {
  categories: WorkspaceExportCategory[];
  from?: string | null;
  to?: string | null;
}
export interface WorkspaceExportPreview {
  preview: {
    format_version: number;
    categories: WorkspaceExportCategory[];
    from: string | null;
    to: string | null;
    committed_cursor: number;
    counts: { journal_entries: number; evidence_items: number; evidence_restricted: number; settings_sections: number };
    size_bytes: number;
    max_bytes: number;
    truncated: boolean;
    last_included_sequence: number;
    continue_from: string | null;
    files: string[];
  };
}

// Diagnostics
export type HealthState = 'healthy' | 'working' | 'degraded' | 'unavailable' | 'unknown';
export type HealthArea = 'api' | 'worker' | 'postgres' | 'engine' | 'sources' | 'mcp' | 'diagnostics';
export interface HealthCard {
  area: HealthArea;
  state: HealthState;
  observed_at: string;
  reason: string;
  next_action: string | null;
  details: Record<string, string | number | boolean | null>;
}

export interface HealthResponse {
  cards: HealthCard[];
  observed_at: string;
  refresh_interval_seconds: number;
  stale_after_seconds: number;
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
  page: { next_cursor: string | null; truncated?: boolean };
  retained_from: string | null;
  retained_to: string | null;
  dropped_count: number;
  state: string;
  debug_active?: Array<{ component: string; connection_id: string | null; run_id: string | null; expires_at: string }>;
}

export interface DebugState {
  active: boolean;
  expires_at: string | null;
  scope: { component: string; connection_id?: string | null; run_id?: string | null } | null;
}

export interface ExportPreview {
  preview: { size_bytes: number; truncated: boolean; unavailable: string[]; categories: string[]; since: string; until: string; records?: number };
}
