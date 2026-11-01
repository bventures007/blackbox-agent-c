/**
 * Sources, import plans, producers, readiness and review over the API.
 * Covers: IMPORT-01 (presets persisted with resolved UTC boundaries, timezone, versioned plans,
 * workspace start inherited as proposal, strict from-now restrictions), IMPORT-04/HEALTH-01 (readiness
 * follows datasets present; last successful check ≠ last new event; empty success is current; failed
 * or credential-only checks never claim sync; nullable next check with reason), INGEST-01 (signed
 * generic input: valid, corrupted signature/body, replay, foreign connection), bank CSV preview/commit
 * with ambiguous match review cases, policy ingestion, PILOT-04 (owner-only revision-checked
 * idempotent review actions appending review.decision with provenance; agents read-only),
 * QUERY-01/02 (all 24 intents validate params and reach the engine boundary; without the Rust engine
 * answers are explicitly `unavailable`/projection_behind, never fabricated — positive results need
 * the engine service), HEALTH-02 (pause/resume/disconnect, read-only agent denied import controls).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@blackbox/database";
import { loadQuestionContracts, signProducerBody } from "@blackbox/application";
import { ApiClient, startTestApp, type TestApp } from "@blackbox/testing";

let app: TestApp;
let owner: { key: string; tenant_id: string };
let c: ApiClient;
let demo: { connections: Record<string, string> };

beforeAll(async () => {
  app = await startTestApp();
  owner = await app.setupOwner();
  c = new ApiClient(app.baseUrl);
  await c.login(owner.key);
  demo = (await c.post("/api/demo/run", {})).json as typeof demo;
});
afterAll(async () => {
  await app?.stop();
});

describe("IMPORT-01 import plans", () => {
  it("persists resolved UTC boundaries per preset, versions revisions and proposes the workspace start to later sources", async () => {
    const conn = ((await c.post("/api/sources/connections", { provider: "replay", display_name: "Plan source" })).json as { connection: { connection_id: string } }).connection.connection_id;
    const p1 = await c.post(`/api/sources/connections/${conn}/import-plan`, { preset: "this_year", timezone: "Europe/Berlin", include_open_context: true });
    expect(p1.status).toBe(201);
    const plan1 = p1.json as { plan_revision: number; requested_from: string; initial_cutoff: string; timezone: string; local_from_label: string; strict_from_now: boolean };
    expect(plan1.plan_revision).toBe(1);
    expect(plan1.requested_from).toMatch(/^\d{4}-12-31T23:00:00\.000Z$/);
    expect(plan1.local_from_label).toMatch(/-01-01 00:00 .*Europe\/Berlin/);
    const p2 = (await c.post(`/api/sources/connections/${conn}/import-plan`, { preset: "custom", from: "2026-03-29", timezone: "Europe/Berlin", include_open_context: false })).json as { plan_revision: number; requested_from: string };
    expect(p2.plan_revision).toBe(2);
    expect(p2.requested_from).toBe("2026-03-28T23:00:00.000Z");
    const detail = (await c.get(`/api/sources/connections/${conn}`)).json as { import_plan: { plan_revision: number }; import_plan_proposal: { history_start: string; timezone: string } };
    expect(detail.import_plan.plan_revision).toBe(2);
    expect(detail.import_plan_proposal.history_start).toBe(plan1.requested_from); // first saved start is kept
    const invalid = await c.post(`/api/sources/connections/${conn}/import-plan`, { preset: "custom", from: "2027-05-01", timezone: "Europe/Berlin", include_open_context: true });
    expect(invalid.status).toBe(422);
    const fromNow = (await c.post(`/api/sources/connections/${conn}/import-plan`, { preset: "from_now", timezone: "UTC", include_open_context: false })).json as { strict_from_now: boolean; requested_from: null; restrictions: string[] };
    expect(fromNow.strict_from_now).toBe(true);
    expect(fromNow.requested_from).toBeNull();
    expect(fromNow.restrictions.join(" ")).toMatch(/opening_state_declined/);
    const revisions = await withTenant(app.pool, owner.tenant_id, async (cl) => (await cl.query("SELECT plan_revision, superseded_at FROM import_plans WHERE connection_id = $1 ORDER BY plan_revision", [conn])).rows);
    expect(revisions.map((r) => [r.plan_revision, r.superseded_at === null])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect((await c.post(`/api/sources/connections/00000000-0000-4000-8000-000000000000/import-plan`, { preset: "last_30_days", timezone: "UTC", include_open_context: true })).status).toBe(404);
  });
});

describe("HEALTH-01 / IMPORT-04 source health and readiness", () => {
  it("keeps last successful check and last new event distinct; failures and credential checks never claim sync", async () => {
    const svc = app.built.ctx.connections!;
    const conn = ((await c.post("/api/sources/connections", { provider: "generic", display_name: "Quiet source" })).json as { connection: { connection_id: string } }).connection.connection_id;
    await svc.recordCheck(owner.tenant_id, conn, "orders", { outcome: "success_empty", schedule_seconds: 900, coverage: { from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z", state: "complete_for_declared_scope", history_kind: "event_history" } });
    let h = (await c.get(`/api/sources/connections/${conn}`)).json as { health: Array<Record<string, unknown>> };
    let orders = h.health.find((x) => x.capability_id === "orders")!;
    expect(orders.last_successful_check_at).toBeTruthy();
    expect(orders.last_new_event_at).toBeNull();
    expect(orders.next_check_at).toBeTruthy();
    expect(orders.status).toBe("healthy");
    const firstOk = orders.last_successful_check_at;
    await new Promise((r) => setTimeout(r, 20));
    await svc.recordCheck(owner.tenant_id, conn, "orders", { outcome: "failed", error_code: "rate_limited", schedule_seconds: 900 });
    h = (await c.get(`/api/sources/connections/${conn}`)).json as typeof h;
    orders = h.health.find((x) => x.capability_id === "orders")!;
    expect(orders.status).toBe("degraded");
    expect(orders.last_successful_check_at).toBe(firstOk); // failure cannot advance the successful check
    expect(orders.failed_count).toBe(1);
    await svc.recordCheck(owner.tenant_id, conn, "orders", { outcome: "credential_only", schedule_seconds: null });
    h = (await c.get(`/api/sources/connections/${conn}`)).json as typeof h;
    orders = h.health.find((x) => x.capability_id === "orders")!;
    expect(orders.last_successful_check_at).toBe(firstOk);
    expect(orders.next_check_at).toBeNull();
    expect(orders.next_check_reason).toMatch(/producer_driven/);
    await svc.recordCheck(owner.tenant_id, conn, "orders", { outcome: "success_new", schedule_seconds: 900 });
    h = (await c.get(`/api/sources/connections/${conn}`)).json as typeof h;
    orders = h.health.find((x) => x.capability_id === "orders")!;
    expect(orders.last_new_event_at).toBeTruthy();
    expect(orders.last_successful_check_at).not.toBe(firstOk);
    const catalogue = (await c.get("/api/sources")).json as { catalogue: Array<{ provider: string; state: string; capabilities: Array<{ id: string; last_successful_check_at: string | null; last_new_event_at: string | null }> }> };
    const generic = catalogue.catalogue.find((p) => p.provider === "generic")!;
    expect(["configured", "syncing", "degraded"]).toContain(generic.state);
    expect(catalogue.catalogue.find((p) => p.provider === "shopify")!.state).toBe("configured"); // demo connection exists
    expect(catalogue.catalogue.find((p) => p.provider === "easybill")!.state).toBe("planned");
  });

  it("readiness follows the datasets actually present, not source cards; unrelated sources never block", async () => {
    const readiness = (await c.get("/api/sources/readiness")).json as { datasets_present: string[]; datasets_missing: string[]; questions: Array<{ question_id: string; intent: string; status: string; missing: string[]; sources: Array<{ provider: string }> }> };
    const contracts = loadQuestionContracts();
    expect(readiness.questions).toHaveLength(24);
    for (const q of readiness.questions) {
      const contract = contracts.questions.find((x) => x.intent === q.intent)!;
      const expectedMissing = contract.required_datasets.filter((d) => !readiness.datasets_present.includes(d));
      expect(q.missing, q.intent).toEqual(expectedMissing);
      expect(q.status).toBe(expectedMissing.length === 0 ? "ready" : contract.required_datasets.some((d) => readiness.datasets_present.includes(d) && d !== "coverage" && d !== "identity") ? "partial" : "blocked");
    }
    expect(readiness.questions.find((q) => q.intent === "orders.payment_state")!.status).toBe("ready");
    expect(readiness.questions.find((q) => q.intent === "payouts.missing_bank_confirmation")!.status).toBe("ready");
    expect(readiness.questions.find((q) => q.intent === "refunds.chargeback_overlap")!.missing).toEqual(["disputes"]);
    // A disconnected source stops contributing health rows
    const disconnected = await c.post(`/api/sources/connections/${demo.connections.carrier}/disconnect`);
    expect(disconnected.status).toBe(200);
    const after = (await c.get("/api/sources/readiness")).json as typeof readiness;
    expect(after.questions.find((q) => q.intent === "orders.payment_state")!.sources.every((s) => s.provider !== "carrier")).toBe(true);
    expect((await c.post(`/api/sources/connections/${demo.connections.carrier}/resume`)).status).toBe(404); // disconnected stays disconnected
    expect((await c.post(`/api/sources/connections/${demo.connections.stock}/pause`)).status).toBe(200);
    expect(((await c.post(`/api/sources/connections/${demo.connections.stock}/resume`)).json as { status: string }).status).toBe("configured");
    const agent = new ApiClient(app.baseUrl);
    agent.bearer = ((await c.post("/api/agents", { name: "ro" })).json as { key: string }).key;
    expect((await agent.post(`/api/sources/connections/${demo.connections.stock}/pause`)).status).toBe(403);
    expect((await agent.post(`/api/sources/connections/${demo.connections.stock}/runs`, { kind: "check" })).status).toBe(403);
    expect((await agent.get(`/api/sources/connections/${demo.connections.stock}`)).status).toBe(200);
  });
});

describe("INGEST-01 signed generic input", () => {
  let producer: { producer_id: string; secret: string };
  let conn: string;
  const body = (connectionId: string, id = "gen-1") => JSON.stringify({ connection_id: connectionId, tenant_id: "attacker", records: [{ provider_event_id: id, kind: "payment.captured", occurred_at: "2026-10-31T13:00:00Z", entity: { order: "#G1", transaction: "TX-G1" }, payload: { transaction: "TX-G1", captured_minor: 500, currency: "EUR", tenant_id: "attacker" } }] });
  const send = (raw: string, headers: Record<string, string>) => fetch(`${app.baseUrl}/api/ingest/generic`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
  const sign = (raw: string, ts = String(Math.floor(Date.now() / 1000)), secret = producer.secret) => ({ "x-producer-id": producer.producer_id, "x-producer-timestamp": ts, "x-producer-signature": signProducerBody(secret, ts, raw) });

  it("accepts a valid signature once, rejects corrupted signature/body, replays, stale timestamps and foreign connections", async () => {
    const created = (await c.post("/api/sources/connections", { provider: "generic", display_name: "ERP feed" })).json as { connection: { connection_id: string }; producer: { producer_id: string; secret: string } };
    conn = created.connection.connection_id;
    producer = created.producer;
    expect(producer.secret).toMatch(/^bbp_/);
    const raw = body(conn);
    const headers = sign(raw);
    const ok = await send(raw, headers);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ accepted: 1 });
    const replay = await send(raw, headers);
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe("replayed");
    const badSig = await send(raw, { ...sign(raw), "x-producer-signature": "0".repeat(64) });
    expect(badSig.status).toBe(401);
    const tampered = await send(raw.replace("500", "999"), sign(raw));
    expect(tampered.status).toBe(401);
    const stale = await send(raw, sign(raw, String(Math.floor(Date.now() / 1000) - 400)));
    expect(stale.status).toBe(401);
    const wrongSecret = await send(raw, sign(raw, undefined, "bbp_wrong"));
    expect(wrongSecret.status).toBe(401);
    const missing = await send(raw, {});
    expect(missing.status).toBe(401);
    // Signed by this producer but naming another connection in the body → refused (connection-bound).
    const foreign = body(demo.connections.shop, "gen-2");
    const foreignRes = await send(foreign, sign(foreign));
    expect(foreignRes.status).toBe(403);
    expect(((await foreignRes.json()) as { error: { code: string } }).error.code).toBe("connection_mismatch");
    // The accepted entry landed in the owner tenant on the producer's connection, payload tenant_id stripped.
    const entries = (await c.get("/api/journal?record_id=transaction:TX-G1&track=fact")).json as { entries: Array<{ connection_id: string; payload: Record<string, unknown> }> };
    expect(entries.entries).toHaveLength(1);
    expect(entries.entries[0]!.connection_id).toBe(conn);
    expect(JSON.stringify(entries.entries[0]!.payload)).not.toContain("attacker");
    expect(((await c.get("/api/sources/readiness")).json as { datasets_present: string[] }).datasets_present).toContain("payments");
  });
});

describe("bank CSV and policy producers", () => {
  it("previews rows with match detection, commits credits with payout links, dedupes re-imports and opens ambiguous-match cases", async () => {
    // OUT-1001 is already confirmed by G19 in the demo; use a fresh unconfirmed payout.
    await c.post("/api/ingest/replay", { connection_id: demo.connections.payment, events: [{ provider_event_id: "po-OUT-2001", kind: "payout.sent", occurred_at: "2026-10-31T14:00:00Z", entity: { payout: "OUT-2001" }, payload: { payout: "OUT-2001", amount_minor: 5000, currency: "EUR" } }] });
    const csv = ["date;amount;currency;reference;counterparty;booking_text", "2026-10-31;50,00;EUR;Payout OUT-2001;Shop Payments Ltd;Settlement", "2026-10-31;-3,00;EUR;FEE;Bank;Account fee", "2026-10-31;12,34;EUR;unknown ref;Someone;Transfer"].join("\n");
    const preview = (await c.post("/api/ingest/bank-csv?preview=1", { connection_id: demo.connections.bank_csv, csv })).json as { rows: number; parsed: Array<{ kind: string; match: { status: string; payout?: string } }>; errors: unknown[] };
    expect(preview.rows).toBe(3);
    expect(preview.parsed[0]!.match).toMatchObject({ status: "matched", payout: "OUT-2001", basis: "reference" });
    expect(preview.parsed[1]!.kind).toBe("bank.debit_booked");
    expect(preview.parsed[2]!.match.status).toBe("unmatched");
    const before = (await c.get("/api/journal?event_type=movement.bank_credit&track=movement")).json as { entries: unknown[] };
    const commit = (await c.post("/api/ingest/bank-csv", { connection_id: demo.connections.bank_csv, csv })).json as { accepted: number; duplicate: number; ambiguous: number };
    expect(commit).toMatchObject({ accepted: 4, duplicate: 0, ambiguous: 0 }); // 3 rows + 1 match assertion
    const again = (await c.post("/api/ingest/bank-csv", { connection_id: demo.connections.bank_csv, csv })).json as { accepted: number; duplicate: number; conflict: number };
    expect(again).toMatchObject({ accepted: 0, duplicate: 3, conflict: 0 }); // rows are pure content: re-import is a no-op; the match is now known, no new assertion
    const matches = (await c.get("/api/entities/payout/OUT-2001/history")).json as { entries: Array<{ event_type: string; track: string }> };
    expect(matches.entries.some((e) => e.event_type === "bank.match_recorded" && e.track === "fact")).toBe(true);
    const after = (await c.get("/api/journal?event_type=movement.bank_credit&track=movement")).json as { entries: Array<{ payload: Record<string, unknown> }> };
    expect(after.entries.length).toBe(before.entries.length + 2);
    expect(JSON.stringify(after.entries)).not.toContain("Shop Payments Ltd");
    // Ambiguity: two unmatched payouts with the same amount → review case, no link asserted.
    await c.post("/api/ingest/replay", {
      connection_id: demo.connections.payment,
      events: ["OUT-A", "OUT-B"].map((p) => ({ provider_event_id: `po-${p}`, kind: "payout.sent", occurred_at: "2026-10-31T14:00:00Z", entity: { payout: p }, payload: { payout: p, amount_minor: 4242, currency: "EUR" } })),
    });
    const amb = (await c.post("/api/ingest/bank-csv", { connection_id: demo.connections.bank_csv, csv: "date;amount;currency;reference;counterparty;booking_text\n2026-11-01;42,42;EUR;payout;X;Y\n" })).json as { ambiguous: number; accepted: number };
    expect(amb).toMatchObject({ ambiguous: 1, accepted: 1 });
    const cases = (await c.get("/api/review/cases?state=open")).json as { cases: Array<{ type: string; refs: { candidates: string[] } }> };
    const ambCase = cases.cases.find((x) => x.type === "ambiguous_bank_match")!;
    expect(ambCase.refs.candidates.sort()).toEqual(["OUT-A", "OUT-B"]);
    expect((await c.post("/api/ingest/bank-csv", { connection_id: demo.connections.shop, csv })).status).toBe(422);
    const bad = (await c.post("/api/ingest/bank-csv?preview=1", { connection_id: demo.connections.bank_csv, csv: "nope\n" })).json as { errors: Array<{ message: string }> };
    expect(bad.errors[0]!.message).toMatch(/missing column/);
  });

  it("records versioned policy rules as facts", async () => {
    const conn = ((await c.post("/api/sources/connections", { provider: "policy", display_name: "Workspace rules" })).json as { connection: { connection_id: string } }).connection.connection_id;
    const v1 = (await c.post("/api/ingest/policy", { connection_id: conn, policy: { version: 1, rules: [{ id: "overdue_days", value: 14 }] } })).json as { accepted: number };
    expect(v1.accepted).toBe(1);
    const v2 = (await c.post("/api/ingest/policy", { connection_id: conn, policy: { version: 2, rules: [{ id: "overdue_days", value: 7 }] } })).json as { accepted: number };
    expect(v2.accepted).toBe(1);
    const history = (await c.get("/api/entities/rule/policy-v2/history")).json as { entries: Array<{ track: string; input_entry_ids: string[] }> };
    expect(history.entries.find((e) => e.track === "source")!.input_entry_ids).toHaveLength(1); // links to v1 observation
    expect(((await c.get("/api/sources/readiness")).json as { datasets_present: string[] }).datasets_present).toContain("policy");
  });
});

describe("PILOT-04 review workflow", () => {
  it("applies owner-only, revision-checked, idempotent actions that append review.decision entries with provenance", async () => {
    // Create a conflict case through the ingestion boundary.
    const o = { provider_event_id: "fixture-06", kind: "payment.captured", occurred_at: "2026-10-31T09:06:00Z", entity: { order: "#1001", transaction: "TX-1001" }, payload: { transaction: "TX-1001", captured_minor: 11901, currency: "EUR" } };
    const r = (await c.post("/api/ingest/replay", { connection_id: demo.connections.payment, events: [o] })).json as { conflict: number; outcomes: Array<{ case_id: string }> };
    expect(r.conflict).toBe(1);
    const caseId = r.outcomes[0]!.case_id;
    const agent = new ApiClient(app.baseUrl);
    agent.bearer = ((await c.post("/api/agents", { name: "reviewer-ro" })).json as { key: string }).key;
    const visible = (await agent.get(`/api/review/cases/${caseId}`)).json as { state: string; revision: number };
    expect(visible.state).toBe("open");
    expect((await agent.post(`/api/review/cases/${caseId}/actions`, { action: "confirm_link", revision: 1, reason: "agent tries" })).status).toBe(403);
    const stale = await c.post(`/api/review/cases/${caseId}/actions`, { action: "leave_open", revision: 99, reason: "stale click" });
    expect(stale.status).toBe(409);
    const left = (await c.post(`/api/review/cases/${caseId}/actions`, { action: "leave_open", revision: 1, reason: "needs provider confirmation" })).json as { revision: number; state: string };
    expect(left).toMatchObject({ revision: 2, state: "open" });
    // Competing/repeated clicks from the same revision: first wins, repeat is idempotent (no double apply).
    const [a, b] = await Promise.all([
      c.post(`/api/review/cases/${caseId}/actions`, { action: "append_correction", revision: 2, reason: "Provider confirmed 11900 on the phone", payload: { correction: { captured_minor: 11900 } } }),
      c.post(`/api/review/cases/${caseId}/actions`, { action: "append_correction", revision: 2, reason: "Provider confirmed 11900 on the phone", payload: { correction: { captured_minor: 11900 } } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    const resolved = (await c.get(`/api/review/cases/${caseId}`)).json as { state: string; revision: number; resolution_entry_id: string; history: unknown[] };
    expect(resolved.state).toBe("resolved");
    expect(resolved.revision).toBe(3);
    const decisions = (await c.get("/api/journal?event_type=review.decision&track=fact")).json as { entries: Array<{ payload: Record<string, unknown>; supersedes_entry_id: string | null; input_entry_ids: string[]; correlation_id: string }> };
    expect(decisions.entries).toHaveLength(1);
    expect(decisions.entries[0]!.payload).toMatchObject({ decision: "append_correction", provenance: "human_confirmed", actor_kind: "owner", correction: { captured_minor: 11900 } });
    expect(decisions.entries[0]!.supersedes_entry_id).toBeTruthy();
    expect(decisions.entries[0]!.correlation_id).toBe(caseId);
    const original = (await c.get(`/api/journal/${decisions.entries[0]!.supersedes_entry_id}`)).json as { entry: { payload: { observation: { captured_minor: number } } }; superseded_by: unknown[] };
    expect(original.entry.payload.observation.captured_minor).toBe(11900); // untouched
    expect(original.superseded_by).toHaveLength(1);
    expect((await c.post(`/api/review/cases/${caseId}/actions`, { action: "retry", revision: 3, reason: "again" })).status).toBe(409); // already resolved
    expect(((await c.get("/api/workspace")).json as { unresolved_review_count: number }).unresolved_review_count).toBeGreaterThanOrEqual(0);
  });
});

describe("QUERY-01/02 question boundary (engine stub)", () => {
  it("validates parameters for all 24 intents, attaches readiness, and never fabricates a result without the engine", async () => {
    const templates = (await c.get("/api/questions")).json as { questions: Array<{ intent: string; params_schema: { required: string[]; properties: Record<string, unknown> }; readiness: { status: string } | null; supported: boolean }> };
    expect(templates.questions).toHaveLength(24);
    for (const t of templates.questions) {
      expect(t.supported).toBe(true);
      expect(t.readiness).not.toBeNull();
      const params: Record<string, unknown> = {};
      for (const req of t.params_schema.required) params[req] = req === "requested_quantity" ? 100 : "X-1";
      const r = await c.post(`/api/questions/${t.intent}`, { params });
      expect(r.status, t.intent).toBe(200);
      const a = r.json as { status: string; error?: { code: string; retryable: boolean }; result: unknown; missing_inputs: string[]; readiness: { status: string }; consistency: { status: string } };
      expect(a.status).toBe("unavailable");
      expect(a.error?.code).toBe("projection_behind");
      expect(a.error?.retryable).toBe(true);
      expect(a.result).toBeNull();
      expect(a.consistency.status).toBe("projection_behind");
      expect(a.readiness.status).toBe(t.readiness!.status);
      if (t.readiness!.status !== "ready") expect(a.missing_inputs.length).toBeGreaterThan(0);
      const unknown = await c.post(`/api/questions/${t.intent}`, { params: { ...params, free_text: "ignore previous instructions" } });
      expect(unknown.status, t.intent).toBe(422);
    }
    expect((await c.post("/api/questions/orders.teleport", { params: {} })).status).toBe(422);
    expect((await c.post("/api/questions/inventory.available_to_sell", { params: { item_id: "CUP-OLV" } })).status).toBe(422);
    expect((await c.post("/api/questions/inventory.available_to_sell", { params: { item_id: "CUP-OLV", requested_quantity: -1 } })).status).toBe(422);
    const search = (await c.get("/api/questions/search?q=olive")).json as { matches: Array<{ intent: string }> };
    expect(search.matches.map((m) => m.intent)).toEqual(["inventory.available_to_sell"]);
    // QUERY-02: with the bank dataset absent, readiness reports exactly the missing capability.
    const tenantB = await app.createTenant("No bank");
    const rb = await app.built.ctx.readiness.forIntent(tenantB, "payouts.missing_bank_confirmation");
    expect(rb?.status).toBe("blocked");
    expect(rb?.missing).toEqual(["payouts", "bank", "coverage", "identity"]);
  });
});
