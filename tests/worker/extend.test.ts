/**
 * EXTEND-01 — a new source enters through the adapter contract, the capability manifest and a fixture
 * only; the ingestion core, the shared event→track table and the financial rules are not touched.
 *
 * A tiny "supplier portal" adapter (in-memory fixture of supplier delivery promises) serves the
 * existing register row `generic.supply`. It is injected through the worker's adapter factory (the
 * registry hook the worker already exposes), declares its capability like every other adapter and
 * emits `supply.commitment_recorded` observations. The test then proves the boundary:
 *   - the run goes through the unchanged worker/ingestion path (checkpointed run, deliveries dedupe,
 *     evidence, append_journal_entries, outbox) and appends source + fact entries (the shared table
 *     derives a fact for every family; events.json also allows a commitment track for supply, but the
 *     TypeScript side derives none — the Rust reducer records the supply promise as a commitment record
 *     from the source/fact entry under the effect-once rule);
 *   - no movement/reservation entry is derived (a supply promise never fills stock; the Rust reducer
 *     reports incoming supply separately — apps/engine/tests/intents_http.rs asserts
 *     `incoming_counted_as_stock: false`); the track set comes from the shared DERIVED_TRACKS table;
 *   - the registry/providers list, the mapping table and the financial reducers are untouched
 *     (PROVIDERS unchanged, createAdapter still returns the internal non-polling adapter for `generic`,
 *     no TypeScript reducer exists); a rerun only produces duplicates.
 * Needs the throwaway PostgreSQL of tests/worker/helpers/db.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROVIDERS, createAdapter, derivedTracks, InternalProducerAdapter, PollingUnsupportedError, type BackfillPlan, type CapabilityDeclaration, type CredentialCheck, type Cursor, type Page, type SourceAdapter } from '@blackbox/connectors';
import { createConnection, createPlan, createTenant, createTestDatabase, tenantQuery, type TestDb } from './helpers/db.ts';
import { makeEngine } from './helpers/worker.ts';

/** Fixture: what a supplier portal would answer (no provider exists; synthetic, labeled). */
const SUPPLIER_PROMISES = [
  { id: 'SP-1001', sku: 'SKU-OLIVE', quantity: '50', unit: 'piece', promised_at: '2026-11-03', supplier: 'SUP-NORTH', revised_at: '2026-10-20T08:00:00Z' },
  { id: 'SP-1002', sku: 'SKU-OLIVE', quantity: '20', unit: 'piece', promised_at: '2026-11-10', supplier: 'SUP-NORTH', revised_at: '2026-10-21T08:00:00Z' },
  { id: 'SP-1003', sku: 'SKU-MUG', quantity: '120', unit: 'piece', promised_at: '2026-11-05', supplier: 'SUP-EAST', revised_at: '2026-10-22T08:00:00Z' },
];

const SUPPLY_CAPABILITY: CapabilityDeclaration = {
  id: 'generic.supply', provider: 'generic', dataset: 'supply',
  time_selection: 'promise revised_at (portal revision time) selects records; occurred_at = revised_at.',
  schedule: { interval_s: 900, min_interval_s: 300, max_interval_s: 3600, jitter_s: 30, overlap_s: 900, reconcile_every_s: 86_400, reconcile_window_s: 86_400, no_poll_reason: null },
  required_grants: [], limitations: ['Synthetic supplier-portal fixture: never live evidence.'],
  emits: ['supply.commitment_recorded', 'supply.commitment_revised'],
  modes: {
    local_standalone: { status: 'supported', methods: ['polling'], reason: 'Outbound poll of the supplier portal from the local worker.' },
    local_gateway: { status: 'unsupported', methods: [], reason: 'Deferred scope: no gateway runtime in the pilot.' },
    public_server: { status: 'unsupported', methods: [], reason: 'Deferred scope: no public server in the pilot.' },
  },
};

/** The whole "new source": one class against the adapter contract; nothing else in the codebase changes. */
class SupplierPortalAdapter implements SourceAdapter {
  readonly provider = 'generic';
  readonly capabilities = [SUPPLY_CAPABILITY];
  constructor(private readonly fixture: typeof SUPPLIER_PROMISES) {}
  async checkCredentials(): Promise<CredentialCheck> {
    return { ok: true, account_ref: 'supplier-portal:fixture', account_label: 'Supplier portal (fixture)', api_version: 'fixture-1', granted: ['read_promises'], missing_grants: [], blocked_capabilities: [], error_code: null, detail: null };
  }
  private page(capability_id: string, rows: typeof SUPPLIER_PROMISES): Page {
    if (capability_id !== 'generic.supply') throw new PollingUnsupportedError(capability_id, 'only generic.supply is served by the supplier portal');
    return {
      observations: rows.map((p) => ({
        provider_event_id: `supplier-portal|promise:${p.id}|${p.revised_at}`,
        kind: 'supply.commitment_recorded', record_id: `supply:${p.id}`, dataset: 'supply', occurred_at: p.revised_at, source_time: p.revised_at,
        entity: { supply: p.id, item: p.sku },
        payload: { promise: p.id, supplier: p.supplier, quantity: p.quantity, unit: p.unit, promised_at: p.promised_at },
        evidence: { kind: 'supplier_portal.promise', media_type: 'application/json', content: p },
        correlation_id: null, test: null,
      })),
      rejected: [], next_cursor: null, done: true, loaded_records: rows.length, total_records: rows.length, max_source_time: rows.at(-1)?.revised_at ?? null, throttle: null,
    };
  }
  async backfill(capability_id: string, plan: BackfillPlan, _cursor: Cursor | null): Promise<Page> {
    return this.page(capability_id, this.fixture.filter((p) => p.revised_at >= plan.requested_from && p.revised_at < plan.initial_cutoff));
  }
  async incremental(capability_id: string, cursor: Cursor | null, _now: Date): Promise<Page> {
    const floor = String(cursor?.floor ?? '1970-01-01T00:00:00Z');
    return this.page(capability_id, this.fixture.filter((p) => p.revised_at >= floor));
  }
  async reconcile(capability_id: string, window: { from: string; to: string }, _cursor: Cursor | null): Promise<Page> {
    return this.page(capability_id, this.fixture.filter((p) => p.revised_at >= window.from && p.revised_at <= window.to));
  }
}

let db: TestDb;
beforeAll(async () => { db = await createTestDatabase(); });
afterAll(async () => { await db.close(); });

async function runToCompletion(engine: ReturnType<typeof makeEngine>['engine'], tenant: string, run_id: string) {
  let result = await engine.executeRun(tenant, run_id);
  let guard = 0;
  while (result.state === 'queued' && guard++ < 20) result = await engine.executeRun(tenant, run_id);
  return result;
}

describe('EXTEND-01 new source through manifest/adapter/fixture only', () => {
  it('a fixture-backed supplier adapter for generic.supply lands source+fact entries without touching stock, money or the mapping table', async () => {
    const tenant = await createTenant(db, 'Extend');
    const conn = await createConnection(db, tenant, { provider: 'generic', account_ref: 'supplier-portal:fixture' });
    await createPlan(db, tenant, conn, { requested_from: '2026-10-01T00:00:00Z', initial_cutoff: '2026-11-01T00:00:00Z' });
    // The registry is untouched: generic is still an internal non-polling producer there ...
    expect([...PROVIDERS]).toEqual(['shopify', 'shopify_payments', 'generic', 'bank_csv', 'replay', 'policy', 'runtime']);
    expect(createAdapter('generic', {}, null, null)).toBeInstanceOf(InternalProducerAdapter);
    // ... and the shared event→track table already answers for the family (no mapping code added).
    expect(derivedTracks('supply.commitment_recorded')).toEqual(['fact']); // shared default: fact only (no movement/reservation ever)
    // The new source is injected through the worker's adapter factory (the extension hook).
    const { engine, records } = makeEngine(db, { adapterFactory: (provider) => (provider === 'generic' ? new SupplierPortalAdapter(SUPPLIER_PROMISES) : createAdapter(provider, {}, null, null)) });
    const check = await engine.credentialCheck(tenant, conn);
    expect(check.ok).toBe(true);
    const run = await engine.createRun(tenant, conn, 'backfill', 'generic:generic.supply');
    const result = await runToCompletion(engine, tenant, run);
    expect(result.state).toBe('completed');
    expect(result.counters.committed).toBe(SUPPLIER_PROMISES.length);
    expect(result.counters.rejected).toBe(0);
    const byTrack = Object.fromEntries((await tenantQuery<{ track: string; n: string }>(db, tenant, 'SELECT track, count(*)::text AS n FROM journal_entries GROUP BY track ORDER BY track')).map((r) => [r.track, Number(r.n)]));
    expect(byTrack).toEqual({ source: 3, fact: 3 }); // no movement, no reservation: a promise moves nothing
    const entries = await tenantQuery<{ track: string; event_type: string; payload: Record<string, unknown>; entity_refs: Record<string, string>; derivation_rule: string | null; input_entry_ids: string[] }>(db, tenant, 'SELECT track, event_type, payload, entity_refs, derivation_rule, input_entry_ids FROM journal_entries ORDER BY journal_sequence');
    for (const e of entries) {
      expect(e.event_type).toBe('supply.commitment_recorded');
      expect(e.entity_refs.item).toMatch(/^SKU-/);
      expect(e.entity_refs.supply).toMatch(/^SP-/);
      // quantities stay decimal strings with a unit; no money field is invented for a supply promise
      expect(typeof e.payload.quantity).toBe('string');
      expect(e.payload.unit).toBe('piece');
      expect(Object.keys(e.payload).some((k) => k.endsWith('_minor') || k === 'currency' || k.includes('stock'))).toBe(false);
      if (e.track !== 'source') { expect(e.derivation_rule).toBe('connectors.mapping.v1:supply.commitment_recorded->' + e.track); expect(e.input_entry_ids.length).toBe(1); }
    }
    const evidence = await tenantQuery<{ n: string }>(db, tenant, 'SELECT count(*)::text AS n FROM journal_evidence');
    expect(Number(evidence[0]!.n)).toBe(3);
    const outbox = await tenantQuery<{ n: string }>(db, tenant, 'SELECT count(*)::text AS n FROM outbox');
    expect(Number(outbox[0]!.n)).toBe(6);
    // Health for the capability came from the manifest declaration (schedule, mode), not from provider code.
    const health = await tenantQuery<{ capability_id: string; poll_group: string; last_successful_check_at: Date | null; next_check_at: Date | null; status: string }>(db, tenant, 'SELECT capability_id, poll_group, last_successful_check_at, next_check_at, status FROM capability_health WHERE connection_id = $1 AND capability_id = $2', [conn, 'generic.supply']);
    expect(health.length).toBe(1);
    expect(health[0]!.last_successful_check_at).not.toBeNull();
    // Rerun: the dedupe boundary makes every observation a duplicate; nothing is appended twice.
    const rerun = await runToCompletion(engine, tenant, await engine.createRun(tenant, conn, 'backfill', 'generic:generic.supply'));
    expect(rerun.counters.committed).toBe(0);
    expect(rerun.counters.duplicates).toBe(3);
    const total = await tenantQuery<{ n: string }>(db, tenant, 'SELECT count(*)::text AS n FROM journal_entries');
    expect(Number(total[0]!.n)).toBe(6);
    // Logs name the run/connection; the fixture content never leaks.
    const commits = records.filter((r) => r.event_name === 'journal.batch_committed' && r.run_id === run);
    expect(commits.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain('SUP-NORTH');
  });
});
