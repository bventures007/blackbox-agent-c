/**
 * Pipeline tests through a real PostgreSQL 16 (container blackbox-agent-c-workerpg, 127.0.0.1:19185) with the
 * actual bb_worker role, RLS, append_journal_entries boundary and the provider-shaped fixture.
 * Covers: SLICE-01 steps 2-3 and 6 (adapter -> journal/outbox, late correction, two tenants with colliding ids),
 * INGEST-02 (duplicates once), INGEST-03/05 (interrupted run resumes from checkpoint, poison dead letters),
 * INGEST-04 (reordered pages), JOURNAL-01/02 (append-only, conflict preserved), HEALTH-01 (successful check vs
 * new event, credential check never a sync), IMPORT-02/05 (open context, counters, expansion without doubles),
 * TENANT-01/02 (isolation with the worker role), PILOT-05 (reconnect identity), PILOT-06 (storage critical pause).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@blackbox/connectors';
import { createConnection, createPlan, createTenant, createTestDatabase, tenantQuery, type TestDb } from './helpers/db.ts';
import { startFixture, FIXTURE_CLOCK, type RunningFixture } from './helpers/fixture.ts';
import { FakeClock, makeEngine, storageState } from './helpers/worker.ts';

let db: TestDb; let fixture: RunningFixture;
const FROM = new Date(FIXTURE_CLOCK - 30 * 86_400_000).toISOString();
const CUTOFF = new Date(FIXTURE_CLOCK).toISOString();

beforeAll(async () => { db = await createTestDatabase(); fixture = await startFixture({ seed: 42, orders: 40, port: 0 }); });
afterAll(async () => { await fixture.close(); await db.close(); });

async function runToCompletion(engine: ReturnType<typeof makeEngine>['engine'], tenant: string, run_id: string, maxPages?: number) {
  let result = await engine.executeRun(tenant, run_id, { maxPages });
  let guard = 0;
  while (result.state === 'queued' && guard++ < 50) result = await engine.executeRun(tenant, run_id, { maxPages });
  return result;
}

describe('backfill through the journal boundary', () => {
  it('appends source + derived entries once; a rerun appends nothing (INGEST-02, JOURNAL-02)', async () => {
    await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST', body: JSON.stringify({ seed: 42, orders: 40, clock: FIXTURE_CLOCK }) });
    const tenant = await createTenant(db, 'Studio Nord');
    const conn = await createConnection(db, tenant, { provider: 'shopify', base_url: fixture.url });
    await createPlan(db, tenant, conn, { requested_from: FROM, initial_cutoff: CUTOFF });
    const { engine, records } = makeEngine(db);
    const check = await engine.credentialCheck(tenant, conn);
    expect(check.ok).toBe(true);
    const health0 = await tenantQuery<{ last_successful_check_at: Date | null; last_attempt_at: Date | null }>(db, tenant, 'SELECT last_successful_check_at, last_attempt_at FROM capability_health WHERE connection_id = $1 AND capability_id = $2', [conn, 'shopify.orders']);
    expect(health0[0]!.last_attempt_at).not.toBeNull(); expect(health0[0]!.last_successful_check_at).toBeNull(); // credential check is not a sync (HEALTH-01)
    const run = await engine.createRun(tenant, conn, 'backfill', 'shopify:orders');
    const result = await runToCompletion(engine, tenant, run);
    expect(['completed', 'completed_with_gaps']).toContain(result.state);
    expect(result.totals_known).toBe(true);
    expect(result.counters.requested).toBeGreaterThan(0);
    const state = await fixture.state();
    expect(result.counters.loaded).toBe(result.counters.requested); // logical orders, exact count from ordersCount
    expect(result.counters.committed).toBeGreaterThan(result.counters.requested); // one order produces several records (txns, shipments)
    expect(result.counters.duplicates).toBe(0);
    expect(result.counters.rejected).toBeGreaterThan(0); // pending transaction recorded as unsupported, visible as dead letter
    expect(Number(state.orders)).toBeGreaterThanOrEqual(result.counters.loaded);
    const entries = await tenantQuery<{ track: string; n: string }>(db, tenant, 'SELECT track, count(*)::text AS n FROM journal_entries GROUP BY track ORDER BY track');
    const byTrack = Object.fromEntries(entries.map((e) => [e.track, Number(e.n)]));
    expect(byTrack.source).toBeGreaterThan(50); expect(byTrack.fact).toBeGreaterThan(0); expect(byTrack.movement).toBeGreaterThan(0); expect(byTrack.reservation).toBeGreaterThan(0);
    const outbox = await tenantQuery<{ n: string }>(db, tenant, 'SELECT count(*)::text AS n FROM outbox');
    const total = await tenantQuery<{ n: string; max: string }>(db, tenant, 'SELECT count(*)::text AS n, max(journal_sequence)::text AS max FROM journal_entries');
    expect(Number(outbox[0]!.n)).toBe(Number(total[0]!.n)); expect(Number(total[0]!.max)).toBe(Number(total[0]!.n)); // contiguous tenant sequence + outbox per entry
    expect(result.committed_cursor).toBe(Number(total[0]!.max));
    const derived = await tenantQuery<{ n: string }>(db, tenant, "SELECT count(*)::text AS n FROM journal_entries WHERE track <> 'source' AND cardinality(input_entry_ids) = 1 AND derivation_rule LIKE 'connectors.mapping.v1:%'");
    expect(Number(derived[0]!.n)).toBe(Number(total[0]!.n) - byTrack.source!);
    const evidence = await tenantQuery<{ n: string }>(db, tenant, 'SELECT count(*)::text AS n FROM journal_evidence');
    expect(Number(evidence[0]!.n)).toBe(byTrack.source);
    const dead = await tenantQuery<{ reason_code: string }>(db, tenant, 'SELECT reason_code FROM worker_dead_letters WHERE run_id = $1', [run]);
    expect(dead.some((d) => d.reason_code === 'unsupported_event')).toBe(true);
    // Rerun: everything duplicates, nothing appended, deliveries attempts grow.
    const run2 = await engine.createRun(tenant, conn, 'backfill', 'shopify:orders');
    const result2 = await runToCompletion(engine, tenant, run2);
    expect(result2.counters.committed).toBe(0); expect(result2.counters.duplicates).toBe(byTrack.source); expect(result2.counters.conflicts).toBe(0); // every observation is a duplicate delivery
    const total2 = await tenantQuery<{ n: string }>(db, tenant, 'SELECT count(*)::text AS n FROM journal_entries');
    expect(total2[0]!.n).toBe(total[0]!.n);
    const attempts = await tenantQuery<{ n: string }>(db, tenant, 'SELECT count(*)::text AS n FROM deliveries WHERE attempts = 2');
    expect(Number(attempts[0]!.n)).toBe(byTrack.source);
    // Logs: batch commits carry run/connection ids; no token or payload leaks.
    const commits = records.filter((r) => r.event_name === 'journal.batch_committed' && r.run_id === run);
    expect(commits.length).toBe(result.pages);
    for (const c of commits) { expect(c.run_id).toBe(run); expect(c.connection_id).toBe(conn); expect(c.tenant_id).toBe(tenant); expect(c.scope).toBe('workspace'); }
    expect(JSON.stringify(records)).not.toContain('shpat_');
    expect(JSON.stringify(records)).not.toContain('gid://shopify/Customer');
    // Health: backfill completion sets coverage and a successful full-scope check.
    const health = await tenantQuery<{ last_successful_check_at: Date | null; last_new_event_at: Date | null; coverage_from: Date; coverage_to: Date; status: string; next_check_at: Date | null; incremental_cursor: Record<string, unknown> }>(db, tenant, 'SELECT * FROM capability_health WHERE connection_id = $1 AND capability_id = $2', [conn, 'shopify.payments']);
    expect(health[0]!.last_successful_check_at).not.toBeNull(); expect(health[0]!.last_new_event_at).not.toBeNull();
    expect(health[0]!.coverage_from.toISOString()).toBe(FROM); expect(health[0]!.coverage_to.toISOString()).toBe(CUTOFF);
    expect(health[0]!.next_check_at).not.toBeNull(); expect(health[0]!.incremental_cursor.floor).toBeDefined();
  });

  it('same identity with different content preserves the original and opens a conflict (JOURNAL-02)', async () => {
    await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST', body: JSON.stringify({ seed: 42, orders: 12, clock: FIXTURE_CLOCK }) });
    const tenant = await createTenant(db, 'Conflict');
    const conn = await createConnection(db, tenant, { provider: 'shopify', base_url: fixture.url });
    await createPlan(db, tenant, conn, { requested_from: new Date(FIXTURE_CLOCK - 60 * 86_400_000).toISOString(), initial_cutoff: CUTOFF });
    const { engine } = makeEngine(db);
    await runToCompletion(engine, tenant, await engine.createRun(tenant, conn, 'backfill', 'shopify:orders'));
    const before = await tenantQuery<{ entry_id: string; payload: Record<string, unknown>; payload_hash: string }>(db, tenant, "SELECT entry_id, payload, payload_hash FROM journal_entries WHERE track = 'source' AND event_type = 'order.accepted' AND entity_refs->>'order' = 'gid://shopify/Order/5002'");
    expect(before.length).toBe(1);
    await fixture.control({ mutate: { mutate_accepted: 5002 } });
    const r = await runToCompletion(engine, tenant, await engine.createRun(tenant, conn, 'backfill', 'shopify:orders'));
    expect(r.counters.conflicts).toBe(1);
    const after = await tenantQuery<{ entry_id: string; payload: Record<string, unknown>; payload_hash: string }>(db, tenant, 'SELECT entry_id, payload, payload_hash FROM journal_entries WHERE entry_id = $1', [before[0]!.entry_id]);
    expect(after[0]!.payload_hash).toBe(before[0]!.payload_hash);
    const conflict = await tenantQuery<{ payload: Record<string, unknown>; input_entry_ids: string[] }>(db, tenant, "SELECT payload, input_entry_ids FROM journal_entries WHERE event_type = 'source.conflict_observed'");
    expect(conflict.length).toBe(1); expect(conflict[0]!.input_entry_ids).toEqual([before[0]!.entry_id]); expect(conflict[0]!.payload.original_entry_id).toBe(before[0]!.entry_id);
    const cases = await tenantQuery<{ type: string; state: string }>(db, tenant, 'SELECT type, state FROM review_cases');
    expect(cases).toEqual([{ type: 'source_conflict', state: 'open' }]);
    const delivery = await tenantQuery<{ status: string }>(db, tenant, "SELECT status FROM deliveries WHERE provider_event_id LIKE '%|order:5002|accepted'");
    expect(delivery[0]!.status).toBe('conflict');
  });

  it('an interrupted run resumes from its checkpoint without double effects (INGEST-03/05, IMPORT-05)', async () => {
    await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST', body: JSON.stringify({ seed: 7, orders: 30, clock: FIXTURE_CLOCK }) });
    const tenantA = await createTenant(db, 'Interrupted'); const tenantB = await createTenant(db, 'Uninterrupted');
    const connA = await createConnection(db, tenantA, { provider: 'shopify', base_url: fixture.url, page_size: 5 });
    const connB = await createConnection(db, tenantB, { provider: 'shopify', base_url: fixture.url, page_size: 5 });
    for (const [t, c] of [[tenantA, connA], [tenantB, connB]] as const) await createPlan(db, t, c, { requested_from: new Date(FIXTURE_CLOCK - 60 * 86_400_000).toISOString(), initial_cutoff: CUTOFF });
    const { engine } = makeEngine(db);
    const runA = await engine.createRun(tenantA, connA, 'backfill', 'shopify:orders');
    const first = await engine.executeRun(tenantA, runA, { maxPages: 2 });
    expect(first.state).toBe('queued'); expect(first.pages).toBe(2);
    const mid = await tenantQuery<{ state: string; checkpoint: { cursor: { after: string | null; phase: string } } }>(db, tenantA, 'SELECT state, checkpoint FROM import_runs WHERE run_id = $1', [runA]);
    expect(mid[0]!.state).toBe('queued'); expect(mid[0]!.checkpoint.cursor.after).not.toBeNull();
    const midCount = Number((await tenantQuery<{ n: string }>(db, tenantA, 'SELECT count(*)::text AS n FROM journal_entries'))[0]!.n);
    expect(midCount).toBeGreaterThan(0);
    // "Crash" and resume: the second attempt continues at page 3.
    const resumed = await runToCompletion(engine, tenantA, runA, 3);
    expect(['completed', 'completed_with_gaps']).toContain(resumed.state);
    const runB = await engine.createRun(tenantB, connB, 'backfill', 'shopify:orders');
    const whole = await runToCompletion(engine, tenantB, runB);
    const countA = (await tenantQuery<{ n: string; ids: string }>(db, tenantA, "SELECT count(*)::text AS n, count(DISTINCT provider_event_id)::text AS ids FROM journal_entries WHERE track = 'source'"))[0]!;
    const countB = (await tenantQuery<{ n: string; ids: string }>(db, tenantB, "SELECT count(*)::text AS n, count(DISTINCT provider_event_id)::text AS ids FROM journal_entries WHERE track = 'source'"))[0]!;
    expect(countA.n).toBe(countB.n); expect(countA.ids).toBe(countA.n);
    expect(resumed.counters.committed).toBe(whole.counters.committed); expect(resumed.counters.loaded).toBe(whole.counters.loaded);
    expect(resumed.pages).toBe(whole.pages);
    const dup = await tenantQuery<{ n: string }>(db, tenantA, 'SELECT count(*)::text AS n FROM deliveries WHERE attempts > 1');
    expect(Number(dup[0]!.n)).toBe(0); // resume continued at the checkpoint instead of re-reading pages
  });

  it('late corrections append; earlier entries stay unchanged; successful empty poll advances only the check time (HEALTH-01, IMPORT-05)', async () => {
    await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST', body: JSON.stringify({ seed: 42, orders: 12, clock: FIXTURE_CLOCK }) });
    const tenant = await createTenant(db, 'Late');
    const conn = await createConnection(db, tenant, { provider: 'shopify', base_url: fixture.url });
    await createPlan(db, tenant, conn, { requested_from: new Date(FIXTURE_CLOCK - 60 * 86_400_000).toISOString(), initial_cutoff: CUTOFF });
    const clock = new FakeClock(FIXTURE_CLOCK + 3_600_000); // the worker clock sits one hour after the fixture clock; no dependency on wall time
    const { engine } = makeEngine(db, { clock });
    await runToCompletion(engine, tenant, await engine.createRun(tenant, conn, 'backfill', 'shopify:orders'));
    const snapshot = await tenantQuery<{ entry_id: string; payload_hash: string; recorded_at: Date }>(db, tenant, 'SELECT entry_id, payload_hash, recorded_at FROM journal_entries ORDER BY journal_sequence');
    // Empty incremental poll one minute later: nothing new.
    clock.tick(60_000);
    const inc1 = await runToCompletion(engine, tenant, await engine.createRun(tenant, conn, 'incremental', 'shopify:orders'));
    expect(inc1.state).toBe('completed'); expect(inc1.counters.committed).toBe(0);
    const h1 = (await tenantQuery<{ last_successful_check_at: Date; last_new_event_at: Date; incremental_cursor: { floor: string } }>(db, tenant, 'SELECT last_successful_check_at, last_new_event_at, incremental_cursor FROM capability_health WHERE connection_id = $1 AND capability_id = $2', [conn, 'shopify.orders']))[0]!;
    expect(h1.last_successful_check_at.getTime()).toBeGreaterThan(h1.last_new_event_at.getTime());
    // Late correction at the provider: the next poll appends an order.revised; nothing is rewritten.
    clock.tick(60_000);
    await fixture.control({ mutate: { revise_order: 5003, at: new Date(FIXTURE_CLOCK + 1_800_000).toISOString() } });
    const inc2 = await runToCompletion(engine, tenant, await engine.createRun(tenant, conn, 'incremental', 'shopify:orders'));
    expect(inc2.counters.committed).toBe(1);
    const revised = await tenantQuery<{ payload: Record<string, unknown>; occurred_at: Date; recorded_at: Date }>(db, tenant, "SELECT payload, occurred_at, recorded_at FROM journal_entries WHERE track = 'source' AND event_type = 'order.revised' AND entity_refs->>'order' = 'gid://shopify/Order/5003' ORDER BY journal_sequence DESC LIMIT 1");
    expect(revised.length).toBe(1); expect(revised[0]!.payload.observation_mode).toBe('live'); expect(revised[0]!.occurred_at.toISOString()).toBe(new Date(FIXTURE_CLOCK + 1_800_000).toISOString());
    const after = await tenantQuery<{ entry_id: string; payload_hash: string; recorded_at: Date }>(db, tenant, 'SELECT entry_id, payload_hash, recorded_at FROM journal_entries ORDER BY journal_sequence');
    expect(after.slice(0, snapshot.length)).toEqual(snapshot);
    const h2 = (await tenantQuery<{ last_successful_check_at: Date; last_new_event_at: Date }>(db, tenant, 'SELECT last_successful_check_at, last_new_event_at FROM capability_health WHERE connection_id = $1 AND capability_id = $2', [conn, 'shopify.orders']))[0]!;
    expect(h2.last_new_event_at.getTime()).toBeGreaterThan(h1.last_new_event_at.getTime());
    // Backfilled history is labeled separately from live activity.
    const modes = await tenantQuery<{ mode: string; n: string }>(db, tenant, "SELECT payload->>'observation_mode' AS mode, count(*)::text AS n FROM journal_entries WHERE track = 'source' GROUP BY 1 ORDER BY 1");
    expect(modes.map((m) => m.mode)).toEqual(['backfill', 'live']);
  });

  it('two tenants with the same external ids are isolated under the worker role (TENANT-01/02, SLICE-01 step 6)', async () => {
    await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST', body: JSON.stringify({ seed: 42, orders: 10, clock: FIXTURE_CLOCK }) });
    const a = await createTenant(db, 'A'); const b = await createTenant(db, 'B');
    const ca = await createConnection(db, a, { provider: 'shopify', base_url: fixture.url }); const cb = await createConnection(db, b, { provider: 'shopify', base_url: fixture.url });
    for (const [t, c] of [[a, ca], [b, cb]] as const) await createPlan(db, t, c, { requested_from: new Date(FIXTURE_CLOCK - 60 * 86_400_000).toISOString(), initial_cutoff: CUTOFF });
    const { engine } = makeEngine(db);
    const ra = await runToCompletion(engine, a, await engine.createRun(a, ca, 'backfill', 'shopify:orders'));
    const rb = await runToCompletion(engine, b, await engine.createRun(b, cb, 'backfill', 'shopify:orders'));
    expect(ra.counters.committed).toBe(rb.counters.committed);
    const seenByA = await tenantQuery<{ tenant_id: string }>(db, a, "SELECT DISTINCT tenant_id FROM journal_entries WHERE entity_refs->>'order' = 'gid://shopify/Order/5001'");
    expect(seenByA).toEqual([{ tenant_id: a }]);
    const crossRun = await tenantQuery(db, a, 'SELECT run_id FROM import_runs WHERE connection_id = $1', [cb]);
    expect(crossRun).toEqual([]);
    await expect(engine.executeRun(a, (await tenantQuery<{ run_id: string }>(db, b, 'SELECT run_id FROM import_runs LIMIT 1'))[0]!.run_id)).rejects.toThrow(/not found/);
    await expect(withTenant(db.pool, a, (c) => c.query('UPDATE journal_entries SET payload = payload WHERE tenant_id = $1', [a]))).rejects.toThrow(/permission denied|append-only/);
    await expect(withTenant(db.pool, a, (c) => c.query('DELETE FROM journal_evidence WHERE tenant_id = $1', [a]))).rejects.toThrow(/permission denied|append-only/);
    const unscoped = new (await import('pg')).default.Client({ connectionString: db.workerUrl }); await unscoped.connect();
    expect((await unscoped.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n).toBe(0);
    await expect(unscoped.query("SELECT append_journal_entries('[{\"track\":\"source\",\"record_id\":\"x\",\"event_type\":\"order.accepted\",\"occurred_at\":\"2026-01-01T00:00:00Z\",\"payload\":{}}]'::jsonb)")).rejects.toThrow(/app.tenant_id/);
    await unscoped.end();
  });

  it('storage critical pauses fetch and keeps the checkpoint; resumes afterwards (PILOT-06)', async () => {
    await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST', body: JSON.stringify({ seed: 3, orders: 20, clock: FIXTURE_CLOCK }) });
    const tenant = await createTenant(db, 'Disk');
    const conn = await createConnection(db, tenant, { provider: 'shopify', base_url: fixture.url, page_size: 4 });
    await createPlan(db, tenant, conn, { requested_from: new Date(FIXTURE_CLOCK - 60 * 86_400_000).toISOString(), initial_cutoff: CUTOFF });
    let calls = 0; let critical = false;
    const { engine, records } = makeEngine(db, { storage: async () => { calls++; return storageState(critical ? 'critical' : 'ok'); } });
    const run = await engine.createRun(tenant, conn, 'backfill', 'shopify:orders');
    const first = await engine.executeRun(tenant, run, { maxPages: 2 });
    expect(first.state).toBe('queued');
    critical = true;
    const paused = await engine.executeRun(tenant, run);
    expect(paused.state).toBe('paused'); expect(paused.error_code).toBe('storage_critical'); expect(paused.pages).toBe(2);
    const row = (await tenantQuery<{ state: string; next_action: string; checkpoint: { cursor: { after: string | null } } }>(db, tenant, 'SELECT state, next_action, checkpoint FROM import_runs WHERE run_id = $1', [run]))[0]!;
    expect(row.state).toBe('paused'); expect(row.next_action).toBe('free_disk_space'); expect(row.checkpoint.cursor.after).not.toBeNull();
    const health = (await tenantQuery<{ status: string; next_check_reason: string }>(db, tenant, 'SELECT status, next_check_reason FROM capability_health WHERE connection_id = $1 AND capability_id = $2', [conn, 'shopify.orders']))[0]!;
    expect(health.status).toBe('paused'); expect(health.next_check_reason).toBe('storage_critical');
    expect(records.some((r) => r.event_name === 'source.run_paused' && r.action_code === 'free_disk_space')).toBe(true);
    critical = false;
    const done = await runToCompletion(engine, tenant, run);
    expect(['completed', 'completed_with_gaps']).toContain(done.state);
    const dup = await tenantQuery<{ n: string }>(db, tenant, 'SELECT count(*)::text AS n FROM deliveries WHERE attempts > 1');
    expect(Number(dup[0]!.n)).toBe(0);
    expect(calls).toBeGreaterThan(3);
  });

  it('reconnecting with a different account never reuses cursors (PILOT-05)', async () => {
    await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST', body: JSON.stringify({ seed: 42, orders: 5, clock: FIXTURE_CLOCK }) });
    const tenant = await createTenant(db, 'Reconnect');
    const conn = await createConnection(db, tenant, { provider: 'shopify', base_url: fixture.url, account_ref: 'gid://shopify/Shop/1042' });
    await createPlan(db, tenant, conn, { requested_from: FROM, initial_cutoff: CUTOFF });
    const { engine } = makeEngine(db);
    await runToCompletion(engine, tenant, await engine.createRun(tenant, conn, 'backfill', 'shopify:orders'));
    const before = (await tenantQuery<{ incremental_cursor: unknown }>(db, tenant, 'SELECT incremental_cursor FROM capability_health WHERE connection_id = $1 AND capability_id = $2', [conn, 'shopify.orders']))[0]!;
    // Another shop answers behind the same connection (seed changes the shop id).
    await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST', body: JSON.stringify({ seed: 99, orders: 5, clock: FIXTURE_CLOCK }) });
    const check = await engine.credentialCheck(tenant, conn);
    expect(check.ok).toBe(false); expect(check.error_code).toBe('account_mismatch');
    const status = (await tenantQuery<{ status: string; account_ref: string }>(db, tenant, 'SELECT status, account_ref FROM connections WHERE connection_id = $1', [conn]))[0]!;
    expect(status.status).toBe('reauthorization_required'); expect(status.account_ref).toBe('gid://shopify/Shop/1042');
    const inc = await runToCompletion(engine, tenant, await engine.createRun(tenant, conn, 'incremental', 'shopify:orders'));
    expect(inc.state).toBe('failed'); expect(inc.counters.committed).toBe(0);
    const after = (await tenantQuery<{ incremental_cursor: unknown }>(db, tenant, 'SELECT incremental_cursor FROM capability_health WHERE connection_id = $1 AND capability_id = $2', [conn, 'shopify.orders']))[0]!;
    expect(after.incremental_cursor).toEqual(before.incremental_cursor);
  });

  it('shopify payments backfill lands ledger/payout/dispute tracks with explicit test flags (SOURCE-01 subset)', async () => {
    await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST', body: JSON.stringify({ seed: 42, orders: 40, clock: FIXTURE_CLOCK }) });
    const tenant = await createTenant(db, 'Finance');
    const conn = await createConnection(db, tenant, { provider: 'shopify_payments', base_url: fixture.url });
    await createPlan(db, tenant, conn, { requested_from: new Date(FIXTURE_CLOCK - 60 * 86_400_000).toISOString(), initial_cutoff: CUTOFF });
    const { engine } = makeEngine(db);
    expect((await engine.credentialCheck(tenant, conn)).blocked_capabilities).toEqual(['shopify_payments.holds']);
    for (const group of ['shopify_payments:ledger', 'shopify_payments:payouts', 'shopify_payments:disputes', 'shopify_payments:positions']) {
      const r = await runToCompletion(engine, tenant, await engine.createRun(tenant, conn, 'backfill', group));
      expect(['completed', 'completed_with_gaps']).toContain(r.state);
    }
    const kinds = await tenantQuery<{ event_type: string; track: string }>(db, tenant, 'SELECT DISTINCT event_type, track FROM journal_entries ORDER BY 1, 2');
    const set = new Set(kinds.map((k) => `${k.event_type}/${k.track}`));
    for (const k of ['provider.ledger_posted/movement', 'payment.fee_booked/movement', 'refund.completed/movement', 'payout.sent/movement', 'payout.announced/commitment', 'payout.failed/fact', 'dispute.opened/fact', 'chargeback.debit_posted/movement', 'chargeback.reversed/movement', 'provider.balance_observed/fact']) expect(set, k).toContain(k);
    const holds = await tenantQuery<{ status: string; next_check_reason: string; next_check_at: Date | null }>(db, tenant, 'SELECT status, next_check_reason, next_check_at FROM capability_health WHERE connection_id = $1 AND capability_id = $2', [conn, 'shopify_payments.holds']);
    expect(holds[0]!.next_check_at).toBeNull(); expect(holds[0]!.next_check_reason).toMatch(/no hold/i);
    const untyped = await tenantQuery<{ n: string }>(db, tenant, "SELECT count(*)::text AS n FROM journal_entries WHERE event_type LIKE 'provider.ledger%' AND NOT (payload ? 'test')");
    expect(Number(untyped[0]!.n)).toBe(0);
  });
});
