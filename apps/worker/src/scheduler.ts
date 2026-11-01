/**
 * Per-connection capability scheduler. One tick:
 *   1. compare wall-clock with monotonic time; a gap >= threshold is a suspension (sleep/wake, clock change)
 *   2. enumerate tenants, then per tenant (RLS-scoped): ensure health rows, pick queued runs (API-created
 *      backfill/check/reconcile), create incremental runs for due poll groups and reconciliation runs when due
 *   3. fairness: candidates ordered by last_attempt_at (never-polled first), bounded per tick; one active job
 *      per (connection, poll group) via the dispatcher's singleton key
 * After a suspension every overdue group gets exactly one coalesced job, spread over wake_spread_ms,
 * plus one bounded overlap reconciliation covering min(gap, reconcile_window). No burst replay.
 */
import type pg from 'pg';
import { capabilitiesFor, pollGroupOf, withInstallation, withTenant } from '@blackbox/connectors';
import type { Clock } from './clock.js';
import { suspensionDetector, type SuspensionDetector } from './clock.js';
import type { Logger } from './logger.js';
import type { SyncEngine } from './sync.js';

export interface ScheduledJob { tenant_id: string; connection_id: string; run_id: string; poll_group: string; kind: string; start_after_ms: number }
export type Dispatcher = (job: ScheduledJob) => Promise<void>;

export interface SchedulerDeps {
  pool: pg.Pool; engine: SyncEngine; logger: Logger; clock: Clock; dispatch: Dispatcher;
  max_per_tick: number; wake_spread_ms: number; suspension_threshold_ms: number; lease_seconds: number;
  storageCritical: () => boolean;
  /** Test hook: restrict scheduling to these tenants (production schedules every workspace). */
  only_tenants?: string[];
}

const ACTIVE_STATES = ['configured', 'validating', 'backfilling', 'catching_up', 'ready', 'degraded'];

export interface TickResult { suspended: boolean; gap_ms: number; dispatched: ScheduledJob[]; deferred: number; paused_storage: boolean }

export class Scheduler {
  private readonly detector: SuspensionDetector;
  constructor(private readonly deps: SchedulerDeps) { this.detector = suspensionDetector(deps.suspension_threshold_ms); }

  async tick(): Promise<TickResult> {
    const obs = this.detector.observe(this.deps.clock);
    const now = obs.wall_now;
    if (obs.suspended) this.deps.logger.log('warn', 'worker.suspension_detected', 'wall clock moved relative to monotonic time; coalescing overdue work', { duration_ms: obs.gap_ms, action_code: 'coalesce' });
    if (this.deps.storageCritical()) {
      this.deps.logger.log('warn', 'worker.scheduler_paused', 'storage critical: no new fetch jobs scheduled', { error_code: 'storage_critical' });
      return { suspended: obs.suspended, gap_ms: obs.gap_ms, dispatched: [], deferred: 0, paused_storage: true };
    }
    let tenants = await withInstallation(this.deps.pool, async (client) => (await client.query<{ tenant_id: string }>('SELECT tenant_id FROM tenants ORDER BY created_at')).rows.map((r) => r.tenant_id));
    if (this.deps.only_tenants) tenants = tenants.filter((t) => this.deps.only_tenants!.includes(t));
    const candidates: Array<ScheduledJob & { last_attempt_at: number }> = [];
    for (const tenant_id of tenants) {
      await withTenant(this.deps.pool, tenant_id, async (client) => {
        const conns = await client.query<{ connection_id: string; provider: string; account_ref: string | null; status: string; config_json: Record<string, unknown>; secret_ciphertext: Buffer | null; secret_key_version: number | null; disconnected_at: string | null }>(
          'SELECT connection_id, provider, account_ref, status, config_json, secret_ciphertext, secret_key_version, disconnected_at FROM connections WHERE disconnected_at IS NULL AND status = ANY($1)', [ACTIVE_STATES]);
        for (const conn of conns.rows) await this.deps.engine.ensureHealthRows(client, tenant_id, conn);
        // 1. Queued runs created by the API or by a previous yield/retry (lease expired or absent).
        const queued = await client.query<{ run_id: string; connection_id: string; kind: string; checkpoint: { poll_group?: string }; updated_at: Date }>(
          `SELECT r.run_id, r.connection_id, r.kind, r.checkpoint, r.updated_at FROM import_runs r JOIN connections c ON c.connection_id = r.connection_id
           WHERE r.state = 'queued' AND (r.lease_expires_at IS NULL OR r.lease_expires_at < $1) AND c.disconnected_at IS NULL AND c.status = ANY($2) ORDER BY r.updated_at`, [now, ACTIVE_STATES]);
        for (const r of queued.rows) candidates.push({ tenant_id, connection_id: r.connection_id, run_id: r.run_id, poll_group: r.checkpoint.poll_group ?? r.kind, kind: r.kind, start_after_ms: 0, last_attempt_at: 0 });
        // 2. Due incremental polls and reconciliations (one per poll group), skipping groups with an open run.
        const due = await client.query<{ connection_id: string; provider: string; capability_id: string; poll_group: string; next_check_at: Date | null; next_reconciliation_at: Date | null; last_attempt_at: Date | null; retry_after_until: Date | null }>(
          `SELECT h.connection_id, c.provider, h.capability_id, h.poll_group, h.next_check_at, h.next_reconciliation_at, h.last_attempt_at, h.retry_after_until
           FROM capability_health h JOIN connections c ON c.connection_id = h.connection_id
           WHERE c.disconnected_at IS NULL AND c.status = ANY($2) AND h.method = 'polling' AND h.status <> 'paused'
             AND ((h.next_check_at IS NOT NULL AND h.next_check_at <= $1) OR (h.next_reconciliation_at IS NOT NULL AND h.next_reconciliation_at <= $1))
             AND (h.retry_after_until IS NULL OR h.retry_after_until <= $1)
             AND NOT EXISTS (SELECT 1 FROM import_runs r WHERE r.connection_id = h.connection_id AND r.state IN ('queued','running') AND r.checkpoint->>'poll_group' = h.poll_group)
           ORDER BY h.last_attempt_at NULLS FIRST`, [now, ACTIVE_STATES]);
        const seen = new Set<string>();
        for (const h of due.rows) {
          const key = `${h.connection_id}:${h.poll_group}`;
          if (seen.has(key)) continue; seen.add(key);
          const reconcileDue = h.next_reconciliation_at && h.next_reconciliation_at.getTime() <= now.getTime();
          const cap = capabilitiesFor(h.provider).find((c) => c.id === h.capability_id)!;
          const kind = reconcileDue ? 'reconcile' : 'incremental';
          const window = reconcileDue ? this.reconcileWindow(now, obs.suspended ? obs.gap_ms : 0, cap.schedule.reconcile_window_s ?? 86_400, cap.schedule.overlap_s) : null;
          const run_id = await this.deps.engine.createRun(tenant_id, h.connection_id, kind, h.poll_group, { window });
          candidates.push({ tenant_id, connection_id: h.connection_id, run_id, poll_group: h.poll_group, kind, start_after_ms: 0, last_attempt_at: h.last_attempt_at?.getTime() ?? 0 });
        }
        // After a suspension, add one bounded overlap reconciliation for groups that were not already due.
        if (obs.suspended && obs.gap_ms > 0) {
          const groups = await client.query<{ connection_id: string; provider: string; capability_id: string; poll_group: string }>(
            `SELECT DISTINCT ON (h.connection_id, h.poll_group) h.connection_id, c.provider, h.capability_id, h.poll_group FROM capability_health h JOIN connections c ON c.connection_id = h.connection_id
             WHERE c.disconnected_at IS NULL AND c.status = ANY($1) AND h.method = 'polling' AND h.status <> 'paused' AND h.last_successful_check_at IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM import_runs r WHERE r.connection_id = h.connection_id AND r.state IN ('queued','running') AND r.checkpoint->>'poll_group' = h.poll_group)`, [ACTIVE_STATES]);
          for (const g of groups.rows) {
            if (seen.has(`${g.connection_id}:${g.poll_group}`)) continue; seen.add(`${g.connection_id}:${g.poll_group}`);
            const cap = capabilitiesFor(g.provider).find((c) => c.id === g.capability_id)!;
            const run_id = await this.deps.engine.createRun(tenant_id, g.connection_id, 'reconcile', g.poll_group, { window: this.reconcileWindow(now, obs.gap_ms, cap.schedule.reconcile_window_s ?? 86_400, cap.schedule.overlap_s) });
            candidates.push({ tenant_id, connection_id: g.connection_id, run_id, poll_group: g.poll_group, kind: 'reconcile', start_after_ms: 0, last_attempt_at: 0 });
          }
        }
      });
    }
    // Fairness: never-polled first, then oldest attempt; bounded per tick; spread after wake.
    candidates.sort((a, b) => a.last_attempt_at - b.last_attempt_at);
    const spread = obs.suspended ? this.deps.wake_spread_ms : 0;
    const selected = candidates.slice(0, this.deps.max_per_tick);
    const dispatched: ScheduledJob[] = [];
    for (const [i, job] of selected.entries()) {
      const { last_attempt_at: _ignored, ...plain } = job;
      plain.start_after_ms = i * spread;
      // Dispatch lease: a queued run handed to the job queue is not re-dispatched until the lease expires
      // (an undelivered job is simply picked up again after lease_seconds). executeRun replaces the lease.
      await withTenant(this.deps.pool, job.tenant_id, (client) => client.query("UPDATE import_runs SET lease_token = $2, lease_expires_at = $3, updated_at = now() WHERE run_id = $1 AND state = 'queued'",
        [job.run_id, `dispatched:${job.poll_group}`, new Date(now.getTime() + this.deps.lease_seconds * 1000 + plain.start_after_ms)]));
      await this.deps.dispatch(plain);
      dispatched.push(plain);
    }
    const deferred = candidates.length - selected.length;
    if (dispatched.length || deferred) this.deps.logger.log('info', 'worker.scheduler_tick', `dispatched ${dispatched.length} run(s), ${deferred} deferred to the next tick`, { record_count: dispatched.length });
    return { suspended: obs.suspended, gap_ms: obs.gap_ms, dispatched, deferred, paused_storage: false };
  }

  /** Bounded overlap window: covers the suspension gap plus overlap, capped at the capability's reconcile window. */
  reconcileWindow(now: Date, gap_ms: number, window_s: number, overlap_s: number): { from: string; to: string } {
    const span = Math.min(Math.max(gap_ms, 0) + overlap_s * 1000, window_s * 1000);
    return { from: new Date(now.getTime() - span).toISOString(), to: now.toISOString() };
  }
}

export function groupsOf(provider: string): string[] {
  return [...new Set(capabilitiesFor(provider).filter((c) => c.modes.local_standalone.methods.includes('polling')).map((c) => pollGroupOf(provider, c.id)))];
}
