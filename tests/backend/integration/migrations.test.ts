/**
 * Schema facts that only exist at runtime (ADR-0008 / PILOT-09 perf measurement):
 *  - 0000_roles.sql marks pg_catalog.jsonb_contains LEAKPROOF so `entity_refs @> …` can be an index condition
 *    below the row-level-security barrier (bb_api/bb_worker tenant_scope policy) and its selectivity may use the
 *    column statistics; without it every entity read scanned the tenant's whole journal.
 *  - 0005_gin_fastupdate.sql turns the GIN pending list off for journal_entries_entity_idx so lookups do not scan
 *    up to 4 MB of unmerged entries parked by the ingestion.
 * Both are verified against a database created from the migrated template (roles bootstrap + every migration).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createTestDatabase, type TestDatabase } from "@blackbox/testing";

let db: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase("bbmig");
  admin = new pg.Client({ connectionString: db.urls.migrate });
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
  await db.drop();
});

describe("runtime schema facts for entity reads under RLS", () => {
  it("jsonb_contains is LEAKPROOF after the roles bootstrap (GIN index usable below the RLS barrier)", async () => {
    const r = await admin.query("SELECT proleakproof FROM pg_proc WHERE proname = 'jsonb_contains' AND pronamespace = 'pg_catalog'::regnamespace");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].proleakproof).toBe(true);
  });

  it("journal_entries_entity_idx has fastupdate off (no pending list scanned by every lookup)", async () => {
    const r = await admin.query("SELECT reloptions FROM pg_class WHERE relname = 'journal_entries_entity_idx'");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].reloptions ?? []).toContain("fastupdate=off");
  });
  // The planner proof (both plans contain journal_entries_entity_idx on a seeded journal, plus the negative control
  // without the flag) lives in apps/engine/tests/rls_gin_index.rs; on an empty table the planner prefers the btree.
});
