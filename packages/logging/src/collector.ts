import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import type { LogSink } from "./logger.js";
import type { LogRecord } from "./record.js";

export const DEFAULT_LOG_CAP_BYTES = 100 * 1024 * 1024; // 100 MiB total including index
export const DEFAULT_LOG_RETENTION_DAYS = 7;
export const INDEX_FILE = "index.json";
const FILE_RE = /^records-(\d{8})-(\d{2})\.jsonl$/;

export interface FileIndexEntry {
  bytes: number;
  count: number;
  min_occurred_at: string | null;
  max_occurred_at: string | null;
  components: Record<string, number>;
}

export interface LogIndex {
  version: 1;
  rebuilt_at: string;
  files: Record<string, FileIndexEntry>;
}

export interface CollectorStats {
  state: "healthy" | "degraded" | "unavailable";
  dir: string;
  files: number;
  bytes: number;
  cap_bytes: number;
  retention_days: number;
  retained_from: string | null;
  retained_to: string | null;
  dropped_count: number;
  buffered: number;
  buffer_capacity: number;
  last_error: string | null;
  rotated_files: number;
}

export interface FileCollectorOptions {
  dir: string;
  capBytes?: number;
  retentionDays?: number;
  /** Bounded in-memory buffer (records). Overflow increments dropped_count (DEBUG/INFO first). */
  bufferCapacity?: number;
  flushIntervalMs?: number;
  now?: () => Date;
}

export function fileNameFor(occurredAt: string): string {
  const d = new Date(occurredAt);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `records-${y}${m}${day}-${h}.jsonl`;
}

export function fileHourStart(name: string): number | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  const d = m[1]!;
  return Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)), Number(m[2]));
}

export function listLogFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort();
}

/** Rebuilds the small index (per-file min/max time, counts) by scanning the files once. */
export function rebuildIndex(dir: string): LogIndex {
  const index: LogIndex = { version: 1, rebuilt_at: new Date().toISOString(), files: {} };
  for (const name of listLogFiles(dir)) {
    const entry: FileIndexEntry = { bytes: 0, count: 0, min_occurred_at: null, max_occurred_at: null, components: {} };
    try {
      const full = path.join(dir, name);
      entry.bytes = statSync(full).size;
      const text = readFileSync(full, "utf8");
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as Partial<LogRecord>;
          entry.count += 1;
          if (typeof r.occurred_at === "string") {
            if (!entry.min_occurred_at || r.occurred_at < entry.min_occurred_at) entry.min_occurred_at = r.occurred_at;
            if (!entry.max_occurred_at || r.occurred_at > entry.max_occurred_at) entry.max_occurred_at = r.occurred_at;
          }
          if (typeof r.component === "string") entry.components[r.component] = (entry.components[r.component] ?? 0) + 1;
        } catch {
          /* corrupt line: counted as bytes only */
        }
      }
    } catch {
      /* unreadable file: keep zero entry */
    }
    index.files[name] = entry;
  }
  return index;
}

/**
 * Persistent collector: appends sanitized records to LOGS_DIR/records-YYYYMMDD-HH.jsonl with a
 * bounded async buffer, maintains index.json and enforces the 7-day / 100 MiB total cap
 * (size during ingestion, age at start and hourly). Never blocks the caller.
 */
export class FileCollector implements LogSink {
  readonly dir: string;
  readonly capBytes: number;
  readonly retentionDays: number;
  private buffer: LogRecord[] = [];
  private readonly bufferCapacity: number;
  private dropped = 0;
  private rotated = 0;
  private lastError: string | null = null;
  private index: LogIndex;
  private flushTimer: NodeJS.Timeout | null = null;
  private ageTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private closed = false;
  private readonly flushIntervalMs: number;
  private readonly now: () => Date;
  private available = true;

  constructor(options: FileCollectorOptions) {
    this.dir = options.dir;
    this.capBytes = options.capBytes ?? DEFAULT_LOG_CAP_BYTES;
    this.retentionDays = options.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
    this.bufferCapacity = options.bufferCapacity ?? 5000;
    this.flushIntervalMs = options.flushIntervalMs ?? 100;
    this.now = options.now ?? (() => new Date());
    try {
      mkdirSync(this.dir, { recursive: true });
      this.index = rebuildIndex(this.dir);
      this.writeIndex();
      this.enforceAge();
      this.enforceSize();
    } catch (err) {
      this.available = false;
      this.lastError = (err as Error).message;
      this.index = { version: 1, rebuilt_at: this.now().toISOString(), files: {} };
    }
    this.ageTimer = setInterval(() => this.enforceAge(), 60 * 60 * 1000);
    this.ageTimer.unref();
  }

  write(record: LogRecord): void {
    if (this.closed) return;
    if (this.buffer.length >= this.bufferCapacity) {
      // Overload: drop DEBUG/INFO first; keep bounded reserve for WARN/ERROR.
      if (record.level === "DEBUG" || record.level === "INFO" || this.buffer.length >= this.bufferCapacity * 1.2) {
        this.dropped += 1;
        return;
      }
    }
    this.buffer.push(record);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.flushIntervalMs);
      this.flushTimer.unref();
    }
  }

  /** Synchronous append (bounded by buffer size); called from a timer, never from the emit path. */
  flush(): void {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      const groups = new Map<string, LogRecord[]>();
      for (const r of batch) {
        const name = fileNameFor(r.occurred_at);
        const g = groups.get(name);
        if (g) g.push(r);
        else groups.set(name, [r]);
      }
      for (const [name, records] of groups) {
        const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
        appendFileSync(path.join(this.dir, name), text);
        const entry = this.index.files[name] ?? { bytes: 0, count: 0, min_occurred_at: null, max_occurred_at: null, components: {} };
        entry.bytes += Buffer.byteLength(text, "utf8");
        entry.count += records.length;
        for (const r of records) {
          if (!entry.min_occurred_at || r.occurred_at < entry.min_occurred_at) entry.min_occurred_at = r.occurred_at;
          if (!entry.max_occurred_at || r.occurred_at > entry.max_occurred_at) entry.max_occurred_at = r.occurred_at;
          entry.components[r.component] = (entry.components[r.component] ?? 0) + 1;
        }
        this.index.files[name] = entry;
      }
      this.enforceSize();
      this.writeIndex();
      this.available = true;
      this.lastError = null;
    } catch (err) {
      // Storage failure: records of this batch are lost; report instead of retrying forever.
      this.dropped += batch.length;
      this.lastError = (err as Error).message;
      this.available = false;
    } finally {
      this.flushing = false;
    }
  }

  private writeIndex(): void {
    const tmp = path.join(this.dir, INDEX_FILE + ".tmp");
    writeFileSync(tmp, JSON.stringify(this.index));
    // rename is atomic on POSIX
    try {
      unlinkSync(path.join(this.dir, INDEX_FILE));
    } catch {
      /* first write */
    }
    writeFileSync(path.join(this.dir, INDEX_FILE), readFileSync(tmp));
    unlinkSync(tmp);
  }

  private indexBytes(): number {
    try {
      return statSync(path.join(this.dir, INDEX_FILE)).size;
    } catch {
      return 0;
    }
  }

  totalBytes(): number {
    let total = this.indexBytes();
    for (const e of Object.values(this.index.files)) total += e.bytes;
    return total;
  }

  /** Deletes oldest files while total (files + index) exceeds the cap; never the current hour. */
  enforceSize(): void {
    const current = fileNameFor(this.now().toISOString());
    const names = Object.keys(this.index.files).sort();
    while (this.totalBytes() > this.capBytes && names.length > 0) {
      const oldest = names.shift()!;
      if (oldest === current && names.length === 0) {
        // Only the current file is left and still over cap: truncate it (bounded growth).
        try {
          writeFileSync(path.join(this.dir, oldest), "");
          this.index.files[oldest] = { bytes: 0, count: 0, min_occurred_at: null, max_occurred_at: null, components: {} };
          this.rotated += 1;
        } catch {
          /* ignore */
        }
        break;
      }
      this.removeFile(oldest);
    }
  }

  /** Deletes files whose hour is older than retention; called at start and hourly. */
  enforceAge(): void {
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const name of Object.keys(this.index.files)) {
      const hour = fileHourStart(name);
      if (hour !== null && hour + 60 * 60 * 1000 <= cutoff) this.removeFile(name);
    }
    try {
      this.writeIndex();
    } catch {
      /* ignore */
    }
  }

  private removeFile(name: string): void {
    try {
      unlinkSync(path.join(this.dir, name));
    } catch {
      /* already gone */
    }
    delete this.index.files[name];
    this.rotated += 1;
  }

  stats(): CollectorStats {
    const names = Object.keys(this.index.files).sort();
    let from: string | null = null;
    let to: string | null = null;
    for (const n of names) {
      const e = this.index.files[n]!;
      if (e.min_occurred_at && (!from || e.min_occurred_at < from)) from = e.min_occurred_at;
      if (e.max_occurred_at && (!to || e.max_occurred_at > to)) to = e.max_occurred_at;
    }
    const bytes = this.totalBytes();
    return {
      state: !this.available ? "unavailable" : this.dropped > 0 || bytes > this.capBytes * 0.9 ? "degraded" : "healthy",
      dir: this.dir,
      files: names.length,
      bytes,
      cap_bytes: this.capBytes,
      retention_days: this.retentionDays,
      retained_from: from,
      retained_to: to,
      dropped_count: this.dropped,
      buffered: this.buffer.length,
      buffer_capacity: this.bufferCapacity,
      last_error: this.lastError,
      rotated_files: this.rotated,
    };
  }

  close(): void {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.ageTimer) clearInterval(this.ageTimer);
    this.flush();
  }
}
