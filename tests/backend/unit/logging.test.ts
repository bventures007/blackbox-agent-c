/**
 * Logging unit tests. Covers DIAG-03 (record contract: allowlisted versioned fields, clipping,
 * 16 KiB cap), DIAG-05 (debug gate expiry, size/age rotation of the collector), DIAG-06
 * (redaction canaries never reach any sink: stderr stream, file collector, event emitter) and the
 * bounded cursor query used by the API and CLI.
 */
import { readFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, DebugGate, FileCollector, fileNameFor, queryLogs, rebuildIndex, redactString, sanitizeRecord, ALLOWED_FIELDS, LIMITS, OPTIONAL_FIELDS, REQUIRED_FIELDS, LOG_LEVELS, LOG_SCOPES, type LogRecord, decodeCursor, encodeCursor } from "@blackbox/logging";
import { repoRoot } from "../vitest.shared.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "bb-log-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function captureStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

describe("record contract (DIAG-03)", () => {
  it("mirrors packages/contracts/log-record.json exactly", () => {
    const contract = JSON.parse(readFileSync(path.join(repoRoot, "packages/contracts/log-record.json"), "utf8")) as { required: string[]; optional: string[]; levels: string[]; scope: string[]; limits: { max_string: number; max_record_bytes: number } };
    expect([...REQUIRED_FIELDS]).toEqual(contract.required);
    expect([...OPTIONAL_FIELDS]).toEqual(contract.optional);
    expect([...LOG_LEVELS]).toEqual(contract.levels);
    expect([...LOG_SCOPES]).toEqual(contract.scope);
    expect(LIMITS).toEqual(contract.limits);
    expect(ALLOWED_FIELDS.size).toBe(contract.required.length + contract.optional.length);
  });

  it("drops unknown keys, enforces types, clips strings and caps the record at 16 KiB", () => {
    const rec = sanitizeRecord({ schema_version: 1, record_id: "r", occurred_at: "t", observed_at: "t", level: "INFO", event_name: "x", message: "m".repeat(2000), component: "api", service_version: "1", instance_id: "i", scope: "workspace", password: "hunter2", body: { nested: true }, duration_ms: "12", attempt: 2, tenant_id: "t1" });
    expect((rec as unknown as Record<string, unknown>).password).toBeUndefined();
    expect((rec as unknown as Record<string, unknown>).body).toBeUndefined();
    expect((rec as unknown as Record<string, unknown>).duration_ms).toBeUndefined();
    expect(rec.attempt).toBe(2);
    expect(rec.message.length).toBeLessThanOrEqual(512);
    expect(rec.truncated).toBe(true);
    expect(rec.scope).toBe("workspace");
    const noTenant = sanitizeRecord({ level: "INFO", scope: "workspace", message: "x" });
    expect(noTenant.scope).toBe("installation");
    const big = sanitizeRecord({ level: "ERROR", message: "x", ...Object.fromEntries([...OPTIONAL_FIELDS].filter((f) => f !== "attempt" && f !== "duration_ms" && f !== "record_count" && f !== "committed_cursor" && f !== "applied_cursor" && f !== "retryable" && f !== "truncated").map((f) => [f, "y".repeat(600)])) });
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(16384);
  });

  it("emits required fields with the component/version and routes DEBUG only through the gate", () => {
    const { stream, lines } = captureStream();
    const gate = new DebugGate();
    const log = createLogger({ component: "worker", serviceVersion: "9.9.9", instanceId: "inst", stream, debugGate: gate });
    log.debug("x.debug", "hidden");
    log.info("journal.batch_committed", "Journal batch committed", { tenant_id: "11111111-1111-4111-8111-111111111111", committed_cursor: 42, record_count: 3 });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as LogRecord;
    for (const f of REQUIRED_FIELDS) expect(rec).toHaveProperty(f);
    expect(rec).toMatchObject({ level: "INFO", component: "worker", service_version: "9.9.9", instance_id: "inst", scope: "workspace", committed_cursor: 42, record_count: 3, event_name: "journal.batch_committed" });
    expect(rec.record_id).toMatch(/^[0-9a-f-]{36}$/);
    gate.set({ debug_id: "d", tenant_id: "t", component: "worker", expires_at: new Date(Date.now() + 60_000).toISOString() });
    log.debug("x.debug", "now visible");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).level).toBe("DEBUG");
  });

  it("aggregates repeated identical WARN/ERROR records and reports suppression", () => {
    const { stream, lines } = captureStream();
    const log = createLogger({ component: "api", serviceVersion: "1", stream });
    for (let i = 0; i < 50; i += 1) log.error("provider.failed", "Provider call failed", { error_code: "rate_limited" });
    expect(lines.length).toBe(20);
    expect(log.stats().suppressed).toBe(30);
  });
});

describe("redaction canaries (DIAG-06)", () => {
  const canaries = [
    "bbk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg",
    "bba_ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210zyxwvut",
    "Bearer eyJhbGciOiJIUzI1NiJ9.canary.signature",
    "password=Sup3rSecret!",
    "Authorization: Basic dXNlcjpwYXNz",
    "postgres://bb_api:s3cretpw@db:5432/blackbox",
    "https://user:pw@shop.example.com/admin",
    "anna.canary@example.com",
    "$argon2id$v=19$m=65536,t=3,p=1$canarysalt$canaryhash",
    "shpat_0123456789abcdef0123456789abcdef",
    "/Users/alice/secret-folder/file.txt",
    "x-producer-signature: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "cookie: bb_session=abcdef0123456789abcdef0123456789",
  ];
  const secretParts = ["AbCdEfGhIjKl", "ZyXwVuTsRqPo", "eyJhbGciOiJIUzI1NiJ9", "Sup3rSecret", "dXNlcjpwYXNz", "s3cretpw", "user:pw", "anna.canary", "canaryhash", "shpat_0123", "/Users/alice", "0123456789abcdef0123456789abcdef0123456789abcdef", "abcdef0123456789abcdef0123456789"];

  it("never lets canaries reach stderr, the file collector, the event emitter or the index", async () => {
    const dir = tmp();
    const { stream, lines } = captureStream();
    const collector = new FileCollector({ dir, flushIntervalMs: 5 });
    const emitted: LogRecord[] = [];
    const log = createLogger({ component: "api", serviceVersion: "1", stream, sinks: [collector] });
    log.events.on("record", (r: LogRecord) => emitted.push(r));
    for (const c of canaries) {
      log.error("test.canary", `failure while handling ${c} <script>alert(1)</script> \u001b[31mred\u001b[0m`, { error_code: c, action_code: `retry ${c}`, tenant_id: "11111111-1111-4111-8111-111111111111" });
      log.warn("test.canary_field", "nested", { message: c, operation_id: c } as never);
    }
    await new Promise((r) => setTimeout(r, 60));
    collector.close();
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);
    const sinkText = files.map((f) => readFileSync(path.join(dir, f), "utf8")).join("") + lines.join("") + JSON.stringify(emitted) + readFileSync(path.join(dir, "index.json"), "utf8");
    for (const part of secretParts) expect(sinkText, part).not.toContain(part);
    expect(sinkText).not.toContain("<script>");
    expect(sinkText).not.toContain("\u001b");
    expect(sinkText).toContain("[redacted]");
  });

  it("redactString escapes control characters and clips", () => {
    const r = redactString("a\u0000b\u001bc d" + "x".repeat(600));
    expect(r.value.startsWith("a\\u0000b\\u001bc\\u2028d")).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.value.length).toBeLessThanOrEqual(512);
  });
});

describe("debug gate (DIAG-05)", () => {
  it("enforces expiry server-side and scopes by component/connection/run", () => {
    let now = Date.parse("2026-11-01T10:00:00Z");
    const gate = new DebugGate(() => now);
    gate.set({ debug_id: "a", tenant_id: "t", component: "worker", connection_id: "c1", expires_at: "2026-11-01T10:15:00Z" });
    expect(gate.isEnabled("worker", { connection_id: "c1" })).toBe(true);
    expect(gate.isEnabled("worker", { connection_id: "c2" })).toBe(false);
    expect(gate.isEnabled("api", { connection_id: "c1" })).toBe(false);
    now = Date.parse("2026-11-01T10:15:00Z");
    expect(gate.isEnabled("worker", { connection_id: "c1" })).toBe(false);
    expect(gate.active()).toHaveLength(0);
    gate.set({ debug_id: "b", tenant_id: "t", component: "*", expires_at: "2026-11-01T10:30:00Z" });
    expect(gate.isEnabled("engine")).toBe(true);
    gate.reset();
    expect(gate.isEnabled("engine")).toBe(false);
  });
});

describe("collector rotation and query", () => {
  function rec(occurredAt: string, level: LogRecord["level"] = "INFO", extra: Partial<LogRecord> = {}): LogRecord {
    return { schema_version: 1, record_id: crypto.randomUUID(), occurred_at: occurredAt, observed_at: occurredAt, level, event_name: "e", message: "m", component: "api", service_version: "1", instance_id: "i", scope: "installation", ...extra } as LogRecord;
  }

  it("enforces the total size cap (files + index) by deleting the oldest files", async () => {
    const dir = tmp();
    const now = new Date("2026-11-01T12:00:00Z");
    const collector = new FileCollector({ dir, capBytes: 40_000, flushIntervalMs: 5, now: () => now });
    for (let h = 0; h < 6; h += 1) {
      const t = new Date(now.getTime() - (6 - h) * 3600_000).toISOString();
      for (let i = 0; i < 60; i += 1) collector.write(rec(t, "INFO", { message: "x".repeat(150) }));
      await new Promise((r) => setTimeout(r, 20));
    }
    collector.close();
    const stats = collector.stats();
    expect(stats.bytes).toBeLessThanOrEqual(40_000);
    expect(stats.rotated_files).toBeGreaterThan(0);
    expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length).toBeLessThan(6);
    expect(existsSync(path.join(dir, "index.json"))).toBe(true);
  });

  it("expires files older than the retention window at startup and reports the retained range", () => {
    const dir = tmp();
    const now = new Date("2026-11-08T12:00:00Z");
    const old = new Date("2026-10-30T11:00:00Z").toISOString();
    const fresh = new Date("2026-11-08T11:30:00Z").toISOString();
    writeFileSync(path.join(dir, fileNameFor(old)), JSON.stringify(rec(old)) + "\n");
    writeFileSync(path.join(dir, fileNameFor(fresh)), JSON.stringify(rec(fresh)) + "\n");
    const collector = new FileCollector({ dir, now: () => now });
    collector.close();
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toEqual([fileNameFor(fresh)]);
    expect(collector.stats().retained_from).toBe(fresh);
    const index = rebuildIndex(dir);
    expect(Object.keys(index.files)).toEqual([fileNameFor(fresh)]);
  });

  it("queries newest first with level/time/scope filters and stable (occurred_at, record_id) cursors", () => {
    const dir = tmp();
    const base = Date.parse("2026-11-01T10:00:00Z");
    const records: LogRecord[] = [];
    for (let i = 0; i < 25; i += 1) records.push(rec(new Date(base + i * 1000).toISOString(), i % 5 === 0 ? "ERROR" : i % 3 === 0 ? "DEBUG" : "INFO", { tenant_id: i % 2 === 0 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222", component: i % 4 === 0 ? "worker" : "api", message: `msg-${i}` }));
    // same-second ties
    records.push(rec(new Date(base + 24_000).toISOString(), "INFO", { message: "tie-a" }));
    records.push(rec(new Date(base + 24_000).toISOString(), "INFO", { message: "tie-b" }));
    writeFileSync(path.join(dir, fileNameFor(records[0]!.occurred_at)), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const since = new Date(base - 1000).toISOString();
    const until = new Date(base + 60_000).toISOString();
    const all = queryLogs(dir, { since, until, level_min: "DEBUG", limit: 1000 });
    expect(all.records).toHaveLength(27);
    expect(all.records[0]!.occurred_at >= all.records[26]!.occurred_at).toBe(true);
    const infoPlus = queryLogs(dir, { since, until, limit: 1000 });
    expect(infoPlus.records.every((r) => r.level !== "DEBUG")).toBe(true);
    const errors = queryLogs(dir, { since, until, levels: ["ERROR"], limit: 1000 });
    expect(errors.records).toHaveLength(5);
    const tenantA = queryLogs(dir, { since, until, level_min: "DEBUG", tenant_id: "11111111-1111-4111-8111-111111111111", limit: 1000 });
    expect(tenantA.records.every((r) => !r.tenant_id || r.tenant_id === "11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(tenantA.records.some((r) => r.tenant_id === "22222222-2222-4222-8222-222222222222")).toBe(false);
    const worker = queryLogs(dir, { since, until, level_min: "DEBUG", component: ["worker"], limit: 1000 });
    expect(worker.records.every((r) => r.component === "worker")).toBe(true);
    const literal = queryLogs(dir, { since, until, level_min: "DEBUG", q: "MSG-1", limit: 1000 });
    expect(literal.records.length).toBe(11); // msg-1, msg-10..19
    // paginate with cursor: no duplicates, no gaps
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = queryLogs(dir, { since, until, level_min: "DEBUG", limit: 4, cursor });
      for (const r of page.records) {
        expect(seen.has(r.record_id)).toBe(false);
        seen.add(r.record_id);
      }
      cursor = page.page.next_cursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(seen.size).toBe(27);
    expect(decodeCursor(encodeCursor("2026-11-01T10:00:00.000Z", records[0]!.record_id))).toEqual({ occurred_at: "2026-11-01T10:00:00.000Z", record_id: records[0]!.record_id });
    expect(decodeCursor("garbage")).toBeNull();
    expect(() => queryLogs(dir, { cursor: "garbage" })).toThrow(/cursor/);
  });
});
