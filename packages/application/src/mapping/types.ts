import type { Track } from "../contracts.js";
import type { JournalEntryDraft } from "@blackbox/connectors";

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
  /** Correction: entry id this observation supersedes (set on the source entry). */
  supersedes_entry_id?: string | null;
}

/** Entry draft handed to append_journal_entries (ids/sequence assigned by the database). */
export type EntryDraft = JournalEntryDraft;

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
