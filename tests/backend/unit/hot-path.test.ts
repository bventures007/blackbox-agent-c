/**
 * Unit tests for the PILOT-09 hot-path changes (ADR-0009): the readiness memo is time-bounded and opens no
 * transaction on a hit (concurrent misses share one computation); the engine client sends the verified principal
 * as `X-Principal-Id` only (never in the body) so the engine's per-agent admission applies; API_PG_POOL parsing.
 */
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { HttpEngineClient, READINESS_MEMO_MS, ReadinessService } from "@blackbox/application";
import { createLogger } from "@blackbox/logging";
import { loadConfig } from "../../../apps/api/src/config.js";

function fakePool() {
  const counters = { connects: 0, queries: [] as string[], cursor: 0 };
  const client = {
    async query(sql: string) {
      counters.queries.push(sql);
      if (/tenant_sequences/.test(sql)) return { rows: [{ last_sequence: String(counters.cursor) }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { async connect() { counters.connects += 1; return client; } };
  return { pool: pool as unknown as import("@blackbox/database").Pool, counters };
}

describe("readiness memo (hot path)", () => {
  const tenant = "11111111-1111-4111-8111-111111111111";
  it("serves a memo at or beyond the known cursor without any database work, recomputes behind it, shares concurrent misses", async () => {
    const { pool, counters } = fakePool();
    counters.cursor = 100;
    const svc = new ReadinessService(pool);
    const [a, b, c] = await Promise.all([svc.compute(tenant, { knownCursor: 90 }), svc.compute(tenant, { knownCursor: 90 }), svc.compute(tenant)]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(counters.connects).toBe(1); // one shared computation
    const selects = counters.queries.filter((q) => /^\s*(WITH|SELECT 1 FROM journal_entries|SELECT h\.)/.test(q));
    expect(selects).toHaveLength(3); // event families, entity links, capability health
    // Hits: an answer at cursor 100 or below, or no cursor at all → no connection.
    expect(await svc.compute(tenant, { knownCursor: 100 })).toBe(a);
    expect(await svc.compute(tenant, { knownCursor: 42 })).toBe(a);
    expect(await svc.compute(tenant)).toBe(a);
    expect(counters.connects).toBe(1);
    // A hot answer beyond the memo's cursor recomputes (readiness is never older than the answer's cursor).
    counters.cursor = 101;
    const d = await svc.compute(tenant, { knownCursor: 101 });
    expect(d).not.toBe(a);
    expect(counters.connects).toBe(2);
    // exact: compares the actual committed cursor in one transaction; unchanged cursor → memo, changed → recompute.
    expect(await svc.compute(tenant, { exact: true })).toBe(d);
    expect(counters.connects).toBe(3);
    expect(counters.queries.filter((q) => /tenant_sequences/.test(q))).toHaveLength(3);
    counters.cursor = 102;
    const e = await svc.compute(tenant, { exact: true });
    expect(e).not.toBe(d);
    expect(counters.connects).toBe(4);
    expect(e.datasets_missing.length).toBeGreaterThan(0);
    expect(new Date(e.observed_at).getTime()).toBeLessThanOrEqual(Date.now());
    // A different tenant is a different memo; invalidation forces a recomputation.
    await svc.compute("22222222-2222-4222-8222-222222222222");
    expect(counters.connects).toBe(5);
    svc.invalidate(tenant);
    await svc.compute(tenant);
    expect(counters.connects).toBe(6);
    expect(READINESS_MEMO_MS).toBe(5000);
  });
});

describe("engine client principal header", () => {
  it("sends X-Principal-Id for a uuid principal, strips it from the body and omits it otherwise", async () => {
    const seen: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }> = [];
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        seen.push({ headers: req.headers, body: data ? JSON.parse(data) : null });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, consistency: { status: "current" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const client = new HttpEngineClient(`http://127.0.0.1:${port}`, "t0ken", createLogger({ component: "test", serviceVersion: "test", instanceId: "test", level: "ERROR" }));
    try {
      const principal = "9f2a0b1c-3d4e-4f60-8a7b-1c2d3e4f5a6b";
      await client.state({ tenant_id: "11111111-1111-4111-8111-111111111111", entity_type: "order", entity_id: "#1", consistency: { mode: "latest_committed" }, principal_id: principal });
      await client.query({ tenant_id: "11111111-1111-4111-8111-111111111111", intent: "orders.payment_state", params: {}, consistency: { mode: "latest_committed" } });
      await client.state({ tenant_id: "11111111-1111-4111-8111-111111111111", entity_type: "order", entity_id: "#1", consistency: { mode: "latest_committed" }, principal_id: "not a uuid; header injection attempt\r\nx: y" });
    } finally {
      server.close();
    }
    expect(seen).toHaveLength(3);
    expect(seen[0].headers["x-principal-id"]).toBe("9f2a0b1c-3d4e-4f60-8a7b-1c2d3e4f5a6b");
    expect(seen[0].headers["x-engine-token"]).toBe("t0ken");
    expect(seen[0].body).not.toHaveProperty("principal_id");
    expect(seen[0].body).toMatchObject({ entity_id: "#1", consistency: { mode: "latest_committed" } });
    expect(seen[1].headers["x-principal-id"]).toBeUndefined();
    expect(seen[2].headers["x-principal-id"]).toBeUndefined();
    expect(seen[2].body).not.toHaveProperty("principal_id");
  });
});

describe("API_PG_POOL", () => {
  const base = { DATABASE_URL: "postgres://bb_api:x@db:5432/blackbox", SECRETS_DIR: "/tmp/s", EVIDENCE_DIR: "/tmp/e", LOGS_DIR: "/tmp/l", ENGINE_URL: "stub" };
  it("defaults to 16 and rejects values outside 2..64", () => {
    expect(loadConfig({ ...base }).pgPoolMax).toBe(16);
    expect(loadConfig({ ...base, API_PG_POOL: "8" }).pgPoolMax).toBe(8);
    expect(() => loadConfig({ ...base, API_PG_POOL: "1" })).toThrow(/API_PG_POOL/);
    expect(() => loadConfig({ ...base, API_PG_POOL: "65" })).toThrow(/API_PG_POOL/);
  });
});
