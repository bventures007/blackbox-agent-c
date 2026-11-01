import type { Track } from "../contracts.js";

/** A producer observation as accepted by the ingestion boundary (replay/generic/bank_csv/policy). */
export interface Observation {
  provider_event_id: string;
  kind: string;
  occurred_at: string;
  source_time?: string | null;
  entity: Record<string, string>;
  payload: Record<string, unknown>;
  evidence_refs?: string[];
  correlation_id?: string | null;
  schema_version?: number;
}

/** Entry draft handed to append_journal_entries (ids/sequence assigned by the database). */
export interface EntryDraft {
  track: Track;
  record_id: string;
  event_type: string;
  schema_version: number;
  entity_refs: Record<string, string>;
  payload: Record<string, unknown>;
  derivation_rule?: string;
  derivation_version?: number;
  supersedes_entry_id?: string | null;
  correlation_id?: string | null;
  causation_id?: string | null;
}

export interface DerivedDraft {
  track: Exclude<Track, "source">;
  record_id: string;
  event_type: string;
  entity_refs?: Record<string, string>;
  payload: Record<string, unknown>;
}

export interface MappingContext {
  /** Sanitized payload (PII replaced by anchors, tenant ids stripped). */
  payload: Record<string, unknown>;
  entity: Record<string, string>;
  unit: string;
}

export interface FamilyMapping {
  dataset: string;
  /** Tracks this family may extend (must be a subset of events.json). */
  tracks: Track[];
  /** Payload fields that must be present (typed) for the observation to be accepted. */
  required: Array<{ field: string; type: "string" | "integer" | "number" | "boolean" }>;
  /** Payload fields copied into entity_refs under the same key (e.g. invoice, transaction). */
  entityKeys: string[];
  /** Primary entity type whose history the fact entry extends. */
  primary: string;
  /** Derivation: returns the non-source entries (never emitted blindly). */
  derive: (ctx: MappingContext) => DerivedDraft[];
  /** Semantic notes shown by describe_business_schema. */
  note: string;
}

export class MappingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MappingError";
    this.code = code;
  }
}
