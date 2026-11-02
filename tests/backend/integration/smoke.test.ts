/**
 * Smoke: harness, setup, login, demo load through the replay ingestion path and journal reads.
 * Covers the persisted slice precondition for QUERY-01 (ingestion through real PostgreSQL) and the
 * demo route contract (idempotent, labeled demo connections).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, startTestApp, type TestApp } from "@blackbox/testing";

let app: TestApp;
let owner: { key: string; tenant_id: string };
const client = () => new ApiClient(app.baseUrl);

beforeAll(async () => {
  app = await startTestApp();
  owner = await app.setupOwner();
});
afterAll(async () => {
  await app?.stop();
});

describe("smoke", () => {
  it("health is unauthenticated and content-free", async () => {
    const r = await client().get("/api/health");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: "ok", version: "test" });
  });

  it("loads the golden scenario idempotently and exposes it through the journal", async () => {
    const c = client();
    await c.login(owner.key);
    const demo = await c.post("/api/demo/run", {});
    expect(demo.status, demo.text).toBe(200);
    const d = demo.json as { accepted: number; duplicate: number; rejected: number; committed_cursor: number; connections: Record<string, string> };
    expect(d.accepted).toBe(19);
    expect(d.rejected).toBe(0);
    expect(Object.keys(d.connections).sort()).toEqual(["bank_csv", "carrier", "invoice", "payment", "shop", "stock"]);
    const again = await c.post("/api/demo/run", {});
    expect((again.json as { accepted: number; duplicate: number }).accepted).toBe(0);
    expect((again.json as { duplicate: number }).duplicate).toBe(19);
    const journal = await c.get("/api/journal?limit=500");
    expect(journal.status).toBe(200);
    const j = journal.json as { entries: Array<{ track: string; event_type: string }>; page: { snapshot_cursor: number; truncated: boolean }; consistency: { committed_cursor: number } };
    expect(j.page.snapshot_cursor).toBe(d.committed_cursor);
    expect(j.entries.filter((e) => e.track === "source")).toHaveLength(19);
    const tracks = new Set(j.entries.map((e) => e.track));
    expect([...tracks].sort()).toEqual(["commitment", "fact", "movement", "reservation", "source"]);
    const history = await c.get("/api/entities/order/%231001/history?limit=500");
    expect((history.json as { entries: unknown[] }).entries.length).toBeGreaterThan(19);
    const readiness = await c.get("/api/sources/readiness");
    const r = readiness.json as { datasets_present: string[]; questions: Array<{ intent: string; status: string }> };
    expect(r.datasets_present).toEqual(expect.arrayContaining(["orders", "stock", "payments", "invoices", "bank", "payouts", "refunds", "identity", "coverage"]));
    expect(r.questions.find((q) => q.intent === "invoices.outstanding")!.status).toBe("ready");
    expect(r.questions.find((q) => q.intent === "shipments.attention")!.status).toBe("partial"); // tracking/policy missing
    const question = await c.post("/api/questions/invoices.outstanding", { params: { customer_id: "C-1" } }); // the intent takes customer/currency/due_before/now (engine contract), not invoice_id
    expect(question.status).toBe(200);
    const q = question.json as { status: string; error?: { code: string }; readiness: { status: string } };
    expect(q.status).toBe("unavailable"); // stub engine: projection_behind, never a fabricated number
    expect(q.error?.code).toBe("projection_behind");
    expect(q.readiness.status).toBe("ready");
    const state = await c.get("/api/entities/order/%231001/state");
    expect(state.status).toBe(503);
    expect((state.json as { error: { code: string } }).error.code).toBe("projection_behind");
  });
});
