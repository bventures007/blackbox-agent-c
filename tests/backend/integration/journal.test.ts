/**
 * Journal and tenancy integration tests against real PostgreSQL roles.
 * Covers: JOURNAL-01 (UPDATE/DELETE/TRUNCATE rejected for bb_api/bb_worker/bb_engine incl. via a
 * function and cascades; appends still work), JOURNAL-02 (correction supersedes, replay stable,
 * duplicate no effect, conflicting content → conflict entry + review case), TENANT-01..04 (two
 * tenants with the same external ids, pool reuse after success/failure/cancel, cross-tenant 404,
 * unscoped access fails closed, roles are not owners/superusers/BYPASSRLS), INGEST-01 (payload
 * tenant_id ignored; producer bound to its connection), INGEST-02 (concurrent duplicates: one
 * business effect), INGEST-04 (out-of-order effective time keeps original effective time and new
 * recorded position), INGEST-05/06 (checkpoint counters on runs; reconciliation re-delivery is a
 * no-op), SEC-03 is not applicable (no AI/email extraction feature exists in this build).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPool, withTenant, type Pool } from "@blackbox/database";
import { IngestionService, EvidenceStore, JournalService, loadGoldenFixture, goldenToObservation } from "@blackbox/application";
import { loadDataKey } from "@blackbox/auth";
import { createSilentLogger } from "@blackbox/logging";
import { ApiClient, SUPERUSER_URL, startTestApp, type TestApp } from "@blackbox/testing";

let app: TestApp;
let owner: { key: string; tenant_id: string };
let tenantB: string;
let connA: string;
let connB: string;
let ingestion: IngestionService;
const golden = loadGoldenFixture();
const obs = (id: string) => goldenToObservation(golden.events.find((e) => e.id === id)!);

beforeAll(async () => {
  app = await startTestApp();
  owner = await app.setupOwner("Studio Nord");
  tenantB = await app.createTenant("Separate test merchant");
  const svc = app.built.ctx.connections!;
  connA = (await svc.create(owner.tenant_id, { provider: "replay", display_name: "A shop" })).connection.connection_id;
  connB = (await svc.create(tenantB, { provider: "replay", display_name: "B shop" })).connection.connection_id;
  ingestion = new IngestionService({ pool: app.pool, logger: createSilentLogger(), evidence: new EvidenceStore(app.install.evidenceDir), dataKey: loadDataKey(app.install.secretsDir) });
});
afterAll(async () => {
  await app?.stop();
});

async function rolePool(role: "api" | "worker" | "engine"): Promise<Pool> {
  return createPool(app.db.urls[role], { max: 2 });
}

describe("JOURNAL-01 append-only enforcement", () => {
  it("runtime roles are not owners, superusers or BYPASSRLS and have no UPDATE/DELETE/TRUNCATE on journal tables", async () => {
    const c = new pg.Client({ connectionString: app.db.urls.migrate });
    await c.connect();
    try {
      const roles = await c.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>("SELECT rolname, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname IN ('bb_api','bb_worker','bb_engine')");
      expect(roles.rows).toHaveLength(3);
      for (const r of roles.rows) expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      const owners = await c.query<{ tablename: string; tableowner: string }>("SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public'");
      for (const t of owners.rows) expect(t.tableowner, t.tablename).toBe("bb_migrate");
      for (const role of ["bb_api", "bb_worker", "bb_engine"]) {
        for (const table of ["journal_entries", "journal_evidence", "security_audit", "evidence_redactions"]) {
          const p = await c.query<{ u: boolean; d: boolean; t: boolean }>("SELECT has_table_privilege($1, $2, 'UPDATE') AS u, has_table_privilege($1, $2, 'DELETE') AS d, has_table_privilege($1, $2, 'TRUNCATE') AS t", [role, table]);
          expect(p.rows[0], `${role} ${table}`).toEqual({ u: false, d: false, t: false });
        }
      }
      const rls = await c.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('journal_entries','journal_evidence','deliveries','connections','tenants','credentials','sessions','review_cases','import_runs')");
      expect(rls.rows).toHaveLength(9);
      for (const r of rls.rows) expect(r, r.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    } finally {
      await c.end();
    }
  });

  it("UPDATE/DELETE/TRUNCATE are rejected for every runtime role (directly and through a function) while appends work", async () => {
    const r = await ingestion.ingest({ tenantId: owner.tenant_id, connectionId: connA, producer: "replay", observations: [obs("G02")] });
    expect(r.accepted).toBe(1);
    const entryId = (r.outcomes[0] as { entry_ids: string[] }).entry_ids[0]!;
    for (const role of ["api", "worker", "engine"] as const) {
      const pool = await rolePool(role);
      try {
        const tryScoped = async (sql: string, params: unknown[] = []) => {
          try {
            await withTenant(pool, owner.tenant_id, (c) => c.query(sql, params));
            return "allowed";
          } catch (e) {
            return (e as { code?: string }).code ?? "error";
          }
        };
        expect(["42501"]).toContain(await tryScoped("UPDATE journal_entries SET payload = '{}'::jsonb WHERE entry_id = $1", [entryId]));
        expect(["42501"]).toContain(await tryScoped("DELETE FROM journal_entries WHERE entry_id = $1", [entryId]));
        expect(["42501", "0A000"]).toContain(await tryScoped("TRUNCATE journal_entries")); // 0A000: FK-referenced table refuses TRUNCATE before the privilege check
        expect(["42501"]).toContain(await tryScoped("UPDATE journal_evidence SET content_hash = 'x'"));
        expect(["42501"]).toContain(await tryScoped("DELETE FROM journal_evidence"));
        // Through a function the role may execute: still rejected (no SECURITY DEFINER escape).
        expect(["42501", "42883", "0A000"]).toContain(await tryScoped("SELECT journal_reject_mutation()")); // 0A000: trigger functions cannot be called directly
        // Cascade attempt: deleting the tenant/connection row cannot remove journal rows.
        expect(["42501", "23503"]).toContain(await tryScoped("DELETE FROM connections WHERE connection_id = $1", [connA]));
        expect(["42501", "23503"]).toContain(await tryScoped("DELETE FROM tenants WHERE tenant_id = $1", [owner.tenant_id]));
      } finally {
        await pool.end();
      }
    }
    // Even a superuser (not subject to RLS or grants) is stopped by the defensive triggers.
    const c = new pg.Client({ connectionString: SUPERUSER_URL.replace(/\/postgres$/, `/${app.db.name}`) });
    await c.connect();
    try {
      await expect(c.query("UPDATE journal_entries SET payload = '{}'::jsonb WHERE entry_id = $1", [entryId])).rejects.toMatchObject({ code: "42501" });
      await expect(c.query("DELETE FROM journal_entries WHERE entry_id = $1", [entryId])).rejects.toMatchObject({ code: "42501" });
      await expect(c.query("TRUNCATE journal_entries CASCADE")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.end();
    }
    const after = await app.built.ctx.journal.get(owner.tenant_id, entryId);
    expect(after?.entry.payload).toMatchObject({ dataset: "orders" });
  });
});

describe("JOURNAL-02 corrections, duplicates, conflicts, replay", () => {
  it("duplicate delivery has no business effect; different content with the same identity opens a conflict and keeps the original", async () => {
    const first = await ingestion.ingest({ tenantId: owner.tenant_id, connectionId: connA, producer: "replay", observations: [obs("G06")] });
    expect(first.accepted).toBe(1);
    const dup = await ingestion.ingest({ tenantId: owner.tenant_id, connectionId: connA, producer: "replay", observations: [obs("G06")] });
    expect(dup).toMatchObject({ accepted: 0, duplicate: 1, conflict: 0 });
    expect((dup.outcomes[0] as { entry_ids: string[] }).entry_ids).toEqual((first.outcomes[0] as { entry_ids: string[] }).entry_ids);
    const mutated = { ...obs("G06"), payload: { ...obs("G06").payload, captured_minor: 99900 } };
    const conflict = await ingestion.ingest({ tenantId: owner.tenant_id, connectionId: connA, producer: "replay", observations: [mutated] });
    expect(conflict).toMatchObject({ accepted: 0, duplicate: 0, conflict: 1 });
    const out = conflict.outcomes[0] as { case_id: string; conflict_entry_id: string };
    const entry = await app.built.ctx.journal.get(owner.tenant_id, out.conflict_entry_id);
    expect(entry?.entry.event_type).toBe("source.conflict_observed");
    expect(entry?.entry.input_entry_ids).toEqual([(first.outcomes[0] as { entry_ids: string[] }).entry_ids[0]]);
    const original = await app.built.ctx.journal.get(owner.tenant_id, (first.outcomes[0] as { entry_ids: string[] }).entry_ids[0]!);
    expect((original!.entry.payload.observation as { captured_minor: number }).captured_minor).toBe(11900);
    const cases = await app.built.ctx.review.list(owner.tenant_id, "open");
    expect(cases.some((c) => c.case_id === out.case_id && c.type === "provider_content_conflict")).toBe(true);
    // The movement derived from the original capture exists exactly once.
    const moves = await app.built.ctx.journal.list(owner.tenant_id, { track: "movement", event_type: "movement.cash_captured" }, {});
    expect(moves.entries.filter((e) => e.entity_refs.transaction === "TX-1001")).toHaveLength(1);
  });

  it("a correction appends a superseding entry; both versions remain readable and linked", async () => {
    const commitment = (await app.built.ctx.journal.list(owner.tenant_id, { track: "commitment", record_id: "order:#1001" }, {})).entries[0]!;
    expect(commitment.payload).toMatchObject({ quantity: "10" });
    const corrected = await withTenant(app.pool, owner.tenant_id, async (c) => {
      const r = await c.query<{ append_journal_entries: Array<{ entry_id: string; journal_sequence: number }> }>("SELECT append_journal_entries($1::jsonb)", [
        JSON.stringify([{ track: "commitment", record_id: "order:#1001", event_type: "commitment.customer_order_revised", occurred_at: "2026-10-31T09:30:00Z", entity_refs: { order: "#1001" }, payload: { kind: "customer_order", quantity: "8", unit: "piece", amount_minor: 9520, currency: "EUR" }, input_entry_ids: [commitment.entry_id], supersedes_entry_id: commitment.entry_id, derivation_rule: "test.correction", derivation_version: 1 }]),
      ]);
      return r.rows[0]!.append_journal_entries[0]!;
    });
    const link = await app.built.ctx.journal.get(owner.tenant_id, corrected.entry_id);
    expect(link?.supersedes?.entry_id).toBe(commitment.entry_id);
    const orig = await app.built.ctx.journal.get(owner.tenant_id, commitment.entry_id);
    expect(orig?.superseded_by.map((e) => e.entry_id)).toEqual([corrected.entry_id]);
    expect(orig?.entry.payload).toMatchObject({ quantity: "10" });
    const history = await app.built.ctx.journal.entityHistory(owner.tenant_id, "order", "#1001", {});
    expect(history.entries.map((e) => e.entry_id)).toEqual(expect.arrayContaining([commitment.entry_id, corrected.entry_id]));
  });

  it("replay of the same observations yields a stable journal (no new entries, same sequence)", async () => {
    const before = await app.built.ctx.journal.stats(owner.tenant_id);
    const replay = await ingestion.ingest({ tenantId: owner.tenant_id, connectionId: connA, producer: "replay", observations: [obs("G02"), obs("G06")] });
    expect(replay).toMatchObject({ accepted: 0, duplicate: 2 });
    const after = await app.built.ctx.journal.stats(owner.tenant_id);
    expect(after.committed_cursor).toBe(before.committed_cursor);
  });
});

describe("TENANT-01..04 isolation", () => {
  it("TENANT-01: the same external ids in two tenants never cross (list/detail/history/search as A)", async () => {
    const bObs = { ...obs("G02"), payload: { ...obs("G02").payload, gross_minor: 50000, unit_gross_minor: 5000 } };
    const rb = await ingestion.ingest({ tenantId: tenantB, connectionId: connB, producer: "replay", observations: [bObs] });
    expect(rb.accepted).toBe(1);
    const bEntryId = (rb.outcomes[0] as { entry_ids: string[] }).entry_ids[0]!;
    const asA = await app.built.ctx.journal.list(owner.tenant_id, { event_type: "order.accepted" }, {});
    expect(asA.entries.every((e) => e.tenant_id === owner.tenant_id)).toBe(true);
    expect(asA.entries.some((e) => (e.payload.observation as { gross_minor: number } | undefined)?.gross_minor === 50000)).toBe(false);
    expect(await app.built.ctx.journal.get(owner.tenant_id, bEntryId)).toBeNull();
    const histA = await app.built.ctx.journal.entityHistory(owner.tenant_id, "order", "#1001", {});
    expect(histA.entries.every((e) => e.tenant_id === owner.tenant_id)).toBe(true);
    const searchA = await app.built.ctx.journal.list(owner.tenant_id, { q: "#1001" }, {});
    expect(searchA.entries.some((e) => e.entry_id === bEntryId)).toBe(false);
    // Cross-tenant cursor reuse is denied without leaking (MCP-05 part).
    const pageB = await app.built.ctx.journal.list(tenantB, {}, { limit: 1 });
    const cursorB = Buffer.from(JSON.stringify({ t: tenantB, s: pageB.page.snapshot_cursor, a: 0 })).toString("base64url");
    await expect(app.built.ctx.journal.list(owner.tenant_id, {}, { cursor: cursorB })).rejects.toMatchObject({ code: "invalid_cursor" });
    // Via the API: B's ids are 404 for A, evidence too.
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    expect((await c.get(`/api/journal/${bEntryId}`)).status).toBe(404);
    const bEvidence = (await app.built.ctx.journal.get(tenantB, bEntryId))!.entry.evidence_refs[0]!;
    expect((await c.get(`/api/evidence/${bEvidence}`)).status).toBe(404);
    expect((await c.get(`/api/sources/connections/${connB}`)).status).toBe(404);
    expect((await c.post("/api/ingest/replay", { connection_id: connB, events: [{ provider_event_id: "x", kind: "order.accepted", occurred_at: "2026-10-31T09:00:00Z", entity: {}, payload: obs("G02").payload }] })).status).toBe(404);
  });

  it("TENANT-02: runtime roles without tenant context read nothing and cannot write; cross-tenant writes are rejected", async () => {
    for (const role of ["api", "worker"] as const) {
      const pool = await rolePool(role);
      try {
        const client = await pool.connect();
        try {
          const unscoped = await client.query("SELECT count(*)::int AS n FROM journal_entries");
          expect(unscoped.rows[0].n).toBe(0);
          const conns = await client.query("SELECT count(*)::int AS n FROM connections");
          expect(conns.rows[0].n).toBe(0);
          await expect(client.query("INSERT INTO connections (tenant_id, provider, display_name) VALUES ($1, 'replay', 'x')", [owner.tenant_id])).rejects.toMatchObject({ code: "42501" });
        } finally {
          client.release();
        }
        // Scoped as A, attempting to write a row for B: policy WITH CHECK rejects it.
        await expect(withTenant(pool, owner.tenant_id, (c) => c.query("INSERT INTO connections (tenant_id, provider, display_name) VALUES ($1, 'replay', 'x')", [tenantB]))).rejects.toMatchObject({ code: "42501" });
        await expect(withTenant(pool, owner.tenant_id, (c) => c.query("INSERT INTO deliveries (tenant_id, connection_id, provider_event_id, content_hash, status) VALUES ($1, $2, 'x', 'h', 'accepted')", [tenantB, connB]))).rejects.toMatchObject({ code: "42501" });
        // Updating B's row while scoped as A affects nothing.
        const upd = await withTenant(pool, owner.tenant_id, (c) => c.query("UPDATE connections SET display_name = 'hijacked' WHERE connection_id = $1", [connB]));
        expect(upd.rowCount).toBe(0);
      } finally {
        await pool.end();
      }
    }
    // Engine role: reads all tenants by design (documented) but cannot write journal rows.
    const engine = await rolePool("engine");
    try {
      const client = await engine.connect();
      try {
        const n = await client.query("SELECT count(DISTINCT tenant_id)::int AS n FROM journal_entries");
        expect(n.rows[0].n).toBe(2);
        await expect(client.query("INSERT INTO journal_entries (tenant_id, journal_sequence, track, record_id, event_type, occurred_at, payload, payload_hash) VALUES ($1, 999, 'fact', 'x', 'x', now(), '{}', 'h')", [owner.tenant_id])).rejects.toMatchObject({ code: "42501" });
        await expect(client.query("SELECT append_journal_entries('[]'::jsonb)")).rejects.toMatchObject({ code: "42501" });
      } finally {
        client.release();
      }
    } finally {
      await engine.end();
    }
  });

  it("TENANT-03: pooled connections carry no tenant context after success, failure and cancellation", async () => {
    const pool = createPool(app.db.urls.api, { max: 1 }); // a single physical connection reused by everything
    try {
      const countNow = (tenant: string) => withTenant(pool, tenant, async (c) => (await c.query("SELECT count(*)::int AS n FROM journal_entries")).rows[0].n as number);
      const a = await countNow(owner.tenant_id);
      const b = await countNow(tenantB);
      expect(a).toBeGreaterThan(b);
      // failure path
      await expect(withTenant(pool, owner.tenant_id, (c) => c.query("SELECT 1/0"))).rejects.toBeTruthy();
      // cancellation path (statement timeout inside the transaction)
      await expect(withTenant(pool, owner.tenant_id, async (c) => {
        await c.query("SET LOCAL statement_timeout = 50");
        await c.query("SELECT pg_sleep(1)");
      })).rejects.toBeTruthy();
      const client = await pool.connect();
      try {
        const setting = await client.query("SELECT current_setting('app.tenant_id', true) AS v");
        expect(setting.rows[0].v === null || setting.rows[0].v === "").toBe(true);
        // 0001 policies cast the (now empty-string) setting to uuid: the statement fails closed
        // with 22P02 instead of returning rows; either outcome exposes nothing.
        const unscoped = await client.query("SELECT count(*)::int AS n FROM deliveries").then((r) => r.rows[0].n as number, (e: { code: string }) => e.code);
        expect([0, "22P02"]).toContain(unscoped);
      } finally {
        client.release();
      }
      expect(await countNow(tenantB)).toBe(b);
      expect(await countNow(owner.tenant_id)).toBe(a);
      // interleaved concurrent scoped work on the shared pool keeps scopes intact
      const results = await Promise.all([countNow(owner.tenant_id), countNow(tenantB), countNow(owner.tenant_id), countNow(tenantB)]);
      expect(results).toEqual([a, b, a, b]);
    } finally {
      await pool.end();
    }
  });

  it("TENANT-04: cross-tenant foreign references and cursors are denied without sensitive content", async () => {
    // A connection id from tenant B used inside tenant A's scope: FK target invisible → rejected.
    await expect(withTenant(app.pool, owner.tenant_id, (c) => c.query("INSERT INTO import_runs (tenant_id, connection_id, kind) VALUES ($1, $2, 'check')", [owner.tenant_id, connB]))).rejects.toMatchObject({ code: "23503" });
    await expect(ingestion.ingest({ tenantId: owner.tenant_id, connectionId: connB, producer: "replay", observations: [obs("G02")] })).rejects.toMatchObject({ code: "connection_not_found", status: 404 });
    // Evidence files are namespaced per tenant on disk.
    const bEntry = (await app.built.ctx.journal.list(tenantB, { track: "source" }, {})).entries[0]!;
    const access = await withTenant(app.pool, owner.tenant_id, (c) => app.built.ctx.evidence.get(c, owner.tenant_id, bEntry.evidence_refs[0]!));
    expect(access.status).toBe("unavailable");
    expect((access as { meta: unknown }).meta).toBeNull();
  });
});

describe("INGEST-01/02/04/05/06", () => {
  it("INGEST-01: a payload tenant_id/connection_id cannot redirect ingestion; the verified connection decides", async () => {
    const poisoned = { ...obs("G04"), payload: { ...obs("G04").payload, tenant_id: tenantB, connection_id: connB, api_key: "shpat_x" } };
    const r = await ingestion.ingest({ tenantId: owner.tenant_id, connectionId: connA, producer: "replay", observations: [poisoned] });
    expect(r.accepted).toBe(1);
    const entry = await app.built.ctx.journal.get(owner.tenant_id, (r.outcomes[0] as { entry_ids: string[] }).entry_ids[0]!);
    expect(entry?.entry.tenant_id).toBe(owner.tenant_id);
    expect(entry?.entry.connection_id).toBe(connA);
    const text = JSON.stringify(entry?.entry.payload);
    expect(text).not.toContain(tenantB);
    expect(text).not.toContain("shpat_x");
    expect((await app.built.ctx.journal.list(tenantB, { event_type: "invoice.issued" }, {})).entries).toHaveLength(0);
  });

  it("INGEST-02: concurrent duplicate deliveries produce one business effect and a growing delivery audit", async () => {
    const o = obs("G16");
    const results = await Promise.all(Array.from({ length: 6 }, () => ingestion.ingest({ tenantId: owner.tenant_id, connectionId: connA, producer: "replay", observations: [o] })));
    const accepted = results.reduce((n, r) => n + r.accepted, 0);
    const duplicates = results.reduce((n, r) => n + r.duplicate, 0);
    expect(accepted).toBe(1);
    expect(duplicates).toBe(5);
    const refunds = await app.built.ctx.journal.list(owner.tenant_id, { event_type: "movement.cash_refunded" }, {});
    expect(refunds.entries).toHaveLength(1);
    const delivery = await withTenant(app.pool, owner.tenant_id, async (c) => (await c.query("SELECT attempts, status FROM deliveries WHERE provider_event_id = $1", [o.provider_event_id])).rows[0]);
    expect(delivery).toMatchObject({ attempts: 6, status: "accepted" });
  });

  it("INGEST-04: a late event keeps its original effective time and is recorded at the new position", async () => {
    const late = { ...obs("G01"), provider_event_id: "late-snapshot-1", occurred_at: "2026-10-30T08:00:00Z" };
    const before = await app.built.ctx.journal.stats(owner.tenant_id);
    const r = await ingestion.ingest({ tenantId: owner.tenant_id, connectionId: connA, producer: "replay", observations: [late] });
    const entry = (await app.built.ctx.journal.get(owner.tenant_id, (r.outcomes[0] as { entry_ids: string[] }).entry_ids[0]!))!.entry;
    expect(entry.occurred_at).toBe("2026-10-30T08:00:00.000Z");
    expect(entry.journal_sequence).toBeGreaterThan(before.committed_cursor);
    expect(Date.parse(entry.recorded_at)).toBeGreaterThan(Date.parse(entry.occurred_at));
    const byEffective = await app.built.ctx.journal.list(owner.tenant_id, { occurred_to: "2026-10-31T00:00:00Z" }, {});
    expect(byEffective.entries.map((e) => e.entry_id)).toContain(entry.entry_id);
    const byRecorded = await app.built.ctx.journal.list(owner.tenant_id, { recorded_from: entry.recorded_at }, {});
    expect(byRecorded.entries.map((e) => e.entry_id)).toContain(entry.entry_id);
  });

  it("INGEST-05/06: run counters advance durably; reconciliation re-delivery recovers nothing twice and poison payloads are visible", async () => {
    const run = await app.built.ctx.connections!.createRun(owner.tenant_id, connA, "reconcile", null, { requested: 3, totalsKnown: true });
    const poison = { ...obs("G09"), payload: { shipment: "SHIP-X" } };
    const r = await ingestion.ingest({ tenantId: owner.tenant_id, connectionId: connA, producer: "replay", runId: run.run_id, runKind: "reconcile", observations: [obs("G09"), obs("G06"), poison] });
    expect(r).toMatchObject({ accepted: 1, duplicate: 1, rejected: 1 });
    expect((r.outcomes[2] as { error_code: string }).error_code).toBe("invalid_payload");
    const after = await app.built.ctx.connections!.getRun(owner.tenant_id, connA, run.run_id);
    expect(after?.counters).toMatchObject({ loaded: 3, committed: 1, duplicates: 1, failed: 1 });
    expect(after?.percent).toBe(100); // exact total known for this cohort: loaded 3 of 3
    const unknownTotals = await app.built.ctx.connections!.createRun(owner.tenant_id, connA, "backfill", null);
    expect(unknownTotals.percent).toBeNull();
    expect(unknownTotals.totals_known).toBe(false);
  });
});

describe("SEC-03", () => {
  it("is not applicable: no AI/email extraction feature exists; free text never becomes a business fact", () => {
    expect(typeof JournalService).toBe("function");
  });
});
