import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { fileHourStart, INDEX_FILE, listLogFiles, type LogIndex } from "./collector.js";
import { LEVEL_RANK, LOG_LEVELS, type LogLevel, type LogRecord } from "./record.js";

export interface LogQuery {
  level_min?: LogLevel;
  levels?: LogLevel[];
  since?: string; // RFC3339 inclusive
  until?: string; // RFC3339 exclusive
  component?: string[];
  connection_id?: string[];
  run_id?: string[];
  trace_id?: string[];
  /** Literal, case-insensitive substring over sanitized string fields. */
  q?: string;
  cursor?: string | null;
  limit?: number;
  /**
   * Workspace scope: when set, records carrying another tenant_id are excluded; installation
   * records (no tenant_id) remain visible to the owner. When `tenant_only` is true, installation
   * records are excluded too.
   */
  tenant_id?: string;
  tenant_only?: boolean;
}

export interface LogQueryResult {
  records: LogRecord[];
  page: { next_cursor: string | null; truncated: boolean };
  retained_from: string | null;
  retained_to: string | null;
  scanned_files: number;
}

export const DEFAULT_PAGE = 200;
export const MAX_PAGE = 1000;

export function encodeCursor(occurredAt: string, recordId: string): string {
  return Buffer.from(`${occurredAt}|${recordId}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { occurred_at: string; record_id: string } | null {
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    const i = text.indexOf("|");
    if (i <= 0) return null;
    const occurred_at = text.slice(0, i);
    const record_id = text.slice(i + 1);
    if (Number.isNaN(Date.parse(occurred_at)) || !/^[0-9a-f-]{36}$/.test(record_id)) return null;
    return { occurred_at, record_id };
  } catch {
    return null;
  }
}

/** Newest first: (occurred_at desc, record_id desc). */
function compareDesc(a: LogRecord, b: LogRecord): number {
  if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? 1 : -1;
  if (a.record_id !== b.record_id) return a.record_id < b.record_id ? 1 : -1;
  return 0;
}

export function normalizeQuery(q: LogQuery): Required<Pick<LogQuery, "since" | "until" | "limit">> & LogQuery {
  const now = Date.now();
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(q.limit ?? DEFAULT_PAGE)));
  const since = q.since ?? new Date(now - 60 * 60 * 1000).toISOString();
  const until = q.until ?? new Date(now + 60 * 1000).toISOString();
  if (Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) throw new RangeError("since/until must be RFC3339 timestamps");
  const levels = q.levels?.filter((l) => LOG_LEVELS.includes(l));
  if (q.level_min && !LOG_LEVELS.includes(q.level_min)) throw new RangeError("level_min must be one of DEBUG, INFO, WARN, ERROR");
  return { ...q, since, until, limit, levels };
}

export function matches(record: LogRecord, q: ReturnType<typeof normalizeQuery>): boolean {
  if (record.occurred_at < q.since || record.occurred_at >= q.until) return false;
  if (q.tenant_id) {
    if (record.tenant_id && record.tenant_id !== q.tenant_id) return false;
    if (q.tenant_only && !record.tenant_id) return false;
  }
  if (q.levels && q.levels.length > 0) {
    if (!q.levels.includes(record.level)) return false;
  } else {
    const min = LEVEL_RANK[q.level_min ?? "INFO"];
    if (LEVEL_RANK[record.level] < min) return false;
  }
  if (q.component && q.component.length > 0 && !q.component.includes(record.component)) return false;
  if (q.connection_id && q.connection_id.length > 0 && (!record.connection_id || !q.connection_id.includes(record.connection_id))) return false;
  if (q.run_id && q.run_id.length > 0 && (!record.run_id || !q.run_id.includes(record.run_id))) return false;
  if (q.trace_id && q.trace_id.length > 0 && (!record.trace_id || !q.trace_id.includes(record.trace_id))) return false;
  if (q.q) {
    const needle = q.q.toLowerCase();
    let hit = false;
    for (const v of Object.values(record)) {
      if (typeof v === "string" && v.toLowerCase().includes(needle)) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }
  return true;
}

export function readIndex(dir: string): LogIndex | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, INDEX_FILE), "utf8")) as LogIndex;
  } catch {
    return null;
  }
}

function parseFile(dir: string, name: string): LogRecord[] {
  const out: LogRecord[] = [];
  let text: string;
  try {
    text = readFileSync(path.join(dir, name), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as LogRecord;
      if (r && typeof r.record_id === "string" && typeof r.occurred_at === "string") out.push(r);
    } catch {
      /* corrupt line skipped; counted nowhere (visible in doctor as parse errors) */
    }
  }
  return out;
}

/**
 * Bounded cursor query over the retained files, newest first. Files are hour buckets of
 * occurred_at, so iterating files newest-first and sorting inside each file yields global order.
 */
export function queryLogs(dir: string, query: LogQuery): LogQueryResult {
  const q = normalizeQuery(query);
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (q.cursor && !cursor) throw new RangeError("invalid cursor");
  const files = listLogFiles(dir).reverse();
  const sinceHour = Date.parse(q.since) - 60 * 60 * 1000;
  const untilMs = Date.parse(q.until);
  const results: LogRecord[] = [];
  let scanned = 0;
  let retainedFrom: string | null = null;
  let retainedTo: string | null = null;
  const index = readIndex(dir);
  if (index) {
    for (const e of Object.values(index.files)) {
      if (e.min_occurred_at && (!retainedFrom || e.min_occurred_at < retainedFrom)) retainedFrom = e.min_occurred_at;
      if (e.max_occurred_at && (!retainedTo || e.max_occurred_at > retainedTo)) retainedTo = e.max_occurred_at;
    }
  }
  for (const name of files) {
    const hour = fileHourStart(name);
    if (hour === null) continue;
    if (hour > untilMs || hour + 60 * 60 * 1000 < sinceHour) continue;
    if (cursor && hour > Date.parse(cursor.occurred_at) + 60 * 60 * 1000) continue;
    scanned += 1;
    const records = parseFile(dir, name).filter((r) => matches(r, q));
    records.sort(compareDesc);
    for (const r of records) {
      if (cursor) {
        // strictly older than the cursor position
        if (r.occurred_at > cursor.occurred_at) continue;
        if (r.occurred_at === cursor.occurred_at && r.record_id >= cursor.record_id) continue;
      }
      results.push(r);
      if (results.length > q.limit) break;
    }
    if (results.length > q.limit) break;
  }
  const truncated = results.length > q.limit;
  const page = results.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    records: page,
    page: { next_cursor: truncated && last ? encodeCursor(last.occurred_at, last.record_id) : null, truncated },
    retained_from: retainedFrom,
    retained_to: retainedTo,
    scanned_files: scanned,
  };
}

/** Looks up one record and its trace siblings (same trace_id) within ±1 h of the record. */
export function getLogRecord(dir: string, recordId: string): { record: LogRecord; siblings: LogRecord[] } | null {
  for (const name of listLogFiles(dir).reverse()) {
    const records = parseFile(dir, name);
    const hit = records.find((r) => r.record_id === recordId);
    if (hit) {
      const siblings = hit.trace_id
        ? queryLogs(dir, {
            since: new Date(Date.parse(hit.occurred_at) - 3600_000).toISOString(),
            until: new Date(Date.parse(hit.occurred_at) + 3600_000).toISOString(),
            trace_id: [hit.trace_id],
            level_min: "DEBUG",
            limit: 200,
          }).records.filter((r) => r.record_id !== hit.record_id)
        : [];
      return { record: hit, siblings };
    }
  }
  return null;
}

/**
 * Follows the files: calls `onRecord` for records appended after the call started (by file
 * offsets), until `signal` aborts. Polls every `intervalMs` (default 1000).
 */
export function followLogs(dir: string, query: LogQuery, onRecord: (r: LogRecord) => void, signal: AbortSignal, intervalMs = 1000): Promise<void> {
  const q = normalizeQuery({ ...query, since: query.since ?? new Date().toISOString(), until: "9999-12-31T00:00:00.000Z" });
  const offsets = new Map<string, number>();
  for (const name of listLogFiles(dir)) {
    try {
      offsets.set(name, statSync(path.join(dir, name)).size);
    } catch {
      /* ignore */
    }
  }
  return new Promise<void>((resolve) => {
    const tick = () => {
      if (signal.aborted) return resolve();
      for (const name of listLogFiles(dir)) {
        const full = path.join(dir, name);
        if (!existsSync(full)) continue;
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        const start = offsets.get(name) ?? 0;
        if (size <= start) continue;
        const fd = openSync(full, "r");
        try {
          const buf = Buffer.alloc(size - start);
          readSync(fd, buf, 0, buf.length, start);
          for (const line of buf.toString("utf8").split("\n")) {
            if (!line) continue;
            try {
              const r = JSON.parse(line) as LogRecord;
              if (matches(r, q)) onRecord(r);
            } catch {
              /* partial line: wait for next tick (offset advanced; acceptable loss of one torn line) */
            }
          }
        } finally {
          closeSync(fd);
        }
        offsets.set(name, size);
      }
      timer = setTimeout(tick, intervalMs);
    };
    let timer = setTimeout(tick, intervalMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
