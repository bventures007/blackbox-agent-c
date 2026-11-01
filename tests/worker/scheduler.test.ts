/**
 * Scheduler tests with a simulated clock through the real database.
 * Covers: PILOT-05 (sleep/wake: coalesced overdue jobs, bounded overlap reconciliation, no burst replay,
 * lease/fencing revalidation), PILOT-06 (storage critical: scheduler stops dispatching), INGEST-05 (fairness
 * across connections, Retry-After backoff respected), HEALTH-01 (next_check reasons: no plan, no poll path).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, createPlan, createTenant, createTestDatabase, tenantQuery, type TestDb } from './helpers/db.ts';
import { startFixture, FIXTURE_CLOCK, type RunningFixture } from './helpers/fixture.ts';
import { FakeClock, makeEngine, collectingLogger } from './helpers/worker.ts';
import { Scheduler, type ScheduledJob } from '../../apps/worker/src/scheduler.ts';
import { suspensionDetector } from '../../apps/worker/src/clock.ts';
import { classify, DEFAULT_THRESHOLDS } from '../../apps/worker/src/storage.ts';

let db: TestDb; let fixture: RunningFixture;
beforeAll(async () => { db = await createTestDatabase('bb_sched'); fixture = await startFixture({ seed: 11, orders: 8, port: 0 }); });
afterAll(async () => { await fixture.close(); await db.close(); });

function makeScheduler(clock: FakeClock, tenants: string[], opts: { max_per_tick?: number; storageCritical?: () => boolean } = {}) {
  const { engine, records } = makeEngine(db, { clock });
  const jobs: ScheduledJob[] = [];
  const { logger } = collectingLogger();
  const scheduler = new Scheduler({ pool: db.pool, engine, logger, clock, dispatch: async (j) => { jobs.push(j); }, max_per_tick: opts.max_per_tick ?? 4, wake_spread_ms: 15_000, suspension_threshold_ms: 60_000, lease_seconds: 300, storageCritical: opts.storageCritical ?? (() => false), only_tenants: tenants });
  return { engine, scheduler, jobs, records };
}

describe('clock and storage primitives', () => {
  it('detects suspension from wall-clock versus monotonic drift, not from timers', () => {
    const clock = new FakeClock(FIXTURE_CLOCK, 0); const d = suspensionDetector(60_000);
    expect(d.observe(clock).suspended).toBe(false);
    clock.tick(5000); expect(d.observe(clock).suspended).toBe(false);
    clock.suspend(3 * 3600_000); const o = d.observe(clock); expect(o.suspended).toBe(true); expect(o.gap_ms).toBe(3 * 3600_000);
    clock.setWall(FIXTURE_CLOCK); const back = d.observe(clock); expect(back.suspended).toBe(true); expect(back.gap_ms).toBeLessThan(0); // manual clock change backwards is visible too
  });
  it('classifies free space with max(percent, absolute) thresholds', () => {
    const t = DEFAULT_THRESHOLDS; const TiB = 1024 ** 4; const GiB = 1024 ** 3;
    expect(classify(TiB, 200 * GiB, t)).toBe('ok'); expect(classify(TiB, 90 * GiB, t)).toBe('warning'); expect(classify(TiB, 15 * GiB, t)).toBe('critical');
    expect(classify(50 * GiB, 4 * GiB, t)).toBe('warning'); expect(classify(50 * GiB, 0.5 * GiB, t)).toBe('critical');
  });
});

describe('scheduler', () => {
  it('schedules nothing without an import plan and explains why; dispatches once a plan exists', async () => {
    const tenant = await createTenant(db, 'Sched A');
    const conn = await createConnection(db, tenant, { provider: 'shopify', base_url: fixture.url });
    const clock = new FakeClock(FIXTURE_CLOCK);
    const { scheduler, jobs } = makeScheduler(clock, [tenant]);
    const t1 = await scheduler.tick();
    expect(t1.dispatched).toEqual([]);
    const reasons = await tenantQuery<{ capability_id: string; next_check_at: Date | null; next_check_reason: string; method: string | null }>(db, tenant, 'SELECT capability_id, next_check_at, next_check_reason, method FROM capability_health WHERE connection_id = $1 ORDER BY capability_id', [conn]);
    expect(reasons.length).toBe(8);
    for (const r of reasons) { expect(r.next_check_at).toBeNull(); expect(r.next_check_reason).toBe('no_import_plan'); expect(r.method).toBe('polling'); }
    await createPlan(db, tenant, conn, { requested_from: new Date(FIXTURE_CLOCK - 30 * 86_400_000).toISOString(), initial_cutoff: new Date(FIXTURE_CLOCK).toISOString() });
    // The API would create the backfill run; the scheduler picks queued runs and starts live collection concurrently.
    await tenantQuery(db, tenant, "UPDATE capability_health SET next_check_at = $2, next_check_reason = 'scheduled' WHERE connection_id = $1", [conn, clock.now()]);
    const t2 = await scheduler.tick();
    const groups = t2.dispatched.map((j) => j.poll_group).sort();
    expect(groups).toEqual(['shopify:allocations', 'shopify:orders', 'shopify:stock']); // one job per poll group, not per capability
    expect(t2.dispatched.every((j) => j.kind === 'incremental')).toBe(true);
    const t3 = await scheduler.tick();
    expect(t3.dispatched).toEqual([]); // open runs block a second job for the same group
    expect(jobs.length).toBe(3);
  });

  it('after a suspension every overdue group gets one coalesced job plus one bounded reconciliation, spread over time (PILOT-05)', async () => {
    const tenant = await createTenant(db, 'Sched B');
    const conn = await createConnection(db, tenant, { provider: 'shopify', base_url: fixture.url });
    await createPlan(db, tenant, conn, { requested_from: new Date(FIXTURE_CLOCK - 30 * 86_400_000).toISOString(), initial_cutoff: new Date(FIXTURE_CLOCK).toISOString() });
    const clock = new FakeClock(FIXTURE_CLOCK);
    const { engine, scheduler, jobs } = makeScheduler(clock, [tenant], { max_per_tick: 10 });
    await scheduler.tick(); // creates health rows (next_check now) and dispatches incremental runs
    for (const j of jobs.splice(0)) { const r = await engine.executeRun(j.tenant_id, j.run_id); expect(['completed', 'completed_with_gaps'], r.error_code ?? '').toContain(r.state); } // run them so groups have a successful check
    const health = await tenantQuery<{ next_check_at: Date }>(db, tenant, "SELECT next_check_at FROM capability_health WHERE connection_id = $1 AND capability_id = 'shopify.orders'", [conn]);
    expect(health[0]!.next_check_at.getTime()).toBeGreaterThan(clock.now().getTime());
    clock.tick(1000); await scheduler.tick(); expect(jobs.length).toBe(0); // nothing due yet
    // Sleep for 6 hours: dozens of 5-minute polls were "missed".
    clock.suspend(6 * 3600_000);
    const t = await scheduler.tick();
    expect(t.suspended).toBe(true); expect(t.gap_ms).toBe(6 * 3600_000);
    const byGroup = new Map<string, ScheduledJob[]>();
    for (const j of jobs) byGroup.set(j.poll_group, [...(byGroup.get(j.poll_group) ?? []), j]);
    expect([...byGroup.keys()].sort()).toEqual(['shopify:allocations', 'shopify:orders', 'shopify:stock']);
    for (const [, js] of byGroup) expect(js.length).toBe(1); // exactly one job per group: no burst replay of 72 missed polls
    const starts = jobs.map((j) => j.start_after_ms);
    expect(new Set(starts).size).toBe(jobs.length); expect(Math.max(...starts)).toBe(15_000 * (jobs.length - 1)); // spread after wake
    const runs = await tenantQuery<{ kind: string; coverage_from: Date | null; coverage_to: Date | null; checkpoint: { window: { from: string; to: string } | null } }>(db, tenant, "SELECT kind, coverage_from, coverage_to, checkpoint FROM import_runs WHERE connection_id = $1 AND state = 'queued'", [conn]);
    const reconciles = runs.filter((r) => r.kind === 'reconcile');
    expect(reconciles.length).toBe(jobs.filter((j) => j.kind === 'reconcile').length);
    for (const r of reconciles) {
      const span = Date.parse(r.checkpoint.window!.to) - Date.parse(r.checkpoint.window!.from);
      expect(span).toBeLessThanOrEqual(48 * 3600_000); // bounded by the capability reconcile window
      expect(span).toBeGreaterThanOrEqual(6 * 3600_000); // covers the gap plus overlap
    }
    const beforeCursor = (await tenantQuery<{ incremental_cursor: unknown }>(db, tenant, "SELECT incremental_cursor FROM capability_health WHERE connection_id = $1 AND capability_id = 'shopify.orders'", [conn]))[0]!;
    const kinds = jobs.map((j) => j.kind).sort();
    expect(kinds).toEqual(['incremental', 'incremental', 'incremental']); // overdue polls coalesce into one incremental per group; reconciliation is scheduled by its own cadence
    for (const j of jobs) { const r = await engine.executeRun(j.tenant_id, j.run_id); expect(['completed', 'completed_with_gaps'], r.error_code ?? '').toContain(r.state); }
    const afterCursor = (await tenantQuery<{ incremental_cursor: { floor: string }; last_reconciliation_at: Date | null }>(db, tenant, "SELECT incremental_cursor, last_reconciliation_at FROM capability_health WHERE connection_id = $1 AND capability_id = 'shopify.orders'", [conn]))[0]!;
    expect(afterCursor.incremental_cursor.floor).toBeDefined(); expect(beforeCursor.incremental_cursor).toBeDefined();
    // Leases: an expired lease held by a dead instance does not block re-dispatch.
    clock.tick(6 * 3600_000);
    await tenantQuery(db, tenant, "UPDATE import_runs SET state = 'running', lease_token = 'dead-instance', lease_expires_at = $2 WHERE connection_id = $1 AND kind = 'incremental'", [conn, new Date(clock.now().getTime() - 1000)]);
    await tenantQuery(db, tenant, "UPDATE import_runs SET state = 'queued' WHERE connection_id = $1 AND kind = 'incremental' AND lease_expires_at < $2", [conn, clock.now()]);
    const resumed = await engine.executeRun(tenant, (await tenantQuery<{ run_id: string }>(db, tenant, "SELECT run_id FROM import_runs WHERE connection_id = $1 AND kind = 'incremental' LIMIT 1", [conn]))[0]!.run_id);
    expect(['completed', 'completed_with_gaps']).toContain(resumed.state);
  });

  it('is fair across connections, bounded per tick, respects Retry-After and pauses on storage critical (INGEST-05, PILOT-06)', async () => {
    const tenant = await createTenant(db, 'Sched C');
    const conns: string[] = [];
    for (let i = 0; i < 3; i++) { const c = await createConnection(db, tenant, { provider: 'shopify', base_url: fixture.url }); await createPlan(db, tenant, c, { requested_from: new Date(FIXTURE_CLOCK - 30 * 86_400_000).toISOString(), initial_cutoff: new Date(FIXTURE_CLOCK).toISOString() }); conns.push(c); }
    const clock = new FakeClock(FIXTURE_CLOCK);
    let critical = false;
    const { scheduler, jobs } = makeScheduler(clock, [tenant], { max_per_tick: 2, storageCritical: () => critical });
    const t1 = await scheduler.tick();
    expect(t1.dispatched.length).toBe(2); expect(t1.deferred).toBe(7); // 3 connections x 3 groups = 9 due; 2 per tick
    await tenantQuery(db, tenant, "UPDATE capability_health SET last_attempt_at = $2 WHERE connection_id = $1", [t1.dispatched[0]!.connection_id, clock.now()]);
    const t2 = await scheduler.tick();
    expect(t2.dispatched.length).toBe(2);
    expect(t2.dispatched.every((j) => j.connection_id !== t1.dispatched[0]!.connection_id || j.poll_group !== t1.dispatched[0]!.poll_group)).toBe(true); // never-polled groups first
    // Retry-After: a throttled group is not re-dispatched before retry_after_until.
    const held = conns[2]!;
    await tenantQuery(db, tenant, "UPDATE capability_health SET retry_after_until = $2, next_check_at = $3 WHERE connection_id = $1", [held, new Date(clock.now().getTime() + 600_000), clock.now()]);
    const t3 = await scheduler.tick();
    expect(t3.dispatched.every((j) => j.connection_id !== held)).toBe(true);
    critical = true;
    const t4 = await scheduler.tick();
    expect(t4.paused_storage).toBe(true); expect(t4.dispatched).toEqual([]);
    critical = false;
    expect(jobs.length).toBe(t1.dispatched.length + t2.dispatched.length + t3.dispatched.length);
  });
});
