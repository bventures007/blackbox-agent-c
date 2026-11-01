/**
 * Table-driven mapping from an observation (one Source entry) to the derived journal tracks and
 * the ONE builder of journal entry drafts shared by the worker ingestion client (ingest.ts) and the
 * API replay/producer path (packages/application/src/mapping). Both paths therefore append the
 * same entry shapes for the same observation; the Rust engine (docs/engine.md "Effect-once rule")
 * reads them as: event_type = family kind on every track, flat payload with the golden field
 * names, entity_refs for every linked entity, derived entries sharing the source's correlation_id
 * and referencing it in input_entry_ids.
 *
 * The derived track selection follows GOLDEN-ORDER-TO-CASH.json semantics and is constrained by
 * packages/contracts/events.json (a derived track must be listed for the family).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Track } from './types.js';

export interface EventsContractFile {
  families: Record<string, { dataset: string; tracks: Track[]; golden_example?: { example_payload: Record<string, unknown>; connection: string } | null }>;
  internal: Record<string, { tracks: Track[]; rule?: string }>;
}

let cachedContract: EventsContractFile | null = null;

/**
 * Locates the repository/installation root holding packages/contracts/events.json: BLACKBOX_REPO_ROOT
 * when set, otherwise by walking up from this file (works from src/, dist/ and a pnpm-deployed
 * node_modules tree whose image copies packages/contracts next to the app).
 */
export function contractsRoot(): string {
  const env = process.env.BLACKBOX_REPO_ROOT;
  if (env && existsSync(path.join(env, 'packages/contracts/events.json'))) return env;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(path.join(dir, 'packages/contracts/events.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('packages/contracts/events.json not found; set BLACKBOX_REPO_ROOT');
}

export function eventsContract(): EventsContractFile {
  if (!cachedContract) cachedContract = JSON.parse(readFileSync(path.join(contractsRoot(), 'packages/contracts/events.json'), 'utf8')) as EventsContractFile;
  return cachedContract;
}

export const MAPPING_RULE_VERSION = 1;

/**
 * Derived tracks per family. Source is always appended first and is never listed here.
 * A family absent from this table derives nothing beyond its Source entry unless events.json lists
 * 'fact', in which case a fact is derived (an observation is at least a fact about the source).
 */
export const DERIVED_TRACKS: Record<string, Track[]> = {
  'order.accepted': ['fact', 'commitment'],
  'order.revised': ['fact', 'commitment'],
  'order.cancelled': ['fact', 'commitment'],
  'inventory.snapshot': ['fact'],
  'inventory.adjustment_observed': ['fact'],
  'inventory.reserved': ['fact', 'reservation'],
  'inventory.reservation_released': ['fact', 'reservation'],
  // Allocations are planned fulfillment work, not stock reservations (is_stock_reservation = false): fact only.
  'allocation.revised': ['fact'],
  // events.json lists payments as source/fact/movement: an authorization or void is a fact about the
  // payment, never a cash movement (and the commitment track is not declared for this family).
  'payment.authorized': ['fact'],
  'payment.captured': ['fact', 'movement'],
  'payment.failed': ['fact'],
  'payment.voided': ['fact'],
  'payment.fee_booked': ['fact', 'movement'],
  'invoice.issued': ['fact', 'commitment'],
  'invoice.payment_marked': ['fact'],
  'invoice.credit_issued': ['fact', 'commitment'],
  'invoice.cancelled': ['fact', 'commitment'],
  'invoice.revised': ['fact', 'commitment'],
  'shipment.observed': ['fact'],
  'shipment.dispatched': ['fact', 'movement', 'reservation'],
  'shipment.delivered': ['fact'],
  'shipment.cancelled': ['fact'],
  'return.approved': ['fact'],
  'return.revised': ['fact'],
  'return.cancelled': ['fact'],
  'return.received': ['fact', 'movement'],
  'return.restocked': ['fact', 'movement'],
  'return.disposition_observed': ['fact'],
  'refund.pending': ['fact', 'reservation'],
  'refund.completed': ['fact', 'movement', 'reservation'],
  'refund.failed': ['fact'],
  'refund.reversed': ['fact', 'movement'],
  'payout.announced': ['fact', 'commitment'],
  'payout.sent': ['fact', 'movement'],
  'payout.failed': ['fact'],
  'payout.reversed': ['fact', 'movement'],
  'provider.ledger_posted': ['fact', 'movement'],
  'provider.balance_observed': ['fact'],
  'provider.hold_recorded': ['fact', 'reservation'],
  'provider.hold_released': ['fact', 'reservation'],
  'provider.release_promised': ['fact', 'commitment'],
  'dispute.opened': ['fact'],
  'dispute.resolved': ['fact'],
  'chargeback.debit_posted': ['fact', 'movement'],
  'chargeback.reversed': ['fact', 'movement'],
  'bank.credit_booked': ['fact', 'movement'],
  'bank.debit_booked': ['fact', 'movement'],
  'bank.match_recorded': ['fact'],
  'bank.match_revised': ['fact'],
};

/** Payment-family events whose provider test flag must be an explicit payload field (payout objects carry no test flag). */
const TEST_FLAG_REQUIRED = new Set([
  'payment.authorized', 'payment.captured', 'payment.failed', 'payment.voided', 'payment.fee_booked',
  'refund.pending', 'refund.completed', 'refund.failed', 'refund.reversed',
  'provider.ledger_posted', 'chargeback.debit_posted', 'chargeback.reversed',
]);

export function isKnownFamily(kind: string): boolean {
  const events = eventsContract();
  return Object.prototype.hasOwnProperty.call(events.families, kind) || Object.prototype.hasOwnProperty.call(events.internal, kind);
}

export function familyDataset(kind: string): string | null {
  return eventsContract().families[kind]?.dataset ?? null;
}

export function allowedTracks(kind: string): Track[] {
  const events = eventsContract();
  return events.families[kind]?.tracks ?? events.internal[kind]?.tracks ?? [];
}

export function requiresTestFlag(kind: string): boolean {
  return TEST_FLAG_REQUIRED.has(kind);
}

/** Derived tracks for a family, validated against events.json. Throws on an unknown family. */
export function derivedTracks(kind: string): Track[] {
  if (!isKnownFamily(kind)) throw new Error(`unknown event family: ${kind}`);
  const allowed = allowedTracks(kind);
  const wanted = DERIVED_TRACKS[kind] ?? (allowed.includes('fact') ? ['fact'] : []);
  const invalid = wanted.filter((t) => !allowed.includes(t));
  if (invalid.length) throw new Error(`mapping for ${kind} derives ${invalid.join(',')} not allowed by events.json`);
  return wanted.filter((t) => t !== 'source');
}

export function derivationRule(kind: string, track: Track): string {
  return `connectors.mapping.v${MAPPING_RULE_VERSION}:${kind}->${track}`;
}

/** Self-check used by tests: every table entry is a known family with allowed tracks. */
export function validateMappingTable(): string[] {
  const problems: string[] = [];
  for (const kind of Object.keys(DERIVED_TRACKS)) {
    try { derivedTracks(kind); } catch (e) { problems.push((e as Error).message); }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Record identity, entity references and the shared entry-draft builder
// ---------------------------------------------------------------------------------------------

/** Payload keys that name a linked entity and are copied into entity_refs (crates/domain/src/fixture.rs). */
export const ENTITY_PAYLOAD_KEYS = ['order', 'customer', 'item', 'invoice', 'transaction', 'refund', 'payout', 'return', 'reservation', 'bank_entry', 'shipment', 'credit', 'hold', 'dispute', 'promise', 'case', 'entitlement', 'allocation', 'line', 'rule', 'account', 'supply', 'coverage', 'communication', 'link', 'location', 'variant'] as const;

const ENTITY_TYPES = new Set<string>(ENTITY_PAYLOAD_KEYS);

/**
 * Record id of the business record whose history an observation extends (the same convention as
 * the engine's golden fixture builder): `<key>:<id>` where the key depends on the event family.
 */
export function recordIdFor(kind: string, payload: Record<string, unknown>, entity: Record<string, string>): string {
  const family = kind.split('.')[0] ?? kind;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(payload, k);
  const key = family === 'order' ? 'order'
    : family === 'inventory' ? (has('reservation') ? 'reservation' : 'sku')
    : family === 'allocation' ? 'reservation'
    : family === 'invoice' ? 'invoice'
    : family === 'payment' ? 'transaction'
    : family === 'shipment' || family === 'carrier' ? 'shipment'
    : family === 'return' ? 'return'
    : family === 'refund' ? 'refund'
    : family === 'payout' ? 'payout'
    : family === 'bank' ? 'bank_entry'
    : family === 'provider' ? (has('hold') ? 'hold' : 'account')
    : family === 'dispute' || family === 'chargeback' ? 'dispute'
    : family === 'customer' || family === 'supply' ? 'promise'
    : family === 'business' ? (has('case') ? 'case' : 'rule')
    : family === 'entity' ? 'link'
    : family === 'coverage' ? 'coverage'
    : family === 'communication' ? 'message'
    : 'order';
  const outKey = key === 'sku' ? 'item' : key;
  const fromPayload = payload[key];
  if (typeof fromPayload === 'string' && fromPayload.length > 0) return `${outKey}:${fromPayload}`;
  if (typeof fromPayload === 'number') return `${outKey}:${fromPayload}`;
  const fromEntity = entity[outKey] ?? entity[key];
  if (fromEntity) return `${outKey}:${fromEntity}`;
  if (typeof payload.item === 'string') return `item:${payload.item}`;
  if (entity.item) return `item:${entity.item}`;
  return `${family}:${entity.order ?? ''}`;
}

/** entity_refs = sanitized producer entity refs + same-named payload identifiers (sku -> item). */
export function entityRefsFor(payload: Record<string, unknown>, entity: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entity ?? {})) {
    if (!ENTITY_TYPES.has(k)) continue;
    if (typeof v === 'string' && v.length > 0 && v.length <= 200) out[k] = v;
    else if (typeof v === 'number') out[k] = String(v);
  }
  for (const k of ENTITY_PAYLOAD_KEYS) {
    if (out[k]) continue;
    const v = payload[k];
    if (typeof v === 'string' && v.length > 0 && v.length <= 200) out[k] = v;
  }
  if (!out.item && typeof payload.sku === 'string' && payload.sku.length > 0) out.item = payload.sku;
  return out;
}

/** Canonical JSON (sorted keys, undefined dropped) for stable content hashing. */
export function canonicalJsonStable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStable).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJsonStable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Observation content hash shared by both ingestion paths (identity-independent). */
export function observationHash(o: { kind: string; occurred_at: string; source_time?: string | null; record_id: string; entity: Record<string, string>; payload: Record<string, unknown> }): string {
  return createHash('sha256').update(canonicalJsonStable({ kind: o.kind, occurred_at: o.occurred_at, source_time: o.source_time ?? null, record_id: o.record_id, entity: o.entity, payload: o.payload })).digest('hex');
}

export type ObservationMode = 'backfill' | 'live' | 'reconcile' | 'import';

/** Entry draft handed to append_journal_entries (ids/sequence assigned by the database). */
export interface JournalEntryDraft {
  track: Track;
  record_id: string;
  event_type: string;
  schema_version: number;
  connection_id: string;
  provider: string;
  account_ref: string | null;
  provider_event_id: string | null;
  occurred_at: string;
  source_time: string | null;
  entity_refs: Record<string, string>;
  payload: Record<string, unknown>;
  evidence_refs: string[];
  input_entry_ids: string[];
  derivation_rule: string | null;
  derivation_version: number | null;
  supersedes_entry_id: string | null;
  correlation_id: string;
  causation_id: string | null;
}

export interface DraftObservation {
  provider_event_id: string;
  kind: string;
  occurred_at: string;
  source_time?: string | null;
  /** Business record identity; computed with recordIdFor when absent (producer paths). */
  record_id?: string | null;
  entity: Record<string, unknown>;
  /** Already sanitized (no PII, no authority keys). */
  payload: Record<string, unknown>;
  correlation_id?: string | null;
  schema_version?: number;
  /** Optional correction link: the entry this observation supersedes. */
  supersedes_entry_id?: string | null;
}

export interface DraftContext {
  connection_id: string;
  provider: string;
  account_ref: string | null;
  observation_mode: ObservationMode;
  /** Evidence ids (journal_evidence) attached to the source entry (and derived entries). */
  evidence_refs: string[];
  /** Earlier entries this observation references (producer evidence_refs), attached to the source entry. */
  input_entry_ids?: string[];
}

export interface EntryDrafts {
  record_id: string;
  entity_refs: Record<string, string>;
  content_hash: string;
  /** Observation key shared by all entries of this observation (docs/engine.md effect-once rule). */
  correlation_id: string;
  source: JournalEntryDraft;
  /** Derived entries; input_entry_ids/causation_id are filled by `linkDerived` once the source id is known. */
  derived: JournalEntryDraft[];
}

/**
 * Builds the source entry and its derived track entries for one observation. Pure: no I/O.
 * Both ingestion paths (worker and API) call this so the journal holds identical shapes.
 */
export function buildEntryDrafts(obs: DraftObservation, ctx: DraftContext): EntryDrafts {
  if (!isKnownFamily(obs.kind)) throw new Error(`unknown event family: ${obs.kind}`);
  const occurred = new Date(obs.occurred_at);
  if (Number.isNaN(occurred.getTime())) throw new Error('occurred_at must be an RFC3339 timestamp');
  const occurredIso = occurred.toISOString();
  const sourceTime = obs.source_time ? new Date(obs.source_time).toISOString() : null;
  const entityRefs = entityRefsFor(obs.payload, obs.entity);
  const recordId = obs.record_id && obs.record_id.length > 0 ? obs.record_id : recordIdFor(obs.kind, obs.payload, entityRefs);
  const correlation = obs.correlation_id && obs.correlation_id.length > 0 ? obs.correlation_id : `${ctx.connection_id}:${obs.provider_event_id}`;
  const payload = { ...obs.payload, observation_mode: ctx.observation_mode };
  const schemaVersion = typeof obs.schema_version === 'number' ? obs.schema_version : 1;
  const hash = observationHash({ kind: obs.kind, occurred_at: occurredIso, source_time: sourceTime, record_id: recordId, entity: entityRefs, payload: obs.payload });
  const source: JournalEntryDraft = {
    track: 'source', record_id: recordId, event_type: obs.kind, schema_version: schemaVersion,
    connection_id: ctx.connection_id, provider: ctx.provider, account_ref: ctx.account_ref,
    provider_event_id: obs.provider_event_id, occurred_at: occurredIso, source_time: sourceTime,
    entity_refs: entityRefs, payload, evidence_refs: [...ctx.evidence_refs], input_entry_ids: [...(ctx.input_entry_ids ?? [])],
    derivation_rule: null, derivation_version: null, supersedes_entry_id: obs.supersedes_entry_id ?? null,
    correlation_id: correlation, causation_id: null,
  };
  const derived: JournalEntryDraft[] = derivedTracks(obs.kind).map((track) => ({
    track, record_id: recordId, event_type: obs.kind, schema_version: schemaVersion,
    connection_id: ctx.connection_id, provider: ctx.provider, account_ref: ctx.account_ref,
    provider_event_id: null, occurred_at: occurredIso, source_time: sourceTime,
    entity_refs: entityRefs, payload, evidence_refs: [...ctx.evidence_refs], input_entry_ids: [],
    derivation_rule: derivationRule(obs.kind, track), derivation_version: MAPPING_RULE_VERSION, supersedes_entry_id: null,
    correlation_id: correlation, causation_id: null,
  }));
  return { record_id: recordId, entity_refs: entityRefs, content_hash: hash, correlation_id: correlation, source, derived };
}

/** Links derived drafts to their persisted source entry (input_entry_ids + causation_id). */
export function linkDerived(derived: JournalEntryDraft[], sourceEntryId: string): JournalEntryDraft[] {
  return derived.map((d) => ({ ...d, input_entry_ids: [sourceEntryId], causation_id: sourceEntryId }));
}

// ---------------------------------------------------------------------------------------------
// Payload sanitization shared by producer paths (PILOT-08 / INGEST-01)
// ---------------------------------------------------------------------------------------------

/** Payload keys that must never reach a canonical payload (PILOT-08). Values become opaque anchors. */
export const PII_KEYS: ReadonlySet<string> = new Set([
  'name', 'first_name', 'last_name', 'full_name', 'customer_name', 'contact', 'email', 'e_mail', 'mail', 'phone', 'telephone', 'mobile',
  'address', 'address1', 'address2', 'street', 'house_number', 'city', 'zip', 'postal_code', 'postcode', 'iban', 'bic', 'account_number',
  'account_holder', 'counterparty', 'counterparty_name', 'note', 'notes', 'message', 'body', 'subject', 'booking_text', 'comment', 'description',
  'ip', 'ip_address', 'user_agent',
]);

/** Keys that are silently dropped: they can never authorize or redirect anything (INGEST-01). */
export const DROPPED_KEYS: ReadonlySet<string> = new Set(['tenant_id', 'workspace_id', 'tenant', 'workspace', 'connection_id', 'api_key', 'token', 'secret', 'password', 'authorization']);

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
      if (typeof value === 'string' && value.trim() !== '') out[`${rawKey}_anchor`] = anchor(rawKey, value);
      continue;
    }
    if (Array.isArray(value)) {
      out[rawKey] = value.map((v) => (v && typeof v === 'object' && !Array.isArray(v) ? sanitizePayload(v as Record<string, unknown>, anchor, depth + 1) : typeof v === 'string' ? clip(v) : v));
    } else if (value && typeof value === 'object') {
      out[rawKey] = sanitizePayload(value as Record<string, unknown>, anchor, depth + 1);
    } else if (typeof value === 'string') {
      out[rawKey] = clip(value);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[rawKey] = value;
    }
  }
  return out;
}

function clip(s: string): string {
  return s.length > 1000 ? s.slice(0, 1000) : s;
}
