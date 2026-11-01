import { createHash } from "node:crypto";
import { loadEventsContract, TRACKS, type Track } from "../contracts.js";
import { DATASET_PRIMARY, GOLDEN_FAMILIES } from "./families.js";
import { MappingError, type DerivedDraft, type EntryDraft, type FamilyMapping, type Observation } from "./types.js";

export { GOLDEN_FAMILIES, DATASET_PRIMARY } from "./families.js";
export { MappingError } from "./types.js";
export type { Observation, EntryDraft, DerivedDraft, FamilyMapping, MappingContext } from "./types.js";

/** Payload keys that must never reach a canonical payload (PILOT-08). Values become opaque anchors. */
export const PII_KEYS: ReadonlySet<string> = new Set([
  "name",
  "first_name",
  "last_name",
  "full_name",
  "customer_name",
  "contact",
  "email",
  "e_mail",
  "mail",
  "phone",
  "telephone",
  "mobile",
  "address",
  "address1",
  "address2",
  "street",
  "house_number",
  "city",
  "zip",
  "postal_code",
  "postcode",
  "iban",
  "bic",
  "account_number",
  "account_holder",
  "counterparty",
  "counterparty_name",
  "note",
  "notes",
  "message",
  "body",
  "subject",
  "booking_text",
  "comment",
  "description",
  "ip",
  "ip_address",
  "user_agent",
]);

/** Keys that are silently dropped: they can never authorize or redirect anything (INGEST-01). */
export const DROPPED_KEYS: ReadonlySet<string> = new Set(["tenant_id", "workspace_id", "tenant", "workspace", "connection_id", "api_key", "token", "secret", "password", "authorization"]);

export type AnchorFn = (field: string, value: string) => string;

/**
 * Replaces PII-bearing fields with keyed anchors (`<key>_anchor`), drops authority-like keys,
 * recursively. Values that are not strings under a PII key are dropped entirely.
 */
export function sanitizePayload(payload: Record<string, unknown>, anchor: AnchorFn, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (depth > 6) return out;
  for (const [rawKey, value] of Object.entries(payload)) {
    const key = rawKey.toLowerCase();
    if (DROPPED_KEYS.has(key)) continue;
    if (PII_KEYS.has(key) || /(?:^|_)(?:name|email|phone|address|street|iban)$/.test(key)) {
      if (typeof value === "string" && value.trim() !== "") out[`${rawKey}_anchor`] = anchor(rawKey, value);
      continue;
    }
    if (Array.isArray(value)) {
      out[rawKey] = value.map((v) => (v && typeof v === "object" && !Array.isArray(v) ? sanitizePayload(v as Record<string, unknown>, anchor, depth + 1) : typeof v === "string" ? clip(v) : v));
    } else if (value && typeof value === "object") {
      out[rawKey] = sanitizePayload(value as Record<string, unknown>, anchor, depth + 1);
    } else if (typeof value === "string") {
      out[rawKey] = clip(value);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      out[rawKey] = value;
    }
  }
  return out;
}

function clip(s: string): string {
  return s.length > 1000 ? s.slice(0, 1000) : s;
}

const ENTITY_TYPES = new Set(["order", "line", "customer", "item", "invoice", "shipment", "transaction", "refund", "payout", "return", "reservation", "bank_entry", "credit", "hold", "dispute", "supply", "promise", "rule", "case", "link", "account", "entitlement", "communication", "coverage", "location", "variant"]);

export function sanitizeEntityRefs(entity: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entity ?? {})) {
    if (!ENTITY_TYPES.has(k)) continue;
    if (typeof v === "string" && v.length > 0 && v.length <= 200) out[k] = v;
    else if (typeof v === "number") out[k] = String(v);
  }
  return out;
}

/** Canonical JSON (sorted keys) for stable content hashing. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(obs: { kind: string; occurred_at: string; entity: Record<string, string>; payload: Record<string, unknown> }): string {
  return createHash("sha256").update(canonicalJson({ kind: obs.kind, occurred_at: obs.occurred_at, entity: obs.entity, payload: obs.payload })).digest("hex");
}

/** Mapping for a family: the golden table entry or a generic fact mapping derived from events.json. */
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
  return {
    dataset: family.dataset,
    tracks: ["source", "fact"],
    required: [],
    entityKeys: [primary],
    primary,
    note: `Generic mapping: accepted as source observation plus a typed fact about the ${primary} record. Declared tracks: ${family.tracks.join(", ")}; movement/commitment/reservation effects require an explicit connector mapping.`,
    derive: (ctx) => {
      const id = ctx.payload[primary] ?? ctx.entity[primary];
      if (id === undefined || id === null) return [];
      return [{ track: "fact", record_id: `${primary}:${String(id)}`, event_type: kind, payload: ctx.payload }];
    },
  };
}

export function listMappings(): Array<{ kind: string; dataset: string; declared_tracks: Track[]; emitted_tracks: Track[]; required: string[]; note: string; golden: boolean }> {
  const contract = loadEventsContract();
  return Object.keys(contract.families)
    .sort()
    .map((kind) => {
      const m = getMapping(kind);
      return { kind, dataset: m.dataset, declared_tracks: contract.families[kind]!.tracks, emitted_tracks: m.tracks, required: m.required.map((r) => r.field), note: m.note, golden: Boolean(GOLDEN_FAMILIES[kind]) };
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
}

export interface MappedObservation {
  mapping: FamilyMapping;
  dataset: string;
  sanitizedPayload: Record<string, unknown>;
  entityRefs: Record<string, string>;
  contentHash: string;
  source: EntryDraft;
  derived: EntryDraft[];
}

export interface MapOptions {
  anchor: AnchorFn;
  provider: string;
  producer: string;
  runKind: string | null;
  defaultUnit?: string;
}

/**
 * Validates and maps one observation to a Source entry plus derived entries. Pure: no I/O.
 * `input_entry_ids`/evidence are attached by the ingestion service after the source entry is
 * persisted.
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
  const entityRefs = sanitizeEntityRefs(obs.entity);
  for (const key of mapping.entityKeys) {
    const v = sanitizedPayload[key];
    if (typeof v === "string" && ENTITY_TYPES.has(key)) entityRefs[key] = v;
  }
  const unit = typeof sanitizedPayload.unit === "string" ? sanitizedPayload.unit : (options.defaultUnit ?? "piece");
  const hash = contentHash({ kind: obs.kind, occurred_at: occurred.toISOString(), entity: entityRefs, payload: sanitizedPayload });
  const schemaVersion = typeof obs.schema_version === "number" ? obs.schema_version : 1;
  const source: EntryDraft = {
    track: "source",
    record_id: `source:${options.provider}:${obs.provider_event_id}`,
    event_type: obs.kind,
    schema_version: schemaVersion,
    entity_refs: entityRefs,
    payload: { observation: sanitizedPayload, dataset: mapping.dataset, ingest: { producer: options.producer, run_kind: options.runKind, backfill: options.runKind === "backfill" || options.runKind === "history_expansion" } },
    correlation_id: obs.correlation_id ?? null,
  };
  const derivedDrafts: DerivedDraft[] = mapping.derive({ payload: sanitizedPayload, entity: entityRefs, unit });
  const derived: EntryDraft[] = derivedDrafts.map((d) => {
    if (!TRACKS.includes(d.track) || !mapping.tracks.includes(d.track)) throw new MappingError("mapping_contract_violation", `${obs.kind}: derived track ${d.track} is not permitted`);
    return {
      track: d.track,
      record_id: d.record_id,
      event_type: d.event_type,
      schema_version: schemaVersion,
      entity_refs: { ...entityRefs, ...(d.entity_refs ?? {}) },
      payload: d.payload,
      derivation_rule: `mapping.${obs.kind}`,
      derivation_version: 1,
      correlation_id: obs.correlation_id ?? null,
    };
  });
  return { mapping, dataset: mapping.dataset, sanitizedPayload, entityRefs, contentHash: hash, source, derived };
}
