/**
 * Ingestion client: appends normalized observations through the single SQL boundary.
 *
 * Within one tenant transaction (caller sets app.tenant_id):
 *   1. deliveries row is the deduplication boundary (tenant, connection, provider_event_id).
 *      - new identity           -> append Source entry, then derived entries (input_entry_ids = source)
 *      - same identity + hash   -> duplicate (attempts++), nothing appended
 *      - same identity + other  -> conflict: nothing replaced; source.conflict_observed appended
 *                                  referencing the original entry, review case opened
 *   2. journal_evidence row (immutable) is written for the raw provider payload.
 *   3. append_journal_entries(jsonb) allocates sequences under the tenant lock and writes the outbox.
 * Acknowledgement (returned counters/cursor) is only meaningful after the caller's COMMIT.
 */
import type { PoolClient } from 'pg';
import { canonicalJson, sha256Hex, type EvidenceStore } from './evidence.js';
import { derivationRule, derivedTracks, familyDataset, isKnownFamily, requiresTestFlag, MAPPING_RULE_VERSION } from './mapping.js';
import type { Observation, RejectedInput } from './types.js';

export interface IngestContext {
  tenant_id: string;
  connection_id: string;
  provider: string;
  account_ref: string | null;
  run_id: string | null;
  /** 'backfill' labels history learned later; 'live' labels activity observed during ongoing collection. */
  observation_mode: 'backfill' | 'live' | 'reconcile' | 'import';
  evidence: EvidenceStore;
}

export interface IngestOutcome {
  accepted: number;
  duplicate: number;
  conflict: number;
  rejected: number;
  entry_ids: string[];
  /** Highest journal_sequence committed by this batch (null when nothing appended). */
  committed_cursor: number | null;
  rejected_inputs: RejectedInput[];
  /** Distinct logical record ids that produced at least one accepted entry. */
  new_record_ids: string[];
  /** Max occurred_at among accepted observations (ISO) for last_new_event_at. */
  max_occurred_at: string | null;
}

interface AppendedEntry { entry_id: string; journal_sequence: number; track: string; record_id: string }

export function contentHash(o: Observation): string {
  return sha256Hex(canonicalJson({ kind: o.kind, occurred_at: o.occurred_at, source_time: o.source_time, record_id: o.record_id, entity: o.entity, payload: o.payload }));
}

/** Structural validation before anything touches the database. */
export function validateObservation(o: Observation): RejectedInput | null {
  const reject = (reason_code: RejectedInput['reason_code'], detail: string): RejectedInput => ({ provider_ref: o.provider_event_id ?? '?', dataset: o.dataset ?? '?', reason_code, detail });
  if (!o.provider_event_id || o.provider_event_id.length > 300) return reject('missing_required_field', 'provider_event_id');
  if (!o.record_id || o.record_id.length > 200) return reject('missing_required_field', 'record_id');
  if (!isKnownFamily(o.kind)) return reject('unsupported_event', `unknown event family ${o.kind}`);
  const ds = familyDataset(o.kind);
  if (ds && ds !== o.dataset) return reject('unsupported_shape', `family ${o.kind} belongs to dataset ${ds}, not ${o.dataset}`);
  if (!o.occurred_at || Number.isNaN(Date.parse(o.occurred_at))) return reject('missing_required_field', 'occurred_at');
  if (!o.payload || typeof o.payload !== 'object') return reject('missing_required_field', 'payload');
  if (requiresTestFlag(o.kind) && typeof o.payload.test !== 'boolean') return reject('missing_required_field', 'payload.test (provider test flag must be explicit)');
  for (const [k, v] of Object.entries(o.payload)) {
    if (k.endsWith('_minor') && v !== null && !Number.isInteger(v)) return reject('unsupported_shape', `${k} must be an integer minor amount`);
  }
  return null;
}

export async function ingestObservations(client: PoolClient, ctx: IngestContext, observations: Observation[]): Promise<IngestOutcome> {
  const out: IngestOutcome = { accepted: 0, duplicate: 0, conflict: 0, rejected: 0, entry_ids: [], committed_cursor: null, rejected_inputs: [], new_record_ids: [], max_occurred_at: null };
  const newRecords = new Set<string>();
  for (const o of observations) {
    const problem = validateObservation(o);
    if (problem) { out.rejected++; out.rejected_inputs.push(problem); continue; }
    const hash = contentHash(o);
    const existing = await client.query<{ delivery_id: string; content_hash: string; status: string; entry_ids: string[] }>(
      'SELECT delivery_id, content_hash, status, entry_ids FROM deliveries WHERE connection_id = $1 AND provider_event_id = $2 FOR UPDATE',
      [ctx.connection_id, o.provider_event_id]);
    const row = existing.rows[0];
    if (row && row.content_hash === hash) {
      await client.query('UPDATE deliveries SET attempts = attempts + 1, last_seen_at = now() WHERE delivery_id = $1', [row.delivery_id]);
      out.duplicate++;
      continue;
    }
    if (row) {
      // Different content under the same identity: preserve original, expose conflict.
      const original = row.entry_ids[0] ?? null;
      const conflictEntries = await appendEntries(client, [{
        track: 'source', record_id: o.record_id, event_type: 'source.conflict_observed', schema_version: 1,
        connection_id: ctx.connection_id, provider: ctx.provider, account_ref: ctx.account_ref,
        provider_event_id: `${o.provider_event_id}#conflict:${hash.slice(0, 16)}`,
        occurred_at: o.occurred_at, source_time: o.source_time, entity_refs: o.entity,
        payload: { original_provider_event_id: o.provider_event_id, original_entry_id: original, original_content_hash: row.content_hash, conflicting_content_hash: hash, conflicting_kind: o.kind, conflicting_payload: o.payload, observation_mode: ctx.observation_mode },
        evidence_refs: [], input_entry_ids: original ? [original] : [], derivation_rule: 'connectors.ingest.conflict.v1', derivation_version: 1,
        correlation_id: o.correlation_id, causation_id: o.provider_event_id,
      }]);
      await client.query('UPDATE deliveries SET attempts = attempts + 1, last_seen_at = now(), status = $2 WHERE delivery_id = $1', [row.delivery_id, 'conflict']);
      await client.query(
        `INSERT INTO review_cases (tenant_id, connection_id, run_id, type, reason, refs)
         VALUES ($1, $2, $3, 'source_conflict', $4, $5)
         ON CONFLICT DO NOTHING`,
        [ctx.tenant_id, ctx.connection_id, ctx.run_id, 'Same provider event identity delivered with different content', JSON.stringify({ identity: `${ctx.connection_id}:${o.provider_event_id}`, original_entry_id: original, conflict_entry_id: conflictEntries[0]?.entry_id ?? null, record_id: o.record_id })]);
      out.conflict++;
      out.entry_ids.push(...conflictEntries.map((e) => e.entry_id));
      out.committed_cursor = Math.max(out.committed_cursor ?? 0, ...conflictEntries.map((e) => e.journal_sequence));
      continue;
    }
    // New identity: evidence first (immutable metadata), then Source, then derived tracks.
    const evidenceRefs: string[] = [];
    if (o.evidence) {
      const bytes = Buffer.from(canonicalJson(o.evidence.content), 'utf8');
      const stored = await ctx.evidence.put(ctx.tenant_id, bytes);
      const ev = await client.query<{ evidence_id: string }>(
        `INSERT INTO journal_evidence (tenant_id, connection_id, kind, media_type, byte_size, content_hash, storage_ref, evidence_class)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'provider_payload') RETURNING evidence_id`,
        [ctx.tenant_id, ctx.connection_id, o.evidence.kind, o.evidence.media_type, stored.byte_size, stored.content_hash, stored.storage_ref]);
      evidenceRefs.push(ev.rows[0]!.evidence_id);
    }
    const payload = { ...o.payload, observation_mode: ctx.observation_mode };
    const source = await appendEntries(client, [{
      track: 'source', record_id: o.record_id, event_type: o.kind, schema_version: 1,
      connection_id: ctx.connection_id, provider: ctx.provider, account_ref: ctx.account_ref,
      provider_event_id: o.provider_event_id, occurred_at: o.occurred_at, source_time: o.source_time,
      entity_refs: o.entity, payload, evidence_refs: evidenceRefs, input_entry_ids: [],
      derivation_rule: null, derivation_version: null, correlation_id: o.correlation_id, causation_id: null,
    }]);
    const sourceEntry = source[0]!;
    const derived = derivedTracks(o.kind).map((track) => ({
      track, record_id: o.record_id, event_type: o.kind, schema_version: 1,
      connection_id: ctx.connection_id, provider: ctx.provider, account_ref: ctx.account_ref,
      provider_event_id: null, occurred_at: o.occurred_at, source_time: o.source_time,
      entity_refs: o.entity, payload, evidence_refs: evidenceRefs, input_entry_ids: [sourceEntry.entry_id],
      derivation_rule: derivationRule(o.kind, track), derivation_version: MAPPING_RULE_VERSION,
      correlation_id: o.correlation_id, causation_id: sourceEntry.entry_id,
    }));
    const derivedEntries = derived.length ? await appendEntries(client, derived) : [];
    const all = [sourceEntry, ...derivedEntries];
    await client.query(
      `INSERT INTO deliveries (tenant_id, connection_id, provider_event_id, content_hash, status, entry_ids, run_id)
       VALUES ($1, $2, $3, $4, 'accepted', $5, $6)`,
      [ctx.tenant_id, ctx.connection_id, o.provider_event_id, hash, all.map((e) => e.entry_id), ctx.run_id]);
    out.accepted++;
    out.entry_ids.push(...all.map((e) => e.entry_id));
    out.committed_cursor = Math.max(out.committed_cursor ?? 0, ...all.map((e) => e.journal_sequence));
    newRecords.add(o.record_id);
    if (!out.max_occurred_at || o.occurred_at > out.max_occurred_at) out.max_occurred_at = o.occurred_at;
  }
  out.new_record_ids = [...newRecords];
  return out;
}

async function appendEntries(client: PoolClient, entries: Record<string, unknown>[]): Promise<AppendedEntry[]> {
  const res = await client.query<{ append_journal_entries: AppendedEntry[] }>('SELECT append_journal_entries($1::jsonb)', [JSON.stringify(entries)]);
  return res.rows[0]!.append_journal_entries;
}
