import type { Pool, TenantClient } from "@blackbox/database";
import { withTenant } from "@blackbox/database";
import { TRACKS, type Track } from "./contracts.js";

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
  source_time: string | null;
  entity_refs: Record<string, string>;
  payload: Record<string, unknown>;
  payload_hash: string;
  evidence_refs: string[];
  input_entry_ids: string[];
  derivation_rule: string | null;
  derivation_version: number | null;
  supersedes_entry_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
}

export interface JournalFilter {
  track?: Track;
  event_type?: string;
  record_id?: string;
  entity?: { type: string; id: string };
  occurred_from?: string;
  occurred_to?: string;
  recorded_from?: string;
  recorded_to?: string;
  q?: string;
  connection_id?: string;
}

export interface PageResult<T> {
  entries: T[];
  page: { next_cursor: string | null; snapshot_cursor: number; truncated: boolean };
  consistency: { committed_cursor: number; snapshot_cursor: number };
}

export const MAX_PAGE_ROWS = 500;
export const DEFAULT_PAGE_ROWS = 100;

export class CursorError extends Error {
  readonly code = "invalid_cursor";
}

interface CursorToken {
  t: string; // tenant
  s: number; // snapshot high-water mark
  a: number; // last sequence delivered
}

export function encodeJournalCursor(tenantId: string, snapshot: number, after: number): string {
  return Buffer.from(JSON.stringify({ t: tenantId, s: snapshot, a: after } satisfies CursorToken), "utf8").toString("base64url");
}

/** A cursor from another tenant is rejected the same way as a malformed one (no existence signal). */
export function decodeJournalCursor(cursor: string, tenantId: string): CursorToken {
  let token: CursorToken;
  try {
    token = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorToken;
  } catch {
    throw new CursorError("cursor is not valid");
  }
  if (!token || token.t !== tenantId || !Number.isInteger(token.s) || !Number.isInteger(token.a) || token.a < 0 || token.s < token.a) throw new CursorError("cursor is not valid");
  return token;
}

function rowToEntry(r: Record<string, unknown>): JournalEntry {
  return {
    entry_id: r.entry_id as string,
    tenant_id: r.tenant_id as string,
    journal_sequence: Number(r.journal_sequence),
    track: r.track as Track,
    record_id: r.record_id as string,
    event_type: r.event_type as string,
    schema_version: Number(r.schema_version),
    connection_id: (r.connection_id as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    account_ref: (r.account_ref as string | null) ?? null,
    provider_event_id: (r.provider_event_id as string | null) ?? null,
    occurred_at: (r.occurred_at as Date).toISOString(),
    recorded_at: (r.recorded_at as Date).toISOString(),
    source_time: r.source_time ? (r.source_time as Date).toISOString() : null,
    entity_refs: (r.entity_refs as Record<string, string>) ?? {},
    payload: (r.payload as Record<string, unknown>) ?? {},
    payload_hash: r.payload_hash as string,
    evidence_refs: (r.evidence_refs as string[]) ?? [],
    input_entry_ids: (r.input_entry_ids as string[]) ?? [],
    derivation_rule: (r.derivation_rule as string | null) ?? null,
    derivation_version: r.derivation_version === null || r.derivation_version === undefined ? null : Number(r.derivation_version),
    supersedes_entry_id: (r.supersedes_entry_id as string | null) ?? null,
    correlation_id: (r.correlation_id as string | null) ?? null,
    causation_id: (r.causation_id as string | null) ?? null,
  };
}

/**
 * Read side of the canonical journal. Pagination uses a committed snapshot
 * (tenant_sequences.last_sequence): sequences are allocated under the tenant row lock inside the
 * append transaction, so every sequence <= snapshot is committed and visible — a late commit can
 * never appear below a snapshot that was already read (JOURNAL-AND-MCP §3, MCP-05).
 */
export class JournalService {
  constructor(private readonly pool: Pool) {}

  /** Indexed point read of the committed cursor in its own tenant transaction (cheap; used on error paths). */
  async committedCursorOf(tenantId: string): Promise<number> {
    return withTenant(this.pool, tenantId, (c) => this.committedCursor(c, tenantId));
  }

  async committedCursor(c: TenantClient, tenantId: string): Promise<number> {
    const r = await c.query<{ last_sequence: string }>("SELECT last_sequence FROM tenant_sequences WHERE tenant_id = $1", [tenantId]);
    return Number(r.rows[0]?.last_sequence ?? 0);
  }

  async list(tenantId: string, filter: JournalFilter, page: { cursor?: string | null; limit?: number }): Promise<PageResult<JournalEntry>> {
    const limit = Math.min(MAX_PAGE_ROWS, Math.max(1, Math.floor(page.limit ?? DEFAULT_PAGE_ROWS)));
    return withTenant(this.pool, tenantId, async (c) => {
      const committed = await this.committedCursor(c, tenantId);
      let snapshot = committed;
      let after = 0;
      if (page.cursor) {
        const token = decodeJournalCursor(page.cursor, tenantId);
        snapshot = token.s;
        after = token.a;
      }
      const where: string[] = ["journal_sequence > $1", "journal_sequence <= $2"];
      const params: unknown[] = [after, snapshot];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (filter.track && TRACKS.includes(filter.track)) add("track = ?", filter.track);
      if (filter.event_type) add("event_type = ?", filter.event_type);
      if (filter.record_id) add("record_id = ?", filter.record_id);
      if (filter.connection_id) add("connection_id = ?", filter.connection_id);
      if (filter.entity) add("entity_refs @> ?::jsonb", JSON.stringify({ [filter.entity.type]: filter.entity.id }));
      if (filter.occurred_from) add("occurred_at >= ?", filter.occurred_from);
      if (filter.occurred_to) add("occurred_at < ?", filter.occurred_to);
      if (filter.recorded_from) add("recorded_at >= ?", filter.recorded_from);
      if (filter.recorded_to) add("recorded_at < ?", filter.recorded_to);
      if (filter.q) {
        // Literal search over record ids, event types and entity refs (never free text to a model).
        params.push(`%${filter.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
        where.push(`(record_id ILIKE $${params.length} OR event_type ILIKE $${params.length} OR entity_refs::text ILIKE $${params.length})`);
      }
      params.push(limit + 1);
      const r = await c.query(`SELECT * FROM journal_entries WHERE ${where.join(" AND ")} ORDER BY journal_sequence ASC LIMIT $${params.length}`, params);
      const rows = r.rows.map(rowToEntry);
      const truncated = rows.length > limit;
      const entries = truncated ? rows.slice(0, limit) : rows;
      const last = entries[entries.length - 1];
      return {
        entries,
        page: { next_cursor: truncated && last ? encodeJournalCursor(tenantId, snapshot, last.journal_sequence) : null, snapshot_cursor: snapshot, truncated },
        consistency: { committed_cursor: committed, snapshot_cursor: snapshot },
      };
    });
  }

  async get(tenantId: string, entryId: string): Promise<{ entry: JournalEntry; supersedes: JournalEntry | null; superseded_by: JournalEntry[]; derived_from: JournalEntry[]; derivations: JournalEntry[] } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(entryId)) return null;
    return withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query("SELECT * FROM journal_entries WHERE entry_id = $1", [entryId]);
      const row = r.rows[0];
      if (!row) return null;
      const entry = rowToEntry(row);
      const supersedes = entry.supersedes_entry_id ? await c.query("SELECT * FROM journal_entries WHERE entry_id = $1", [entry.supersedes_entry_id]) : null;
      const supersededBy = await c.query("SELECT * FROM journal_entries WHERE supersedes_entry_id = $1 ORDER BY journal_sequence", [entryId]);
      const derivedFrom = entry.input_entry_ids.length > 0 ? await c.query("SELECT * FROM journal_entries WHERE entry_id = ANY($1::uuid[]) ORDER BY journal_sequence", [entry.input_entry_ids]) : null;
      const derivations = await c.query("SELECT * FROM journal_entries WHERE $1 = ANY(input_entry_ids) ORDER BY journal_sequence", [entryId]);
      return {
        entry,
        supersedes: supersedes?.rows[0] ? rowToEntry(supersedes.rows[0]) : null,
        superseded_by: supersededBy.rows.map(rowToEntry),
        derived_from: derivedFrom?.rows.map(rowToEntry) ?? [],
        derivations: derivations.rows.map(rowToEntry),
      };
    });
  }

  /** Complete history of an entity (all tracks whose entity_refs or record_id reference it). */
  async entityHistory(tenantId: string, entityType: string, entityId: string, page: { cursor?: string | null; limit?: number }): Promise<PageResult<JournalEntry>> {
    const limit = Math.min(MAX_PAGE_ROWS, Math.max(1, Math.floor(page.limit ?? DEFAULT_PAGE_ROWS)));
    return withTenant(this.pool, tenantId, async (c) => {
      const committed = await this.committedCursor(c, tenantId);
      let snapshot = committed;
      let after = 0;
      if (page.cursor) {
        const token = decodeJournalCursor(page.cursor, tenantId);
        snapshot = token.s;
        after = token.a;
      }
      const r = await c.query(
        `SELECT * FROM journal_entries
          WHERE journal_sequence > $1 AND journal_sequence <= $2 AND (entity_refs @> $3::jsonb OR record_id = $4)
          ORDER BY journal_sequence ASC LIMIT $5`,
        [after, snapshot, JSON.stringify({ [entityType]: entityId }), `${entityType}:${entityId}`, limit + 1],
      );
      const rows = r.rows.map(rowToEntry);
      const truncated = rows.length > limit;
      const entries = truncated ? rows.slice(0, limit) : rows;
      const last = entries[entries.length - 1];
      return {
        entries,
        page: { next_cursor: truncated && last ? encodeJournalCursor(tenantId, snapshot, last.journal_sequence) : null, snapshot_cursor: snapshot, truncated },
        consistency: { committed_cursor: committed, snapshot_cursor: snapshot },
      };
    });
  }

  /**
   * Distinct event types present for a tenant through a loose index scan on
   * journal_entries_event_idx (tenant_id, event_type, journal_sequence): O(distinct types × log n)
   * instead of a GROUP BY over the whole journal. This is the readiness input (datasets present
   * are derived from event types only), evaluated on every served state/answer when the memo
   * expired; the full per-type statistics stay in presentEventTypes() for the sources/datasets views.
   */
  async presentEventTypesIndexed(c: TenantClient, tenantId: string): Promise<string[]> {
    const r = await c.query<{ event_type: string }>(
      `WITH RECURSIVE t AS (
         SELECT min(event_type) AS event_type FROM journal_entries WHERE tenant_id = $1
         UNION ALL
         SELECT (SELECT min(event_type) FROM journal_entries WHERE tenant_id = $1 AND event_type > t.event_type) FROM t WHERE t.event_type IS NOT NULL
       )
       SELECT event_type FROM t WHERE event_type IS NOT NULL`,
      [tenantId],
    );
    return r.rows.map((x) => x.event_type);
  }

  /** Distinct datasets/event types with counts and time bounds for a tenant (full scan of the source track; views only). */
  async presentEventTypes(c: TenantClient): Promise<Array<{ event_type: string; count: number; first_occurred_at: string; last_occurred_at: string; last_recorded_at: string }>> {
    const r = await c.query<{ event_type: string; n: string; first_o: Date; last_o: Date; last_r: Date }>(
      "SELECT event_type, count(*)::text AS n, min(occurred_at) AS first_o, max(occurred_at) AS last_o, max(recorded_at) AS last_r FROM journal_entries WHERE track = 'source' GROUP BY event_type",
    );
    return r.rows.map((x) => ({ event_type: x.event_type, count: Number(x.n), first_occurred_at: x.first_o.toISOString(), last_occurred_at: x.last_o.toISOString(), last_recorded_at: x.last_r.toISOString() }));
  }

  async stats(tenantId: string): Promise<{ committed_cursor: number; entries_by_track: Record<string, number>; has_entity_links: boolean }> {
    return withTenant(this.pool, tenantId, async (c) => {
      const committed = await this.committedCursor(c, tenantId);
      const r = await c.query<{ track: string; n: string }>("SELECT track::text AS track, count(*)::text AS n FROM journal_entries GROUP BY track");
      const links = await c.query("SELECT 1 FROM journal_entries WHERE entity_refs <> '{}'::jsonb LIMIT 1");
      return { committed_cursor: committed, entries_by_track: Object.fromEntries(r.rows.map((x) => [x.track, Number(x.n)])), has_entity_links: (links.rowCount ?? 0) > 0 };
    });
  }
}
