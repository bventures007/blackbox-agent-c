/**
 * Provider-neutral connector contracts.
 *
 * An adapter turns provider pages into normalized observations. It never touches the database:
 * the ingestion client (ingest.ts) appends observations through the single SQL boundary
 * append_journal_entries(jsonb) after the worker has set app.tenant_id for the transaction.
 */

export type Track = 'source' | 'fact' | 'commitment' | 'movement' | 'reservation';

/** Synchronization modes declared per capability (specs/SOURCE-SYNCHRONIZATION.md). */
export type SyncMode = 'local_standalone' | 'local_gateway' | 'public_server';
export type SyncMethod = 'polling' | 'direct_webhook' | 'gateway_webhook' | 'import' | 'internal' | 'authenticated_push';

export interface ModeDeclaration {
  status: 'supported' | 'partial' | 'unsupported';
  methods: SyncMethod[];
  reason: string;
}

export interface CapabilitySchedule {
  /** Default polling interval in seconds (null for import/internal capabilities). */
  interval_s: number | null;
  min_interval_s: number | null;
  max_interval_s: number | null;
  jitter_s: number;
  /** Overlap applied to the incremental floor so late-updating records are re-read. */
  overlap_s: number;
  /** Full-window reconciliation cadence in seconds (null when not applicable). */
  reconcile_every_s: number | null;
  /** Width of the bounded reconciliation window in seconds. */
  reconcile_window_s: number | null;
  /** Why no next poll applies when interval_s is null. */
  no_poll_reason: string | null;
}

export interface CapabilityDeclaration {
  /** Register row id, e.g. "shopify.orders". */
  id: string;
  provider: string;
  dataset: string;
  /** Which source timestamp selects records for a date scope (orders: created_at/updated_at). */
  time_selection: string;
  schedule: CapabilitySchedule;
  modes: Record<SyncMode, ModeDeclaration>;
  required_grants: string[];
  limitations: string[];
  /** Event families this adapter can emit for this capability. */
  emits: string[];
}

/** Raw provider evidence retained next to the observation (content stored separately, hashed). */
export interface EvidenceBlob {
  kind: string;
  media_type: string;
  content: unknown;
}

export interface Observation {
  /** Account-scoped durable identity: deduplication key per connection. */
  provider_event_id: string;
  /** Event family from packages/contracts/events.json. */
  kind: string;
  /** Business record identity whose history the entry extends (e.g. "order:gid://shopify/Order/1"). */
  record_id: string;
  /** Register dataset id (orders, payments, ...). */
  dataset: string;
  /** Effective business time (ISO 8601 UTC). */
  occurred_at: string;
  /** Provider's own revision/processing time when distinct from occurred_at. */
  source_time: string | null;
  /** Tenant-scoped opaque entity references keyed by type. No PII. */
  entity: Record<string, string>;
  /** Typed business payload: *_minor integers + currency, quantities as decimal strings + unit. No PII. */
  payload: Record<string, unknown>;
  /** Raw provider evidence (sanitized of PII by the adapter). */
  evidence: EvidenceBlob | null;
  correlation_id: string | null;
  /** Explicit provider test-mode flag (Shopify `test: true`). Always present on payments. */
  test: boolean | null;
}

/** Explicitly unsupported or missing input the adapter refuses to normalize silently. */
export interface RejectedInput {
  provider_ref: string;
  dataset: string;
  reason_code: 'missing_required_field' | 'unsupported_shape' | 'unsupported_event' | 'oversized';
  detail: string;
}

/** Opaque, JSON-serializable provider cursor persisted by the worker. */
export type Cursor = Record<string, unknown>;

export interface Page {
  observations: Observation[];
  rejected: RejectedInput[];
  /** Cursor to continue with; null when the phase is complete. */
  next_cursor: Cursor | null;
  /** True when no further page exists for this plan/window. */
  done: boolean;
  /** Logical records (not observations) loaded on this page. */
  loaded_records: number;
  /** Exact total of logical records for the cohort, only when the provider states an exact count. */
  total_records: number | null;
  /** Highest provider revision time observed on this page (ISO), used to advance incremental floors. */
  max_source_time: string | null;
  /** Provider throttle status as observed (for health display). */
  throttle: { currently_available: number; maximum_available: number; restore_rate: number } | null;
}

export interface BackfillPlan {
  plan_id: string;
  plan_revision: number;
  /** Resolved UTC interval [requested_from, initial_cutoff). */
  requested_from: string;
  initial_cutoff: string;
  include_open_items: boolean;
  include_related_records: boolean;
  include_opening_state: boolean;
  strict_from_now: boolean;
  timezone: string;
}

export interface CredentialCheck {
  ok: boolean;
  /** Immutable provider account identity (e.g. Shopify shop gid). */
  account_ref: string | null;
  account_label: string | null;
  api_version: string;
  granted: string[];
  missing_grants: string[];
  /** Capability ids whose required grants are missing. */
  blocked_capabilities: string[];
  error_code: string | null;
  detail: string | null;
}

export interface SourceAdapter {
  readonly provider: string;
  readonly capabilities: CapabilityDeclaration[];
  checkCredentials(): Promise<CredentialCheck>;
  /** One page of the initial/historical import for a capability. */
  backfill(capability_id: string, plan: BackfillPlan, cursor: Cursor | null): Promise<Page>;
  /** One page of new/changed records since the persisted cursor. */
  incremental(capability_id: string, cursor: Cursor | null, now: Date): Promise<Page>;
  /** One page re-reading a bounded window to recover missed changes. */
  reconcile(capability_id: string, window: { from: string; to: string }, cursor: Cursor | null): Promise<Page>;
}

/** Thrown by adapters when a capability has no outbound polling path (import/internal producers). */
export class PollingUnsupportedError extends Error {
  readonly code = 'polling_unsupported';
  constructor(readonly capability_id: string, readonly reason: string) {
    super(`${capability_id}: ${reason}`);
  }
}

export class CredentialError extends Error {
  readonly code: 'unauthorized' | 'forbidden' | 'token_expired';
  readonly retryable = false;
  constructor(code: 'unauthorized' | 'forbidden' | 'token_expired', message: string) {
    super(message);
    this.code = code;
  }
}

export class ProviderUnavailableError extends Error {
  readonly code = 'provider_unavailable';
  readonly retryable = true;
  constructor(message: string, readonly retry_after_ms: number | null, readonly status: number | null) {
    super(message);
  }
}

export class CursorExpiredError extends Error {
  readonly code = 'cursor_expired';
  readonly retryable = true;
  constructor(message: string) {
    super(message);
  }
}

export class ThrottledError extends Error {
  readonly code = 'throttled';
  readonly retryable = true;
  constructor(message: string, readonly retry_after_ms: number) {
    super(message);
  }
}
