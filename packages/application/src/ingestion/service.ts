import type { Pool, TenantClient } from "@blackbox/database";
import { withTenant } from "@blackbox/database";
import type { Logger } from "@blackbox/logging";
import { anchorKeyFor, piiAnchor, type DataKey } from "@blackbox/auth";
import { EvidenceStore } from "../evidence.js";
import { linkDerived, mapObservation, MappingError, type Observation } from "../mapping/index.js";

export type Producer = "replay" | "generic" | "bank_csv" | "policy" | "review";

export interface IngestInput {
  tenantId: string;
  connectionId: string;
  producer: Producer;
  runId?: string | null;
  runKind?: string | null;
  observations: Observation[];
  /** Opaque trace id for log correlation (never a secret). */
  traceId?: string;
}

export type ObservationOutcome =
  | { provider_event_id: string; status: "accepted"; entry_ids: string[]; committed_sequence: number; delivery_id: string }
  | { provider_event_id: string; status: "duplicate"; entry_ids: string[] }
  | { provider_event_id: string; status: "conflict"; case_id: string; conflict_entry_id: string }
  | { provider_event_id: string; status: "rejected"; error_code: string; message: string };

export interface IngestResult {
  accepted: number;
  duplicate: number;
  conflict: number;
  rejected: number;
  committed_cursor: number | null;
  outcomes: ObservationOutcome[];
}

export class IngestionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "IngestionError";
    this.code = code;
    this.status = status;
  }
}

interface ConnectionRow {
  connection_id: string;
  provider: string;
  account_ref: string | null;
  status: string;
}

interface AppendedEntry {
  entry_id: string;
  journal_sequence: number;
  track: string;
  record_id: string;
}

/**
 * The ONLY path that appends journal entries. Every observation runs in its own tenant-scoped
 * transaction: connection check → mapping/validation → delivery dedupe → evidence → append source
 * entry → append derived entries → delivery update → COMMIT → `journal.batch_committed` log.
 */
export class IngestionService {
  private readonly pool: Pool;
  private readonly log: Logger;
  private readonly evidence: EvidenceStore;
  private readonly dataKey: DataKey;
  private anchorKeys = new Map<string, Buffer>();

  constructor(options: { pool: Pool; logger: Logger; evidence: EvidenceStore; dataKey: DataKey }) {
    this.pool = options.pool;
    this.log = options.logger.child({}, "ingestion");
    this.evidence = options.evidence;
    this.dataKey = options.dataKey;
  }

  private anchorFor(tenantId: string): (field: string, value: string) => string {
    let key = this.anchorKeys.get(tenantId);
    if (!key) {
      key = anchorKeyFor(this.dataKey, tenantId);
      this.anchorKeys.set(tenantId, key);
    }
    const k = key;
    return (field, value) => piiAnchor(k, field, value);
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const result: IngestResult = { accepted: 0, duplicate: 0, conflict: 0, rejected: 0, committed_cursor: null, outcomes: [] };
    if (!Array.isArray(input.observations) || input.observations.length === 0) throw new IngestionError("validation", 422, "observations must be a non-empty array");
    if (input.observations.length > 1000) throw new IngestionError("too_large", 422, "at most 1000 observations per request");
    const connection = await withTenant(this.pool, input.tenantId, (c) => this.loadConnection(c, input.connectionId));
    if (!connection) throw new IngestionError("connection_not_found", 404, "connection not found");
    if (connection.status === "disconnected") throw new IngestionError("connection_disconnected", 409, "connection is disconnected");
    const anchor = this.anchorFor(input.tenantId);
    const batchLog = this.log.child({ tenant_id: input.tenantId, connection_id: input.connectionId, run_id: input.runId ?? undefined, trace_id: input.traceId });
    const started = process.hrtime.bigint();
    for (const obs of input.observations) {
      const outcome = await this.ingestOne(input, connection, obs, anchor, batchLog);
      result.outcomes.push(outcome);
      if (outcome.status === "accepted") {
        result.accepted += 1;
        result.committed_cursor = Math.max(result.committed_cursor ?? 0, outcome.committed_sequence);
      } else if (outcome.status === "duplicate") result.duplicate += 1;
      else if (outcome.status === "conflict") result.conflict += 1;
      else result.rejected += 1;
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    batchLog.info("ingest.batch_processed", "Ingestion batch processed", {
      record_count: input.observations.length,
      duration_ms: Math.round(durationMs),
      committed_cursor: result.committed_cursor ?? undefined,
      error_code: result.rejected > 0 ? "partial_rejection" : undefined,
    });
    if (result.accepted > 0) {
      await this.touchHealth(input, result).catch(() => {});
    }
    return result;
  }

  private async loadConnection(c: TenantClient, connectionId: string): Promise<ConnectionRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
    const r = await c.query<ConnectionRow>("SELECT connection_id, provider, account_ref, status FROM connections WHERE connection_id = $1", [connectionId]);
    return r.rows[0] ?? null;
  }

  private async ingestOne(input: IngestInput, connection: ConnectionRow, obs: Observation, anchor: (f: string, v: string) => string, batchLog: Logger): Promise<ObservationOutcome> {
    const providerEventId = typeof obs?.provider_event_id === "string" ? obs.provider_event_id : "";
    let mapped;
    try {
      mapped = mapObservation(obs, { anchor, provider: connection.provider, producer: input.producer, runKind: input.runKind ?? null, connectionId: input.connectionId, accountRef: connection.account_ref });
    } catch (err) {
      if (err instanceof MappingError) {
        batchLog.warn("ingest.observation_rejected", "Observation rejected by mapping validation", { error_code: err.code, retryable: false });
        return { provider_event_id: providerEventId, status: "rejected", error_code: err.code, message: err.message };
      }
      throw err;
    }
    const outcome = await withTenant(this.pool, input.tenantId, async (c): Promise<ObservationOutcome> => {
      // Re-check the connection inside the transaction (RLS enforces tenant; status may change).
      const conn = await this.loadConnection(c, input.connectionId);
      if (!conn || conn.status === "disconnected") return { provider_event_id: providerEventId, status: "rejected", error_code: "connection_unavailable", message: "connection not available" };
      const ins = await c.query<{ delivery_id: string }>(
        `INSERT INTO deliveries (tenant_id, connection_id, provider_event_id, content_hash, status, run_id)
         VALUES ($1, $2, $3, $4, 'accepted', $5)
         ON CONFLICT (tenant_id, connection_id, provider_event_id) DO NOTHING RETURNING delivery_id`,
        [input.tenantId, input.connectionId, providerEventId, mapped.contentHash, input.runId ?? null],
      );
      const deliveryId = ins.rows[0]?.delivery_id;
      if (!deliveryId) {
        // Existing identity (committed by us earlier or by a concurrent transaction that won).
        const ex = await c.query<{ delivery_id: string; content_hash: string; entry_ids: string[]; attempts: number }>(
          "SELECT delivery_id, content_hash, entry_ids, attempts FROM deliveries WHERE connection_id = $1 AND provider_event_id = $2 FOR UPDATE",
          [input.connectionId, providerEventId],
        );
        const existing = ex.rows[0]!;
        await c.query("UPDATE deliveries SET attempts = attempts + 1, last_seen_at = now() WHERE delivery_id = $1", [existing.delivery_id]);
        if (existing.content_hash === mapped.contentHash) {
          return { provider_event_id: providerEventId, status: "duplicate", entry_ids: existing.entry_ids };
        }
        return this.recordConflict(c, input, connection, obs, mapped.contentHash, existing, providerEventId, mapped.recordId, mapped.entityRefs);
      }
      // New delivery: store raw evidence (separately controlled), then append.
      const raw = Buffer.from(JSON.stringify(obs), "utf8");
      const stored = await this.evidence.store(c, { tenantId: input.tenantId, connectionId: input.connectionId, kind: `observation.${obs.kind}`, mediaType: "application/json", content: raw });
      const resolved = await this.resolveEvidenceRefs(c, obs.evidence_refs ?? []);
      // Shared shapes (packages/connectors buildEntryDrafts): evidence and producer references are
      // attached to the source entry; derived entries link to the persisted source entry.
      const sourceDraft = {
        ...mapped.source,
        evidence_refs: [stored.evidence_id, ...resolved.evidenceIds, ...resolved.unresolved.map((u) => `unresolved:${u}`)],
        input_entry_ids: resolved.entryIds,
      };
      const [sourceEntry] = await this.append(c, [sourceDraft as unknown as Record<string, unknown>]);
      const entries: AppendedEntry[] = [sourceEntry!];
      if (mapped.derived.length > 0) {
        const derivedDrafts = linkDerived(mapped.derived.map((d) => ({ ...d, evidence_refs: [stored.evidence_id] })), sourceEntry!.entry_id);
        entries.push(...(await this.append(c, derivedDrafts as unknown as Record<string, unknown>[])));
      }
      const ids = entries.map((e) => e.entry_id);
      await c.query("UPDATE deliveries SET entry_ids = $2 WHERE delivery_id = $1", [deliveryId, ids]);
      const seq = Math.max(...entries.map((e) => e.journal_sequence));
      return { provider_event_id: providerEventId, status: "accepted", entry_ids: ids, committed_sequence: seq, delivery_id: deliveryId };
    });
    // Post-commit logging (never before COMMIT).
    if (outcome.status === "accepted") {
      batchLog.info("journal.batch_committed", "Journal batch committed", { journal_batch_id: outcome.delivery_id, record_count: outcome.entry_ids.length, committed_cursor: outcome.committed_sequence, operation_id: outcome.entry_ids[0] });
    } else if (outcome.status === "conflict") {
      batchLog.warn("ingest.conflict_observed", "Same provider event identity delivered with different content; review case opened", { error_code: "content_conflict", retryable: false, action_code: "review_required", operation_id: outcome.case_id });
    }
    return outcome;
  }

  private async append(c: TenantClient, drafts: Array<Record<string, unknown>>): Promise<AppendedEntry[]> {
    const r = await c.query<{ append_journal_entries: AppendedEntry[] }>("SELECT append_journal_entries($1::jsonb)", [JSON.stringify(drafts)]);
    const out = r.rows[0]!.append_journal_entries;
    return out.map((e) => ({ ...e, journal_sequence: Number(e.journal_sequence) }));
  }

  /** Resolves producer evidence references (other provider_event_ids in this tenant) to evidence/entry ids. */
  private async resolveEvidenceRefs(c: TenantClient, refs: string[]): Promise<{ evidenceIds: string[]; entryIds: string[]; unresolved: string[] }> {
    const clean = refs.filter((r) => typeof r === "string" && r.length > 0 && r.length <= 300).slice(0, 50);
    if (clean.length === 0) return { evidenceIds: [], entryIds: [], unresolved: [] };
    const r = await c.query<{ provider_event_id: string; entry_id: string; evidence_refs: string[] }>(
      "SELECT provider_event_id, entry_id, evidence_refs FROM journal_entries WHERE track = 'source' AND provider_event_id = ANY($1::text[])",
      [clean],
    );
    const found = new Map<string, { entry_id: string; evidence_refs: string[] }>();
    for (const row of r.rows) if (!found.has(row.provider_event_id)) found.set(row.provider_event_id, row);
    const evidenceIds: string[] = [];
    const entryIds: string[] = [];
    const unresolved: string[] = [];
    for (const ref of clean) {
      const hit = found.get(ref);
      if (hit) {
        entryIds.push(hit.entry_id);
        for (const ev of hit.evidence_refs) if (/^[0-9a-f-]{36}$/.test(ev)) evidenceIds.push(ev);
      } else unresolved.push(ref);
    }
    return { evidenceIds: [...new Set(evidenceIds)], entryIds, unresolved };
  }

  private async recordConflict(
    c: TenantClient,
    input: IngestInput,
    connection: ConnectionRow,
    obs: Observation,
    newHash: string,
    existing: { delivery_id: string; content_hash: string; entry_ids: string[] },
    providerEventId: string,
    recordId: string,
    entityRefs: Record<string, string>,
  ): Promise<ObservationOutcome> {
    const originalEntryId = existing.entry_ids[0] ?? null;
    const raw = Buffer.from(JSON.stringify(obs), "utf8");
    const stored = await this.evidence.store(c, { tenantId: input.tenantId, connectionId: input.connectionId, kind: `conflict.${obs.kind}`, mediaType: "application/json", content: raw });
    const [entry] = await this.append(c, [
      {
        track: "source",
        record_id: recordId,
        event_type: "source.conflict_observed",
        schema_version: 1,
        connection_id: input.connectionId,
        provider: connection.provider,
        account_ref: connection.account_ref,
        provider_event_id: `${providerEventId}#conflict:${newHash.slice(0, 16)}`, // the identity is taken by the original; the conflict references it
        occurred_at: new Date(obs.occurred_at).toISOString(),
        source_time: obs.source_time ?? null,
        entity_refs: entityRefs,
        payload: { original_provider_event_id: providerEventId, original_entry_id: originalEntryId, original_content_hash: existing.content_hash, conflicting_content_hash: newHash, conflicting_kind: obs.kind },
        evidence_refs: [stored.evidence_id],
        input_entry_ids: originalEntryId ? [originalEntryId] : [],
        derivation_rule: "connectors.ingest.conflict.v1",
        derivation_version: 1,
        correlation_id: obs.correlation_id ?? null,
        causation_id: providerEventId,
      },
    ]);
    const identity = `${input.connectionId}:${providerEventId}`;
    const historyItem = { at: new Date().toISOString(), actor: "system", action: "conflict_observed", entry_id: entry!.entry_id };
    const upsert = await c.query<{ case_id: string }>(
      `INSERT INTO review_cases (tenant_id, connection_id, run_id, type, state, reason, refs, history)
       VALUES ($1, $2, $3, 'provider_content_conflict', 'open', $4, $5, $6)
       ON CONFLICT (tenant_id, type, (refs->>'identity')) WHERE state <> 'resolved' AND refs ? 'identity'
       DO UPDATE SET revision = review_cases.revision + 1, updated_at = now(), history = review_cases.history || $6::jsonb
       RETURNING case_id`,
      [
        input.tenantId,
        input.connectionId,
        input.runId ?? null,
        "Same provider event identity delivered with different content",
        JSON.stringify({ identity, provider_event_id: providerEventId, original_entry_id: originalEntryId, conflict_entry_ids: [entry!.entry_id] }),
        JSON.stringify([historyItem]),
      ],
    );
    return { provider_event_id: providerEventId, status: "conflict", case_id: upsert.rows[0]!.case_id, conflict_entry_id: entry!.entry_id };
  }

  /** Updates shared source health: last_new_event_at / last_journal_commit_at per dataset capability. */
  private async touchHealth(input: IngestInput, result: IngestResult): Promise<void> {
    const datasets = new Set<string>();
    for (const o of input.observations) {
      try {
        datasets.add(mapObservation(o, { anchor: () => "x", provider: "x", producer: input.producer, runKind: null }).dataset);
      } catch {
        /* rejected ones have no dataset */
      }
    }
    await withTenant(this.pool, input.tenantId, async (c) => {
      for (const ds of datasets) {
        await c.query(
          `INSERT INTO capability_health (tenant_id, connection_id, capability_id, observed_at, status, last_attempt_at, last_successful_check_at, last_new_event_at, last_journal_commit_at, next_check_reason, history_kind, coverage_state)
           VALUES ($1, $2, $3, now(), 'healthy', now(), now(), now(), now(), 'producer_driven: no scheduled poll', 'event_history', 'unknown')
           ON CONFLICT (connection_id, capability_id) DO UPDATE SET observed_at = now(), last_attempt_at = now(), last_successful_check_at = now(), last_new_event_at = now(), last_journal_commit_at = now(), status = 'healthy'`,
          [input.tenantId, input.connectionId, ds],
        );
      }
      if (input.runId) {
        await c.query("UPDATE import_runs SET committed = committed + $2, duplicates = duplicates + $3, failed = failed + $4, loaded = loaded + $5, committed_cursor = GREATEST(COALESCE(committed_cursor,0), $6), updated_at = now() WHERE run_id = $1", [
          input.runId,
          result.accepted,
          result.duplicate,
          result.rejected,
          input.observations.length,
          result.committed_cursor ?? 0,
        ]);
      }
    });
  }
}
