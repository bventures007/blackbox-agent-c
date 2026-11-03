/**
 * SEC-02: authorized workspace export over HTTP with two synthetic tenants.
 * Covers: owner-only POST /api/settings/export (session + CSRF; agent key 403; missing CSRF 403;
 * no credential 401), preview without audit row, zip inventory (journal JSON lines, evidence
 * metadata without content and with ledger status for restricted objects, settings/retention),
 * tenant boundary (the second tenant's record ids, entry ids, evidence ids and tenant id never
 * appear in the owner's bundle), byte-cap truncation with continue_from, and the security_audit
 * row `workspace.exported` (actor, categories, counts, bytes) visible in GET /api/settings/security.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { IngestionService, EvidenceStore, loadGoldenFixture, goldenToObservation } from "@blackbox/application";
import { loadDataKey } from "@blackbox/auth";
import { createSilentLogger } from "@blackbox/logging";
import { buildWorkspaceExport } from "@blackbox/api";
import { ApiClient, startTestApp, type TestApp } from "@blackbox/testing";

let app: TestApp;
let owner: { key: string; tenant_id: string; principal_id: string };
let tenantB: string;
let connA: string;
let connB: string;
let ingestion: IngestionService;
let ownerEntryIds: string[] = [];
let bEntryIds: string[] = [];
let bEvidence: string[] = [];
let ownerEvidence: string[] = [];
const golden = loadGoldenFixture();
const obs = (id: string) => goldenToObservation(golden.events.find((e) => e.id === id)!);

/** Binary-safe download with the owner session cookie + CSRF header of an ApiClient. */
function download(c: ApiClient, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }> {
  const u = new URL(`${c.baseUrl}/api/settings/export`);
  const payload = JSON.stringify(body);
  const h: Record<string, string> = { "content-type": "application/json", host: u.host, origin: c.baseUrl, ...(c.cookie ? { cookie: c.cookie } : {}), ...(c.csrf ? { "x-blackbox-csrf": c.csrf } : {}), ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), path: u.pathname, method: "POST", headers: h, setHost: false }, (r) => {
      const chunks: Buffer[] = [];
      r.on("data", (x: Buffer) => chunks.push(x));
      r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const entryIdsOf = (r: { outcomes: unknown[] }) => r.outcomes.flatMap((o) => ((o as { entry_ids?: string[] }).entry_ids ?? []));

beforeAll(async () => {
  app = await startTestApp();
  owner = await app.setupOwner("Studio Nord");
  tenantB = await app.createTenant("Separate test merchant");
  const svc = app.built.ctx.connections!;
  connA = (await svc.create(owner.tenant_id, { provider: "replay", display_name: "A shop" })).connection.connection_id;
  connB = (await svc.create(tenantB, { provider: "replay", display_name: "B shop" })).connection.connection_id;
  ingestion = new IngestionService({ pool: app.pool, logger: createSilentLogger(), evidence: new EvidenceStore(app.install.evidenceDir), dataKey: loadDataKey(app.install.secretsDir) });
  // The same external ids in both tenants (the golden order) — the owner bundle must only carry tenant A's rows.
  const ids = ["G01", "G02", "G03", "G04", "G05"];
  const ra = await ingestion.ingest({ tenantId: owner.tenant_id, connectionId: connA, producer: "replay", observations: ids.map(obs) });
  const rb = await ingestion.ingest({ tenantId: tenantB, connectionId: connB, producer: "replay", observations: ids.map(obs) });
  expect(ra.accepted).toBe(ids.length);
  expect(rb.accepted).toBe(ids.length);
  ownerEntryIds = entryIdsOf(ra);
  bEntryIds = entryIdsOf(rb);
  for (const id of ownerEntryIds) {
    const e = await app.built.ctx.journal.get(owner.tenant_id, id);
    for (const ev of e?.entry.evidence_refs ?? []) if (!ownerEvidence.includes(ev)) ownerEvidence.push(ev);
  }
  for (const id of bEntryIds) {
    const e = await app.built.ctx.journal.get(tenantB, id);
    for (const ev of e?.entry.evidence_refs ?? []) if (!bEvidence.includes(ev)) bEvidence.push(ev);
  }
  expect(ownerEvidence.length).toBeGreaterThan(0);
  expect(bEvidence.length).toBeGreaterThan(0);
});
afterAll(async () => {
  await app?.stop();
});

describe("SEC-02 authorized workspace export", () => {
  it("refuses everything but an owner session with CSRF: anonymous 401, agent key 403, missing CSRF 403, bad body 422", async () => {
    const anon = new ApiClient(app.baseUrl);
    expect((await anon.post("/api/settings/export", { categories: ["journal"] })).status).toBe(401);
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    const created = (await c.post("/api/agents", { name: "export probe" })).json as { key: string };
    const agent = new ApiClient(app.baseUrl);
    agent.bearer = created.key;
    const denied = await agent.post("/api/settings/export", { categories: ["journal", "evidence_metadata", "settings"] });
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain(owner.tenant_id);
    expect((await agent.get("/api/settings/export")).status).toBe(404); // no GET surface for agents or anyone
    const noCsrf = await c.request("POST", "/api/settings/export", { categories: ["journal"] }, { "x-blackbox-csrf": "wrong" });
    expect(noCsrf.status).toBe(403);
    expect((await c.post("/api/settings/export", { categories: [] })).status).toBe(422);
    expect((await c.post("/api/settings/export", { categories: ["evidence_content"] })).status).toBe(422);
    expect((await c.post("/api/settings/export", { categories: ["journal"], from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" })).status).toBe(422);
  });

  it("preview reports the inventory without an audit row; the download carries only the owner's rows, lists restricted evidence by status and is audited", async () => {
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    // Retention policy + an owner restriction so the export has something to report per object.
    expect((await c.patch("/api/settings/retention", { provider_payload: 120 })).status).toBe(200);
    const restricted = ownerEvidence[0]!;
    expect((await c.post(`/api/evidence/${restricted}/restrict`, { reason: "customer asked for removal of the raw payload" })).status).toBe(201);
    const before = (await c.get("/api/settings/security")).json as { counts: Record<string, number> };
    const exportsBefore = before.counts["workspace.exported"] ?? 0;

    const preview = await c.post("/api/settings/export?preview=1", { categories: ["journal", "evidence_metadata", "settings"] });
    expect(preview.status).toBe(200);
    const inv = (preview.json as { preview: Record<string, unknown> }).preview;
    expect(inv.counts).toMatchObject({ journal_entries: ownerEntryIds.length, evidence_items: ownerEvidence.length, evidence_restricted: 1, settings_sections: 4 });
    expect(inv.truncated).toBe(false);
    expect(inv.files).toEqual(["settings.json", "evidence-metadata.jsonl", "journal-entries.jsonl", "manifest.json"]);
    expect(preview.headers.get("content-type")).toContain("application/json");
    const afterPreview = (await c.get("/api/settings/security")).json as { counts: Record<string, number> };
    expect(afterPreview.counts["workspace.exported"] ?? 0).toBe(exportsBefore); // preview is not an export

    const dl = await download(c, { categories: ["journal", "evidence_metadata", "settings"] });
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toBe("application/zip");
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; filename="blackbox-workspace-export-.*\.zip"$/);
    expect(dl.headers["x-export-truncated"]).toBe("0");
    const files = unzipSync(new Uint8Array(dl.bytes));
    expect(Object.keys(files).sort()).toEqual(["evidence-metadata.jsonl", "journal-entries.jsonl", "manifest.json", "settings.json"]);
    const journal = strFromU8(files["journal-entries.jsonl"]!).trim().split("\n").map((l) => JSON.parse(l) as { entry_id: string; tenant_id: string; journal_sequence: number; track: string; payload: unknown; record_id: string });
    expect(journal.map((e) => e.entry_id).sort()).toEqual([...ownerEntryIds].sort());
    expect(journal.every((e) => e.tenant_id === owner.tenant_id)).toBe(true);
    expect(journal.map((e) => e.journal_sequence)).toEqual([...journal.map((e) => e.journal_sequence)].sort((a, b) => a - b));
    expect(new Set(journal.map((e) => e.track)).size).toBeGreaterThan(1); // more than one canonical track
    const evidence = strFromU8(files["evidence-metadata.jsonl"]!).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(evidence.map((e) => e.evidence_id).sort()).toEqual([...ownerEvidence].sort());
    const restrictedRow = evidence.find((e) => e.evidence_id === restricted)!;
    expect(restrictedRow).toMatchObject({ status: "restricted", status_policy_ref: "owner_restriction", content_included: false, retention_days: 120 });
    expect(typeof restrictedRow.status_since).toBe("string");
    expect(evidence.filter((e) => e.status === "available")).toHaveLength(ownerEvidence.length - 1);
    for (const e of evidence) {
      expect(e).not.toHaveProperty("content");
      expect(e).not.toHaveProperty("storage_ref");
      expect(e).not.toHaveProperty("reason");
    }
    const settings = JSON.parse(strFromU8(files["settings.json"]!)) as { workspace: { tenant_id: string; display_name: string }; retention: { default_days: number; classes: Record<string, { days: number; source: string }> }; storage_thresholds: Record<string, number>; backups: Record<string, unknown> };
    expect(settings.workspace).toMatchObject({ tenant_id: owner.tenant_id, display_name: "Studio Nord" });
    expect(settings.retention).toMatchObject({ default_days: 90, classes: { provider_payload: { days: 120, source: "owner" } } });
    expect(settings.storage_thresholds.warn_percent).toBeGreaterThan(0);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as Record<string, unknown>;
    expect(manifest).toMatchObject({ format: "blackbox-workspace-export", format_version: 1, tenant_id: owner.tenant_id, truncated: false, categories: ["journal", "evidence_metadata", "settings"] });
    expect(manifest.committed_cursor).toBe(inv.committed_cursor);

    // Tenant boundary: nothing of tenant B anywhere in the bundle, even though B holds the same record ids.
    const everything = Object.values(files).map((f) => strFromU8(f)).join("\n");
    expect(everything).not.toContain(tenantB);
    expect(everything).not.toContain(connB);
    for (const id of bEntryIds) expect(everything).not.toContain(id);
    for (const ev of bEvidence) expect(everything).not.toContain(ev);
    const bRecordIds = new Set<string>();
    for (const id of bEntryIds) bRecordIds.add((await app.built.ctx.journal.get(tenantB, id))!.entry.record_id);
    expect([...bRecordIds].every((rid) => journal.some((e) => e.record_id === rid))).toBe(true); // same ids exist, but only A's rows were exported
    expect(journal).toHaveLength(ownerEntryIds.length);
    // No secret material of any kind.
    expect(everything).not.toMatch(/bb[ka]_[A-Za-z0-9_-]{20,}/);
    expect(everything).not.toContain(owner.key.slice(4, 20));

    // Audit row: actor, categories, counts, bytes; visible through the owner's security summary.
    const after = (await c.get("/api/settings/security")).json as { counts: Record<string, number>; last_events: Array<{ event: string; actor_kind: string; channel: string }> };
    expect(after.counts["workspace.exported"]).toBe(exportsBefore + 1);
    expect(after.last_events[0]).toMatchObject({ event: "workspace.exported", actor_kind: "owner", channel: "api" });
    const row = await (await import("@blackbox/database")).withTenant(app.pool, owner.tenant_id, (cl) => cl.query<{ actor_id: string; metadata: Record<string, unknown> }>("SELECT actor_id, metadata FROM security_audit WHERE event = 'workspace.exported' ORDER BY audit_id DESC LIMIT 1"));
    expect(row.rows[0]!.actor_id).toBe(owner.principal_id);
    expect(row.rows[0]!.metadata).toMatchObject({ categories: ["journal", "evidence_metadata", "settings"], counts: { journal_entries: ownerEntryIds.length, evidence_items: ownerEvidence.length, evidence_restricted: 1 }, bytes: dl.bytes.length, truncated: false });
    // The second tenant's audit log did not change (no cross-tenant side effect).
    const bAudit = await (await import("@blackbox/database")).withTenant(app.pool, tenantB, (cl) => cl.query<{ n: string }>("SELECT count(*)::text AS n FROM security_audit WHERE event = 'workspace.exported'"));
    expect(Number(bAudit.rows[0]!.n)).toBe(0);
  });

  it("the second tenant exported on its own sees only its own rows (symmetry of the boundary)", async () => {
    const r = await buildWorkspaceExport(app.pool, { tenantId: tenantB, categories: ["journal", "evidence_metadata", "settings"], serviceVersion: "test" }, false);
    const files = unzipSync(r.zip!);
    const journal = strFromU8(files["journal-entries.jsonl"]!).trim().split("\n").map((l) => JSON.parse(l) as { entry_id: string; tenant_id: string });
    expect(journal.map((e) => e.entry_id).sort()).toEqual([...bEntryIds].sort());
    const everything = Object.values(files).map((f) => strFromU8(f)).join("\n");
    expect(everything).not.toContain(owner.tenant_id);
    for (const id of ownerEntryIds) expect(everything).not.toContain(id);
    for (const ev of ownerEvidence) expect(everything).not.toContain(ev);
    expect(r.inventory.counts.evidence_restricted).toBe(0); // the owner's restriction never leaked into B's inventory
  });

  it("recorded-time window and the byte cap bound the bundle; truncation names continue_from and is audited as truncated", async () => {
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    const future = await c.post("/api/settings/export?preview=1", { categories: ["journal", "evidence_metadata"], from: "2999-01-01T00:00:00Z" });
    expect((future.json as { preview: { counts: Record<string, number> } }).preview.counts).toMatchObject({ journal_entries: 0, evidence_items: 0 });
    // A cap too small for the whole journal: the builder stops at the first entry that does not fit.
    const small = await buildWorkspaceExport(app.pool, { tenantId: owner.tenant_id, categories: ["journal"], serviceVersion: "test", maxBytes: 2500 }, false);
    expect(small.inventory.truncated).toBe(true);
    expect(small.inventory.counts.journal_entries).toBeGreaterThan(0);
    expect(small.inventory.counts.journal_entries).toBeLessThan(ownerEntryIds.length);
    expect(small.inventory.continue_from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(small.inventory.size_bytes).toBeLessThanOrEqual(2500 + 4096); // manifest is always appended after the cap check
    const files = unzipSync(small.zip!);
    const lines = strFromU8(files["journal-entries.jsonl"]!).trim().split("\n");
    expect(lines).toHaveLength(small.inventory.counts.journal_entries);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as { truncated: boolean; continue_from: string; last_included_sequence: number };
    expect(manifest.truncated).toBe(true);
    expect(manifest.last_included_sequence).toBe(small.inventory.last_included_sequence);
    // Continuing from continue_from yields the remainder; together both parts cover every entry exactly once.
    const rest = await buildWorkspaceExport(app.pool, { tenantId: owner.tenant_id, categories: ["journal"], serviceVersion: "test", from: small.inventory.continue_from }, false);
    const restLines = strFromU8(unzipSync(rest.zip!)["journal-entries.jsonl"]!).trim().split("\n").filter(Boolean);
    const all = [...lines, ...restLines].map((l) => (JSON.parse(l) as { entry_id: string }).entry_id);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...ownerEntryIds].sort());
  });
});
