import { buildEntryDrafts, canonicalJsonStable, derivedTracks, entityRefsFor, linkDerived, sanitizePayload, DROPPED_KEYS, PII_KEYS, type AnchorFn, type JournalEntryDraft, type ObservationMode } from "@blackbox/connectors";
import { loadEventsContract, type Track } from "../contracts.js";
import { DATASET_PRIMARY, GOLDEN_FAMILIES } from "./families.js";
import { MappingError, type EntryDraft, type FamilyMapping, type Observation } from "./types.js";

export { GOLDEN_FAMILIES, DATASET_PRIMARY } from "./families.js";
export { MappingError } from "./types.js";
export type { Observation, EntryDraft, FamilyMapping } from "./types.js";
// The ONE sanitizer/draft builder lives in @blackbox/connectors; re-exported for existing callers/tests.
export { sanitizePayload, PII_KEYS, DROPPED_KEYS, buildEntryDrafts, linkDerived, entityRefsFor };
export type { AnchorFn, ObservationMode };

/** Canonical JSON (sorted keys) for stable content hashing. */
export const canonicalJson = canonicalJsonStable;

export function sanitizeEntityRefs(entity: Record<string, unknown> | undefined): Record<string, string> {
  return entityRefsFor({}, entity);
}

/** Mapping for a family: the golden table entry or a generic mapping derived from events.json. */
export function getMapping(kind: string): FamilyMapping {
  const contract = loadEventsContract();
  const family = contract.families[kind];
  if (!family) throw new MappingError("unknown_kind", `event kind '${kind}' is not in the canonical event vocabulary`);
  const golden = GOLDEN_FAMILIES[kind];
  if (golden) {
    for (const t of golden.tracks) {
      if (!family.tracks.includes(t)) throw new MappingError("mapping_contract_violation", `mapping for ${kind} emits track ${t} not declared in events.json`);
    }
    return golden;
  }
  const primary = DATASET_PRIMARY[family.dataset] ?? "record";
  const emitted: Track[] = ["source", ...derivedTracks(kind)];
  return {
    dataset: family.dataset,
    tracks: emitted,
    required: [],
    entityKeys: [primary],
    primary,
    note: `Generic mapping: accepted as source observation plus ${emitted.slice(1).join("/")} entries about the ${primary} record (shared connector table). Declared tracks: ${family.tracks.join(", ")}.`,
  };
}

export function listMappings(): Array<{ kind: string; dataset: string; declared_tracks: Track[]; emitted_tracks: Track[]; required: string[]; note: string; golden: boolean }> {
  const contract = loadEventsContract();
  return Object.keys(contract.families)
    .sort()
    .map((kind) => {
      const m = getMapping(kind);
      return { kind, dataset: m.dataset, declared_tracks: contract.families[kind]!.tracks, emitted_tracks: ["source", ...derivedTracks(kind)], required: m.required.map((r) => r.field), note: m.note, golden: Boolean(GOLDEN_FAMILIES[kind]) };
    });
}

function validateRequired(mapping: FamilyMapping, payload: Record<string, unknown>, kind: string): void {
  for (const req of mapping.required) {
    const v = payload[req.field];
    const ok =
      req.type === "string"
        ? typeof v === "string" && v.length > 0
        : req.type === "integer"
          ? typeof v === "number" && Number.isInteger(v)
          : req.type === "number"
            ? typeof v === "number" && Number.isFinite(v)
            : typeof v === "boolean";
    if (!ok) throw new MappingError("invalid_payload", `${kind}: payload field '${req.field}' must be ${req.type}`);
  }
  if ("currency" in payload && typeof payload.currency === "string" && !/^[A-Z]{3}$/.test(payload.currency)) {
    throw new MappingError("invalid_payload", `${kind}: currency must be an ISO 4217 code`);
  }
  for (const [k, v] of Object.entries(payload)) {
    if (k.endsWith("_minor") && v !== null && v !== undefined && !(typeof v === "number" && Number.isInteger(v))) throw new MappingError("invalid_payload", `${kind}: payload field '${k}' must be an integer minor amount`);
  }
}

export interface MappedObservation {
  mapping: FamilyMapping;
  dataset: string;
  sanitizedPayload: Record<string, unknown>;
  entityRefs: Record<string, string>;
  recordId: string;
  contentHash: string;
  correlationId: string;
  source: EntryDraft;
  /** Derived drafts; link them with `linkDerived(derived, sourceEntryId)` after the source is persisted. */
  derived: EntryDraft[];
}

export interface MapOptions {
  anchor: AnchorFn;
  provider: string;
  producer: string;
  runKind: string | null;
  connectionId?: string;
  accountRef?: string | null;
  evidenceRefs?: string[];
  inputEntryIds?: string[];
  defaultUnit?: string;
}

/** Producer/run kind to the observation_mode label stored on every entry of the observation. */
export function observationModeFor(producer: string, runKind: string | null): ObservationMode {
  if (runKind === "backfill" || runKind === "history_expansion") return "backfill";
  if (runKind === "reconcile") return "reconcile";
  if (producer === "bank_csv" || producer === "replay" || producer === "policy" || runKind === "demo") return "import";
  return "live";
}

/**
 * Validates and maps one observation to a Source entry plus derived entries through the shared
 * connector builder. Pure: no I/O. The ingestion service persists the source entry first and
 * links the derived drafts to it.
 */
export function mapObservation(obs: Observation, options: MapOptions): MappedObservation {
  if (typeof obs.kind !== "string") throw new MappingError("invalid_kind", "kind is required");
  const mapping = getMapping(obs.kind);
  if (typeof obs.provider_event_id !== "string" || obs.provider_event_id.length === 0 || obs.provider_event_id.length > 300) throw new MappingError("invalid_event_id", "provider_event_id must be a non-empty string (max 300)");
  const occurred = new Date(obs.occurred_at);
  if (Number.isNaN(occurred.getTime())) throw new MappingError("invalid_occurred_at", "occurred_at must be an RFC3339 timestamp");
  if (!obs.payload || typeof obs.payload !== "object" || Array.isArray(obs.payload)) throw new MappingError("invalid_payload", "payload must be an object");
  const sanitizedPayload = sanitizePayload(obs.payload, options.anchor);
  validateRequired(mapping, sanitizedPayload, obs.kind);
  const entity: Record<string, unknown> = { ...(obs.entity ?? {}) };
  for (const key of mapping.entityKeys) {
    const v = sanitizedPayload[key];
    if (typeof v === "string" && !entity[key]) entity[key] = v;
  }
  const drafts = buildEntryDrafts(
    { provider_event_id: obs.provider_event_id, kind: obs.kind, occurred_at: obs.occurred_at, source_time: obs.source_time ?? null, entity, payload: sanitizedPayload, correlation_id: obs.correlation_id ?? null, schema_version: obs.schema_version, supersedes_entry_id: obs.supersedes_entry_id ?? null },
    { connection_id: options.connectionId ?? "00000000-0000-0000-0000-000000000000", provider: options.provider, account_ref: options.accountRef ?? null, observation_mode: observationModeFor(options.producer, options.runKind), evidence_refs: options.evidenceRefs ?? [], input_entry_ids: options.inputEntryIds ?? [] },
  );
  for (const d of drafts.derived) {
    if (!mapping.tracks.includes(d.track)) throw new MappingError("mapping_contract_violation", `${obs.kind}: derived track ${d.track} is not permitted`);
  }
  return { mapping, dataset: mapping.dataset, sanitizedPayload, entityRefs: drafts.entity_refs, recordId: drafts.record_id, contentHash: drafts.content_hash, correlationId: drafts.correlation_id, source: drafts.source as JournalEntryDraft, derived: drafts.derived };
}

/** Content hash of an observation (sanitized payload); identical to the worker path. */
export function contentHash(obs: { kind: string; occurred_at: string; entity: Record<string, string>; payload: Record<string, unknown> }): string {
  return buildEntryDrafts({ provider_event_id: "-", kind: obs.kind, occurred_at: obs.occurred_at, entity: obs.entity, payload: obs.payload }, { connection_id: "-", provider: "-", account_ref: null, observation_mode: "live", evidence_refs: [] }).content_hash;
}
