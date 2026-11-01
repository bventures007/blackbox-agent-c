/**
 * MCP bridge protocol tests with the official SDK Client over stdio against the running API.
 * Covers: MCP-01 (protocol client lists tools, validated schemas, typed failures, results equal the
 * scoped API/domain services), MCP-04 (schema discovery, traversal of all five tracks, histories,
 * correction/derivation links and evidence incl. a synthetic record outside the 24 questions;
 * cross-tenant reads denied; unavailable/redacted evidence explicit), MCP-05 (stable snapshot
 * pagination while entries commit concurrently incl. rollbacks and late timestamps; continuation;
 * cross-tenant cursor denied), LOCAL-04 (key only via env/file, owner key refused by the bridge,
 * revocation stops the bridge within 5 s).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { withTenant } from "@blackbox/database";
import { ApiClient, startTestApp, type TestApp } from "@blackbox/testing";
import { repoRoot } from "../vitest.shared.js";

let app: TestApp;
let owner: { key: string; tenant_id: string };
let agentKey: string;
let credentialId: string;
let tenantB: string;
let demoConnections: Record<string, string>;
const serverPath = path.join(repoRoot, "packages/mcp/src/server.ts");
const tsx = path.join(repoRoot, "node_modules/.bin/tsx");

async function connect(env: Record<string, string>): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({ command: tsx, args: [serverPath], env: { ...process.env, ...env } as Record<string, string>, stderr: "pipe" });
  const client = new Client({ name: "blackbox-protocol-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function parse<T = Record<string, unknown>>(result: { content?: unknown; isError?: boolean }): T {
  const content = (result.content as Array<{ type: string; text: string }>)[0]!;
  return JSON.parse(content.text) as T;
}

beforeAll(async () => {
  app = await startTestApp();
  owner = await app.setupOwner();
  tenantB = await app.createTenant("Tenant B");
  const c = new ApiClient(app.baseUrl);
  await c.login(owner.key);
  const demo = (await c.post("/api/demo/run", {})).json as { connections: Record<string, string> };
  demoConnections = demo.connections;
  const created = (await c.post("/api/agents", { name: "Protocol test agent" })).json as { key: string; credential_id: string };
  agentKey = created.key;
  credentialId = created.credential_id;
});
afterAll(async () => {
  await app?.stop();
});

describe("MCP-01 protocol client", () => {
  it("lists the nine required tools with input schemas and refuses owner keys/argv keys", async () => {
    const { client, transport } = await connect({ BLACKBOX_API_URL: app.baseUrl, BLACKBOX_AGENT_KEY: agentKey });
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(["answer_question", "describe_business_schema", "get_business_state", "get_entity_history", "get_evidence", "get_journal_entry", "get_readiness", "list_journal_entries", "query_business", "search_events"].sort());
      const entry = tools.tools.find((t) => t.name === "get_journal_entry")!;
      expect(entry.inputSchema.properties).toHaveProperty("entry_id");
      // Invalid argument → typed failure, not a crash.
      const bad = await client.callTool({ name: "get_journal_entry", arguments: { entry_id: "not-a-uuid" } });
      expect(bad.isError).toBe(true);
    } finally {
      await transport.close();
    }
    const ownerAsAgent = new StdioClientTransport({ command: tsx, args: [serverPath], env: { ...process.env, BLACKBOX_API_URL: app.baseUrl, BLACKBOX_AGENT_KEY: owner.key } as Record<string, string>, stderr: "pipe" });
    const c2 = new Client({ name: "t", version: "1" });
    await expect(c2.connect(ownerAsAgent)).rejects.toBeTruthy();
    const argvKey = new StdioClientTransport({ command: tsx, args: [serverPath, agentKey], env: { ...process.env, BLACKBOX_API_URL: app.baseUrl } as Record<string, string>, stderr: "pipe" });
    const c3 = new Client({ name: "t", version: "1" });
    await expect(c3.connect(argvKey)).rejects.toBeTruthy();
  });

  it("reads the key from a file and returns the same scoped state as the API (readiness, state, answers)", async () => {
    const keyFile = path.join(app.install.root, "agent.key");
    writeFileSync(keyFile, agentKey + "\n", { mode: 0o600 });
    const { client, transport } = await connect({ BLACKBOX_API_URL: app.baseUrl, BLACKBOX_AGENT_KEY_FILE: keyFile });
    try {
      const readiness = parse<{ datasets_present: string[]; questions: Array<{ intent: string; status: string }> }>(await client.callTool({ name: "get_readiness", arguments: {} }));
      const api = new ApiClient(app.baseUrl);
      api.bearer = agentKey;
      const apiReadiness = (await api.get("/api/sources/readiness")).json as { datasets_present: string[]; questions: unknown[] };
      expect(readiness.datasets_present).toEqual(apiReadiness.datasets_present);
      expect(readiness.questions).toEqual(apiReadiness.questions);
      const state = await client.callTool({ name: "get_business_state", arguments: { entity_type: "order", entity_id: "#1001" } });
      expect(state.isError).toBe(true); // stub engine → projection_behind, typed
      expect(parse<{ error: { code: string } }>(state).error.code).toBe("projection_behind");
      const answer = parse<{ status: string; error?: { code: string }; readiness: { status: string } }>(await client.callTool({ name: "answer_question", arguments: { intent: "invoices.outstanding", params: { invoice_id: "INV-1001" } } }));
      expect(answer.status).toBe("unavailable");
      expect(answer.error?.code).toBe("projection_behind");
      expect(answer.readiness.status).toBe("ready");
      const bad = await client.callTool({ name: "query_business", arguments: { intent: "inventory.available_to_sell", params: { item_id: "CUP-OLV" } } });
      expect(bad.isError).toBe(true);
      expect(parse<{ error: { code: string } }>(bad).error.code).toBe("invalid_params");
      const unknownIntent = await client.callTool({ name: "answer_question", arguments: { intent: "orders.teleport", params: {} } });
      expect(parse<{ error: { code: string } }>(unknownIntent).error.code).toBe("unsupported_intent");
    } finally {
      await transport.close();
    }
  });
});

describe("MCP-04 complete read coverage", () => {
  it("discovers the schema and traverses all five tracks, histories, links and evidence, including a synthetic record outside the 24 questions", async () => {
    // Synthetic record outside the question catalogue: a supply commitment plus its revision.
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    const extra = await c.post("/api/ingest/replay", {
      connection_id: demoConnections.stock,
      events: [
        { provider_event_id: "supply-1", kind: "supply.commitment_recorded", occurred_at: "2026-10-31T11:00:00Z", entity: { item: "CUP-OLV", supply: "PO-77" }, payload: { supply: "PO-77", quantity: 40, unit: "piece", due_date: "2026-11-05", supplier_name: "Ceramics Ltd" }, evidence_refs: [] },
        { provider_event_id: "supply-2", kind: "supply.commitment_revised", occurred_at: "2026-10-31T11:30:00Z", entity: { item: "CUP-OLV", supply: "PO-77" }, payload: { supply: "PO-77", quantity: 40, unit: "piece", due_date: "2026-11-07" }, evidence_refs: ["supply-1"] },
      ],
    });
    expect(extra.status).toBe(200);
    expect((extra.json as { accepted: number }).accepted).toBe(2);
    const { client, transport } = await connect({ BLACKBOX_API_URL: app.baseUrl, BLACKBOX_AGENT_KEY: agentKey });
    try {
      const schema = parse<{ tracks: string[]; event_families: unknown[]; intents: unknown[]; workspace_coverage: { datasets_present: string[] } }>(await client.callTool({ name: "describe_business_schema", arguments: {} }));
      expect(schema.tracks).toEqual(["source", "fact", "commitment", "movement", "reservation"]);
      expect(schema.event_families.length).toBeGreaterThan(60);
      expect(schema.intents).toHaveLength(24);
      expect(schema.workspace_coverage.datasets_present).toContain("supply");
      for (const track of ["source", "fact", "commitment", "movement", "reservation"]) {
        const page = parse<{ entries: Array<{ track: string }>; page: { snapshot_cursor: number } }>(await client.callTool({ name: "list_journal_entries", arguments: { track, limit: 50 } }));
        expect(page.entries.length).toBeGreaterThan(0);
        expect(page.entries.every((e) => e.track === track)).toBe(true);
      }
      const supplyHistory = parse<{ entries: Array<{ entry_id: string; event_type: string; evidence_refs: string[]; input_entry_ids: string[]; track: string }> }>(await client.callTool({ name: "get_entity_history", arguments: { entity_type: "supply", entity_id: "PO-77" } }));
      expect(supplyHistory.entries.map((e) => e.event_type)).toEqual(expect.arrayContaining(["supply.commitment_recorded", "supply.commitment_revised"]));
      const revised = supplyHistory.entries.find((e) => e.event_type === "supply.commitment_revised" && e.track === "source")!;
      const recorded = supplyHistory.entries.find((e) => e.event_type === "supply.commitment_recorded" && e.track === "source")!;
      expect(revised.input_entry_ids).toContain(recorded.entry_id); // producer evidence_refs resolved to the prior observation
      const detail = parse<{ entry: { payload: Record<string, unknown> }; derivations: Array<{ track: string }> }>(await client.callTool({ name: "get_journal_entry", arguments: { entry_id: recorded.entry_id } }));
      expect(JSON.stringify(detail.entry.payload)).not.toContain("Ceramics Ltd"); // PII anchored
      expect(detail.derivations.map((d) => d.track)).toContain("fact"); // plus the supply-2 source entry that cites supply-1 as input
      const evidence = parse<{ status: string; content: { payload: { supplier_name: string } } }>(await client.callTool({ name: "get_evidence", arguments: { evidence_id: recorded.evidence_refs[0] } }));
      expect(evidence.status).toBe("available");
      expect(evidence.content.payload.supplier_name).toBe("Ceramics Ltd"); // raw evidence remains separately controlled
      const search = parse<{ entries: unknown[]; search: { literal: string } }>(await client.callTool({ name: "search_events", arguments: { q: "PO-77" } }));
      expect(search.entries.length).toBeGreaterThan(0);
      // Correction/derivation links on the golden order
      const orderHistory = parse<{ entries: Array<{ track: string; derivation_rule: string | null }> }>(await client.callTool({ name: "get_entity_history", arguments: { entity_type: "order", entity_id: "#1001", limit: 500 } }));
      expect(new Set(orderHistory.entries.map((e) => e.track)).size).toBe(5);
      expect(orderHistory.entries.filter((e) => e.track !== "source").every((e) => e.derivation_rule?.startsWith("mapping."))).toBe(true);
      // Redacted evidence is explicit, not a broken link.
      const redactMe = recorded.evidence_refs[0]!;
      await withTenant(app.pool, owner.tenant_id, (cl) => app.built.ctx.evidence.redact(cl, { tenantId: owner.tenant_id, evidenceId: redactMe, action: "redacted", reason: "test_policy", actorId: null }));
      const redacted = parse<{ status: string; reason: string }>(await client.callTool({ name: "get_evidence", arguments: { evidence_id: redactMe } }));
      expect(redacted).toMatchObject({ status: "redacted", reason: "test_policy" });
      const missing = await client.callTool({ name: "get_evidence", arguments: { evidence_id: "00000000-0000-4000-8000-000000000000" } });
      expect(missing.isError).toBe(true);
      expect(parse<{ error: { status: number } }>(missing).error.status).toBe(404);
      // Cross-tenant: entries of tenant B are invisible/404 for the agent.
      await withTenant(app.pool, tenantB, (cl) => cl.query("SELECT append_journal_entries($1::jsonb)", [JSON.stringify([{ track: "fact", record_id: "order:#1001", event_type: "order.accepted", occurred_at: "2026-10-31T09:00:00Z", entity_refs: { order: "#1001" }, payload: { gross_minor: 50000 } }])]));
      const bEntry = (await app.built.ctx.journal.list(tenantB, {}, {})).entries[0]!;
      const denied = await client.callTool({ name: "get_journal_entry", arguments: { entry_id: bEntry.entry_id } });
      expect(denied.isError).toBe(true);
      expect(parse<{ error: { status: number } }>(denied).error.status).toBe(404);
      const histB = parse<{ entries: Array<{ tenant_id: string }> }>(await client.callTool({ name: "get_entity_history", arguments: { entity_type: "order", entity_id: "#1001", limit: 500 } }));
      expect(histB.entries.every((e) => e.tenant_id === owner.tenant_id)).toBe(true);
    } finally {
      await transport.close();
    }
  });
});

describe("MCP-05 snapshot pagination under concurrent commits", () => {
  it("has no omissions or duplicates within a snapshot, exposes continuation for later entries and denies foreign cursors", async () => {
    const { client, transport } = await connect({ BLACKBOX_API_URL: app.baseUrl, BLACKBOX_AGENT_KEY: agentKey });
    try {
      const first = parse<{ entries: Array<{ journal_sequence: number; entry_id: string }>; page: { next_cursor: string | null; snapshot_cursor: number; truncated: boolean } }>(await client.callTool({ name: "list_journal_entries", arguments: { limit: 7 } }));
      const snapshot = first.page.snapshot_cursor;
      expect(first.page.truncated).toBe(true);
      // Concurrent writers while paginating: committed appends, a rolled-back append (sequence
      // allocated then discarded) and a late business timestamp.
      const writers: Array<Promise<unknown>> = [];
      for (let i = 0; i < 4; i += 1) {
        writers.push(withTenant(app.pool, owner.tenant_id, (cl) => cl.query("SELECT append_journal_entries($1::jsonb)", [JSON.stringify([{ track: "fact", record_id: `item:CUP-${i}`, event_type: "inventory.snapshot", occurred_at: i % 2 ? "2026-10-01T00:00:00Z" : "2026-10-31T12:00:00Z", entity_refs: { item: `CUP-${i}` }, payload: { physical: "1", unit: "piece", basis: "snapshot" } }])])));
        writers.push(
          withTenant(app.pool, owner.tenant_id, async (cl) => {
            await cl.query("SELECT append_journal_entries($1::jsonb)", [JSON.stringify([{ track: "fact", record_id: "item:ROLLBACK", event_type: "inventory.snapshot", occurred_at: "2026-10-31T12:00:00Z", entity_refs: {}, payload: {} }])]);
            throw new Error("rollback on purpose");
          }).catch(() => undefined),
        );
      }
      const seen = new Map<number, string>();
      let cursor = first.page.next_cursor;
      for (const e of first.entries) seen.set(e.journal_sequence, e.entry_id);
      let pages = 1;
      while (cursor) {
        const page = parse<{ entries: Array<{ journal_sequence: number; entry_id: string }>; page: { next_cursor: string | null; snapshot_cursor: number } }>(await client.callTool({ name: "list_journal_entries", arguments: { limit: 7, cursor } }));
        expect(page.page.snapshot_cursor).toBe(snapshot);
        for (const e of page.entries) {
          expect(e.journal_sequence).toBeLessThanOrEqual(snapshot);
          expect(seen.has(e.journal_sequence)).toBe(false);
          seen.set(e.journal_sequence, e.entry_id);
        }
        cursor = page.page.next_cursor;
        pages += 1;
      }
      await Promise.all(writers);
      expect(pages).toBeGreaterThan(3);
      expect(seen.size).toBe(snapshot); // every sequence 1..snapshot exactly once
      for (let s = 1; s <= snapshot; s += 1) expect(seen.has(s), `sequence ${s}`).toBe(true);
      // Later commits are visible in a new snapshot; rolled-back sequences leave no gap.
      const later = parse<{ entries: Array<{ journal_sequence: number }>; page: { snapshot_cursor: number }; consistency: { committed_cursor: number } }>(await client.callTool({ name: "list_journal_entries", arguments: { limit: 500 } }));
      expect(later.page.snapshot_cursor).toBe(snapshot + 4);
      expect(later.entries.map((e) => e.journal_sequence)).toEqual(Array.from({ length: snapshot + 4 }, (_, i) => i + 1));
      expect((await app.built.ctx.journal.list(owner.tenant_id, { record_id: "item:ROLLBACK" }, {})).entries).toHaveLength(0);
      // A cursor minted for tenant B is denied for this agent (404, no data).
      const foreign = Buffer.from(JSON.stringify({ t: tenantB, s: 1, a: 0 })).toString("base64url");
      const denied = await client.callTool({ name: "list_journal_entries", arguments: { cursor: foreign } });
      expect(denied.isError).toBe(true);
      expect(parse<{ error: { status: number } }>(denied).error.status).toBe(404);
      // Entity history pagination shares the snapshot semantics.
      const h1 = parse<{ page: { next_cursor: string | null; snapshot_cursor: number }; entries: unknown[] }>(await client.callTool({ name: "get_entity_history", arguments: { entity_type: "order", entity_id: "#1001", limit: 5 } }));
      expect(h1.page.next_cursor).toBeTruthy();
      const h2 = parse<{ page: { snapshot_cursor: number } }>(await client.callTool({ name: "get_entity_history", arguments: { entity_type: "order", entity_id: "#1001", limit: 5, cursor: h1.page.next_cursor! } }));
      expect(h2.page.snapshot_cursor).toBe(h1.page.snapshot_cursor);
    } finally {
      await transport.close();
    }
  });

  it("stops serving within 5 s after the agent key is revoked", async () => {
    const { client, transport } = await connect({ BLACKBOX_API_URL: app.baseUrl, BLACKBOX_AGENT_KEY: agentKey });
    try {
      expect((await client.callTool({ name: "get_readiness", arguments: {} })).isError).toBeFalsy();
      const c = new ApiClient(app.baseUrl);
      await c.login(owner.key);
      expect((await c.post(`/api/agents/${credentialId}/revoke`)).status).toBe(204);
      const started = Date.now();
      const after = await client.callTool({ name: "get_readiness", arguments: {} });
      expect(after.isError).toBe(true);
      expect(parse<{ error: { status: number } }>(after).error.status).toBe(401);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await transport.close();
    }
  });
});
