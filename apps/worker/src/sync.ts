/**
 * Sync engine: executes import runs (backfill, incremental, reconcile, check) page by page.
 * Every page is one tenant transaction: ingest -> run counters/checkpoint -> capability health
 * -> COMMIT; the batch is only logged/acknowledged after COMMIT. A failed page never advances the
 * checkpoint. Storage-critical pauses before the next fetch and keeps the checkpoint.
 */
import type pg from 'pg';
import {
  capabilitiesFor, createAdapter, ingestObservations, openSecret, pollGroupOf, withTenant,
  CredentialError, CursorExpiredError, PollingUnsupportedError, ProviderUnavailableError, ThrottledError,
  type BackfillPlan, type CapabilityDeclaration, type CredentialCheck, type Cursor, type EvidenceStore, type Page, type SecretKeyring, type SourceAdapter,
} from '@blackbox/connectors';
import type { Clock } from './clock.js';
import type { Logger } from './logger.js';
import type { StorageState } from './storage.js';

export interface SyncDeps {
  pool: pg.Pool;
  logger: Logger;
  clock: Clock;
  evidence: EvidenceStore;
  keyring: SecretKeyring | null;
  storage: () => Promise<StorageState>;
  lease_seconds: number;
  max_pages_per_job: number;
  instance_id: string;
  /** Test hook: build an adapter instead of the registry (e.g. to inject fetch/sleep). */
  adapterFactory?: (provider: string, config: Record<string, unknown>, secret: Record<string, unknown> | null, account_ref: string | null) => SourceAdapter;
}

export type RunKind = 'backfill' | 'incremental' | 'reconcile' | 'check';

export interface RunResult {
  run_id: string;
  state: 'completed' | 'completed_with_gaps' | 'paused' | 'failed' | 'queued';
  pages: number;
  counters: { requested: number; loaded: number; committed: number; duplicates: number; conflicts: number; rejected: number; failed: number; applied: number };
  totals_known: boolean;
  committed_cursor: number | null;
  error_code: string | null;
}

interface RunRow { lease_token: string | null; lease_expires_at: string | null; run_id: string; connection_id: string; plan_id: string | null; kind: RunKind; state: string; phase: string; checkpoint: Record<string, unknown>; attempt: number; capability_scope: string[]; requested: string; loaded: string; committed: string; duplicates: string; conflicts: string; rejected: string; failed: string; applied: string; totals_known: boolean; pages: number; committed_cursor: string | null; coverage_from: string | null; coverage_to: string | null }
interface ConnectionRow { connection_id: string; provider: string; account_ref: string | null; status: string; config_json: Record<string, unknown>; secret_ciphertext: Buffer | null; secret_key_version: number | null; disconnected_at: string | null }
interface PlanRow { plan_id: string; plan_revision: number; preset: string; timezone: string; requested_from: string | null; initial_cutoff: string; include_open_context: boolean; include_opening_state: boolean; strict_from_now: boolean }

export class SyncEngine {
  constructor(private readonly deps: SyncDeps) {}

  /** Creates a run row (queued). The API creates backfill runs the same way; the scheduler creates incremental/reconcile runs. */
  async createRun(tenant_id: string, connection_id: string, kind: RunKind, poll_group: string, extra: { plan_id?: string | null; window?: { from: string; to: string } | null } = {}): Promise<string> {
    return withTenant(this.deps.pool, tenant_id, async (client) => {
      const conn = await client.query<{ provider: string }>('SELECT provider FROM connections WHERE connection_id = $1', [connection_id]);
      if (!conn.rows[0]) throw new Error('connection not found in this workspace');
      const scope = capabilitiesFor(conn.rows[0].provider).filter((c) => pollGroupOf(conn.rows[0]!.provider, c.id) === poll_group).map((c) => c.id);
      const plan = extra.plan_id ?? (await client.query<{ plan_id: string }>('SELECT plan_id FROM import_plans WHERE connection_id = $1 AND superseded_at IS NULL ORDER BY plan_revision DESC LIMIT 1', [connection_id])).rows[0]?.plan_id ?? null;
      const checkpoint = { poll_group, cursor: null as Cursor | null, window: extra.window ?? null };
      const r = await client.query<{ run_id: string }>(
        `INSERT INTO import_runs (tenant_id, connection_id, plan_id, kind, state, phase, checkpoint, capability_scope, coverage_from, coverage_to)
         VALUES ($1, $2, $3, $4, 'queued', 'check_connection', $5, $6, $7, $8) RETURNING run_id`,
        [tenant_id, connection_id, plan, kind, JSON.stringify(checkpoint), JSON.stringify(scope), extra.window?.from ?? null, extra.window?.to ?? null]);
      return r.rows[0]!.run_id;
    });
  }

  async credentialCheck(tenant_id: string, connection_id: string): Promise<CredentialCheck> {
    const { connection, adapter } = await this.loadConnection(tenant_id, connection_id);
    const log = this.deps.logger.child({ tenant_id, connection_id });
    const now = this.deps.clock.now();
    let check: CredentialCheck;
    try { check = await adapter.checkCredentials(); }
    catch (err) {
      const code = (err as { code?: string }).code ?? 'check_failed';
      await withTenant(this.deps.pool, tenant_id, async (client) => {
        await client.query("UPDATE connections SET status = CASE WHEN $2 IN ('unauthorized','token_expired') THEN 'reauthorization_required' ELSE 'degraded' END, updated_at = now() WHERE connection_id = $1", [connection_id, code]);
        await client.query('UPDATE capability_health SET last_attempt_at = $2, last_error_code = $3, last_error_at = $2, status = $4, consecutive_failures = consecutive_failures + 1, updated_at = now() WHERE connection_id = $1', [connection_id, now, code, code === 'provider_unavailable' ? 'unavailable' : 'degraded']);
      });
      log.log('warn', 'source.check_failed', 'credential check failed', { error_code: code, retryable: Boolean((err as { retryable?: boolean }).retryable) });
      throw err;
    }
    await withTenant(this.deps.pool, tenant_id, async (client) => {
      if (check.ok && check.account_ref && !connection.account_ref) {
        await client.query('UPDATE connections SET account_ref = $2, updated_at = now() WHERE connection_id = $1', [connection_id, check.account_ref]);
      }
      const status = !check.ok ? (check.error_code === 'account_mismatch' ? 'reauthorization_required' : 'blocked') : check.missing_grants.length ? 'degraded' : connection.status === 'configured' || connection.status === 'validating' ? 'validating' : connection.status;
      await client.query('UPDATE connections SET status = $2, updated_at = now() WHERE connection_id = $1', [connection_id, status]);
      await this.ensureHealthRows(client, tenant_id, connection);
      // A credential check is an attempt, never a successful full-scope sync (HEALTH-01).
      await client.query('UPDATE capability_health SET last_attempt_at = $2, missing_grants = $3::jsonb, last_error_code = $4, updated_at = now() WHERE connection_id = $1', [connection_id, now, JSON.stringify(check.missing_grants), check.ok ? null : check.error_code]);
      const missing = new Set(check.missing_grants);
      for (const cap of adapter.capabilities) {
        if (!check.blocked_capabilities.includes(cap.id) || !cap.required_grants.some((g) => missing.has(g))) continue; // unsupported capabilities keep their own no-poll reason
        await client.query("UPDATE capability_health SET status = 'degraded', next_check_at = NULL, next_check_reason = 'missing_grant', next_action = 'grant the required scope and re-check', updated_at = now() WHERE connection_id = $1 AND capability_id = $2", [connection_id, cap.id]);
      }
    });
    log.log(check.ok ? 'info' : 'warn', 'source.check_completed', check.ok ? 'credential check passed' : 'credential check reported a blocker', { error_code: check.error_code, record_count: check.missing_grants.length });
    return check;
  }

  /** Executes (or resumes) a run. maxPages bounds one job attempt; the run resumes from its checkpoint next time. */
  async executeRun(tenant_id: string, run_id: string, opts: { maxPages?: number; attempt?: number } = {}): Promise<RunResult> {
    const maxPages = opts.maxPages ?? this.deps.max_pages_per_job;
    const lease = `${this.deps.instance_id}:${run_id}:${this.deps.clock.monotonicMs()}`;
    const leaseExpiry = new Date(this.deps.clock.now().getTime() + this.deps.lease_seconds * 1000);
    const run = await withTenant(this.deps.pool, tenant_id, async (client) => {
      const r = await client.query<RunRow>('SELECT * FROM import_runs WHERE run_id = $1 FOR UPDATE', [run_id]);
      const row = r.rows[0];
      if (!row) throw new Error('run not found in this workspace');
      if (!['queued', 'running', 'paused'].includes(row.state)) throw new Error(`run ${run_id} is ${row.state}`);
      if (row.state === 'running' && row.lease_token && row.lease_expires_at && new Date(row.lease_expires_at).getTime() > this.deps.clock.now().getTime()) {
        throw Object.assign(new Error('run is leased by another worker instance'), { code: 'run_leased', retryable: true });
      }
      await client.query(`UPDATE import_runs SET state = 'running', phase = CASE WHEN phase IN ('check_connection','paused') THEN 'import_records' ELSE phase END, started_at = COALESCE(started_at, $2), updated_at = now(), lease_token = $3, lease_expires_at = $4, attempt = $5 WHERE run_id = $1`, [run_id, this.deps.clock.now(), lease, leaseExpiry, opts.attempt ?? row.attempt]);
      return row;
    });
    const connection_id = run.connection_id;
    const log = this.deps.logger.child({ tenant_id, connection_id, run_id, attempt: opts.attempt ?? run.attempt });
    const poll_group = String(run.checkpoint.poll_group ?? '');
    const capability_id = run.capability_scope[0];
    if (!capability_id) throw new Error('run has no capability scope');
    const counters = { requested: Number(run.requested), loaded: Number(run.loaded), committed: Number(run.committed), duplicates: Number(run.duplicates), conflicts: Number(run.conflicts), rejected: Number(run.rejected), failed: Number(run.failed), applied: Number(run.applied) };
    let pages = run.pages; let totals_known = run.totals_known; let committed_cursor = run.committed_cursor ? Number(run.committed_cursor) : null;
    let cursor = (run.checkpoint.cursor as Cursor | null) ?? null;
    const window = run.checkpoint.window as { from: string; to: string } | null;

    const { connection, adapter, plan } = await this.loadConnection(tenant_id, connection_id);
    const capability = adapter.capabilities.find((c) => c.id === capability_id);
    if (!capability) throw new Error(`capability ${capability_id} unknown for ${connection.provider}`);
    const scope = run.capability_scope;
    const observation_mode = run.kind === 'backfill' ? 'backfill' : run.kind === 'reconcile' ? 'reconcile' : 'live';

    if (run.kind === 'check') {
      const check = await this.credentialCheck(tenant_id, connection_id);
      await withTenant(this.deps.pool, tenant_id, (client) => client.query(`UPDATE import_runs SET state = $2, phase = 'ready', finished_at = $3, updated_at = now(), outcome = $4, error_code = $5, lease_token = NULL WHERE run_id = $1`, [run_id, check.ok ? 'completed' : 'failed', this.deps.clock.now(), check.ok ? 'credentials_valid' : check.error_code, check.ok ? null : check.error_code]));
      return { run_id, state: check.ok ? 'completed' : 'failed', pages: 0, counters, totals_known: true, committed_cursor, error_code: check.ok ? null : check.error_code };
    }

    let backfillPlan: BackfillPlan | null = null;
    if (run.kind === 'backfill') {
      if (!plan) throw Object.assign(new Error('no import plan for this connection'), { code: 'no_import_plan', retryable: false });
      backfillPlan = { plan_id: plan.plan_id, plan_revision: plan.plan_revision, requested_from: plan.requested_from ?? plan.initial_cutoff, initial_cutoff: plan.initial_cutoff, include_open_items: plan.include_open_context, include_related_records: plan.include_open_context, include_opening_state: plan.include_opening_state, strict_from_now: plan.strict_from_now, timezone: plan.timezone };
    }
    if (run.kind === 'incremental' && !cursor) cursor = await this.loadIncrementalCursor(tenant_id, connection_id, capability_id, capability, plan);

    let pagesThisJob = 0;
    try {
      for (;;) {
        const storage = await this.deps.storage();
        if (storage.state === 'critical') {
          await withTenant(this.deps.pool, tenant_id, async (client) => {
            await client.query(`UPDATE import_runs SET state = 'paused', phase = 'paused', updated_at = now(), next_action = 'free_disk_space', error_code = 'storage_critical', lease_token = NULL WHERE run_id = $1`, [run_id]);
            await client.query(`UPDATE capability_health SET status = 'paused', next_check_at = NULL, next_check_reason = 'storage_critical', next_action = 'free disk space; fetch resumes automatically above the critical threshold', updated_at = now() WHERE connection_id = $1 AND capability_id = ANY($2)`, [connection_id, scope]);
          });
          log.log('warn', 'source.run_paused', 'storage critical: fetch paused, checkpoint retained', { action_code: 'free_disk_space', error_code: 'storage_critical' });
          return { run_id, state: 'paused', pages, counters, totals_known, committed_cursor, error_code: 'storage_critical' };
        }
        if (pagesThisJob >= maxPages) {
          await withTenant(this.deps.pool, tenant_id, (client) => client.query(`UPDATE import_runs SET state = 'queued', updated_at = now(), lease_token = NULL, next_action = 'resume' WHERE run_id = $1`, [run_id]));
          log.log('info', 'source.run_yielded', 'page budget reached; run re-queued with checkpoint', { record_count: pages });
          return { run_id, state: 'queued', pages, counters, totals_known, committed_cursor, error_code: null };
        }
        const started = this.deps.clock.monotonicMs();
        let page: Page;
        try {
          page = run.kind === 'backfill' ? await adapter.backfill(capability_id, backfillPlan!, cursor)
            : run.kind === 'reconcile' ? await adapter.reconcile(capability_id, window ?? this.defaultWindow(capability), cursor)
            : await adapter.incremental(capability_id, cursor, this.deps.clock.now());
        } catch (err) {
          if (err instanceof CursorExpiredError) {
            // Expired/invalid provider cursor: restart the current phase from its floor; nothing committed is lost.
            log.log('warn', 'source.cursor_expired', 'provider cursor expired; restarting phase from floor', { error_code: 'cursor_expired', retryable: true });
            cursor = cursor ? { ...cursor, after: null } : null;
            await withTenant(this.deps.pool, tenant_id, (client) => client.query('UPDATE import_runs SET checkpoint = checkpoint || $2::jsonb, updated_at = now() WHERE run_id = $1', [run_id, JSON.stringify({ cursor })]));
            continue;
          }
          throw err;
        }
        const duration = this.deps.clock.monotonicMs() - started;
        const outcome = await withTenant(this.deps.pool, tenant_id, async (client) => {
          const result = await ingestObservations(client, { tenant_id, connection_id, provider: connection.provider, account_ref: connection.account_ref, run_id, observation_mode, evidence: this.deps.evidence }, page.observations);
          counters.loaded += page.loaded_records; counters.committed += result.new_record_ids.length; counters.duplicates += result.duplicate; counters.conflicts += result.conflict; counters.rejected += result.rejected + page.rejected.length;
          if (page.total_records !== null) { counters.requested += page.total_records; totals_known = run.kind === 'backfill'; } else if (run.kind !== 'backfill') totals_known = false;
          if (result.committed_cursor !== null) committed_cursor = Math.max(committed_cursor ?? 0, result.committed_cursor);
          const applied = await client.query<{ applied_sequence: string }>('SELECT applied_sequence FROM engine_checkpoints WHERE tenant_id = $1', [tenant_id]);
          if (applied.rows[0] && committed_cursor !== null && Number(applied.rows[0].applied_sequence) >= committed_cursor) counters.applied = counters.committed;
          pages++; cursor = page.next_cursor;
          for (const rej of [...page.rejected, ...result.rejected_inputs]) {
            await client.query(`INSERT INTO worker_dead_letters (tenant_id, connection_id, capability_id, run_id, job_name, reason_code, detail, provider_ref, payload) VALUES ($1, $2, $3, $4, 'source.run', $5, $6, $7, $8)`,
              [tenant_id, connection_id, capability_id, run_id, rej.reason_code, rej.detail.slice(0, 500), rej.provider_ref, JSON.stringify({ dataset: rej.dataset })]);
          }
          await client.query(`UPDATE import_runs SET requested = $2, loaded = $3, committed = $4, duplicates = $5, conflicts = $6, rejected = $7, applied = $8, totals_known = $9, pages = $10, checkpoint = checkpoint || $11::jsonb, committed_cursor = $12, updated_at = now(), lease_expires_at = $13 WHERE run_id = $1`,
            [run_id, counters.requested, counters.loaded, counters.committed, counters.duplicates, counters.conflicts, counters.rejected, counters.applied, totals_known, pages, JSON.stringify({ cursor }), committed_cursor, new Date(this.deps.clock.now().getTime() + this.deps.lease_seconds * 1000)]);
          const now = this.deps.clock.now();
          const cursorColumn = run.kind === 'backfill' ? 'backfill_cursor' : run.kind === 'reconcile' ? 'reconciliation_cursor' : 'incremental_cursor';
          await client.query(`UPDATE capability_health SET last_attempt_at = $3, status = 'working', ${cursorColumn} = $4::jsonb, throttle_status = $5::jsonb,
              last_journal_commit_at = CASE WHEN $6 > 0 THEN $3 ELSE last_journal_commit_at END,
              last_new_event_at = CASE WHEN $6 > 0 THEN $3 ELSE last_new_event_at END,
              pending_count = 0, updated_at = now() WHERE connection_id = $1 AND capability_id = ANY($2)`,
            [connection_id, scope, now, JSON.stringify(cursor), page.throttle ? JSON.stringify(page.throttle) : null, result.accepted]);
          return result;
        });
        pagesThisJob++;
        log.log('info', 'journal.batch_committed', 'page committed', { duration_ms: duration, record_count: outcome.accepted, committed_cursor: outcome.committed_cursor ?? committed_cursor ?? undefined, journal_batch_id: `${run_id}:${pages}` });
        if (outcome.conflict) log.log('warn', 'source.conflict_observed', 'same provider identity with different content; review case opened', { record_count: outcome.conflict });
        if (page.rejected.length || outcome.rejected) log.log('warn', 'source.input_rejected', 'inputs recorded as unsupported/missing (dead letters)', { record_count: page.rejected.length + outcome.rejected, error_code: 'input_rejected' });
        if (page.done) break;
      }
    } catch (err) {
      return this.failRun(tenant_id, run, scope, capability, err, log, counters, pages, totals_known, committed_cursor);
    }
    // Completed: full-scope success advances last_successful_check_at (never on failure/partial).
    const gaps = counters.rejected > 0 || counters.conflicts > 0;
    const now = this.deps.clock.now();
    await withTenant(this.deps.pool, tenant_id, async (client) => {
      await client.query(`UPDATE import_runs SET state = $2, phase = 'link_and_process', finished_at = $3, updated_at = now(), outcome = $4, lease_token = NULL, next_action = NULL, coverage_from = COALESCE(coverage_from, $5), coverage_to = COALESCE(coverage_to, $6) WHERE run_id = $1`,
        [run_id, gaps ? 'completed_with_gaps' : 'completed', now, gaps ? 'completed_with_gaps' : 'completed', backfillPlan?.requested_from ?? null, backfillPlan?.initial_cutoff ?? null]);
      const sched = capability.schedule;
      const jitter = sched.jitter_s ? Math.floor(Math.random() * sched.jitter_s * 1000) : 0;
      const next = sched.interval_s ? new Date(now.getTime() + sched.interval_s * 1000 + jitter) : null;
      const base = `last_attempt_at = $3, last_successful_check_at = $3, status = $4, consecutive_failures = 0, last_error_code = NULL, retry_after_until = NULL, next_check_at = $5, next_check_reason = $6, next_action = NULL, updated_at = now()`;
      if (run.kind === 'backfill') {
        const historyKind = capability.dataset === 'stock' || capability.dataset === 'positions' ? 'snapshot_only' : 'event_history';
        await client.query(`UPDATE capability_health SET ${base}, coverage_from = $7, coverage_to = $8, history_kind = $9, coverage_state = $10, backfill_cursor = NULL, backfill_run_id = $11,
            incremental_cursor = COALESCE(incremental_cursor, $12::jsonb), next_reconciliation_at = COALESCE(next_reconciliation_at, $13) WHERE connection_id = $1 AND capability_id = ANY($2)`,
          [connection_id, scope, now, gaps ? 'degraded' : 'healthy', next, next ? 'scheduled' : sched.no_poll_reason, backfillPlan!.requested_from, backfillPlan!.initial_cutoff, historyKind, gaps ? 'partial' : 'complete_for_declared_scope', run_id,
            JSON.stringify(this.seedIncrementalCursor(backfillPlan!, capability)), sched.reconcile_every_s ? new Date(now.getTime() + sched.reconcile_every_s * 1000) : null]);
      } else if (run.kind === 'reconcile') {
        await client.query(`UPDATE capability_health SET ${base}, last_reconciliation_at = $3, reconciliation_cursor = NULL, next_reconciliation_at = $7 WHERE connection_id = $1 AND capability_id = ANY($2)`,
          [connection_id, scope, now, gaps ? 'degraded' : 'healthy', next, next ? 'scheduled' : sched.no_poll_reason, sched.reconcile_every_s ? new Date(now.getTime() + sched.reconcile_every_s * 1000) : null]);
      } else {
        await client.query(`UPDATE capability_health SET ${base}, coverage_to = GREATEST(COALESCE(coverage_to, $3), $3) WHERE connection_id = $1 AND capability_id = ANY($2)`, [connection_id, scope, now, gaps ? 'degraded' : 'healthy', next, next ? 'scheduled' : sched.no_poll_reason]);
      }
      if (run.kind === 'backfill') await client.query("UPDATE connections SET status = CASE WHEN status IN ('configured','validating','backfilling') THEN 'catching_up' ELSE status END, updated_at = now() WHERE connection_id = $1", [connection_id]);
      else await client.query("UPDATE connections SET status = CASE WHEN status IN ('catching_up','validating') THEN 'ready' ELSE status END, updated_at = now() WHERE connection_id = $1", [connection_id]);
    });
    log.log('info', 'source.run_completed', `${run.kind} run ${gaps ? 'completed with gaps' : 'completed'}`, { record_count: counters.committed, committed_cursor: committed_cursor ?? undefined });
    return { run_id, state: gaps ? 'completed_with_gaps' : 'completed', pages, counters, totals_known, committed_cursor, error_code: null };
  }

  private seedIncrementalCursor(plan: BackfillPlan, capability: CapabilityDeclaration): Cursor {
    const overlap = (capability.schedule.overlap_s ?? 0) * 1000;
    const floor = plan.strict_from_now ? plan.initial_cutoff : new Date(Date.parse(plan.initial_cutoff) - overlap).toISOString();
    return { phase: 'window', after: null, floor, ceiling: null, max_seen: null, pages: 0 };
  }

  private async loadIncrementalCursor(tenant_id: string, connection_id: string, capability_id: string, capability: CapabilityDeclaration, plan: PlanRow | null): Promise<Cursor | null> {
    const stored = await withTenant(this.deps.pool, tenant_id, async (client) => (await client.query<{ incremental_cursor: Cursor | null }>('SELECT incremental_cursor FROM capability_health WHERE connection_id = $1 AND capability_id = $2', [connection_id, capability_id])).rows[0]?.incremental_cursor ?? null);
    if (stored) return stored;
    if (plan) return this.seedIncrementalCursor({ plan_id: plan.plan_id, plan_revision: plan.plan_revision, requested_from: plan.requested_from ?? plan.initial_cutoff, initial_cutoff: plan.initial_cutoff, include_open_items: plan.include_open_context, include_related_records: plan.include_open_context, include_opening_state: plan.include_opening_state, strict_from_now: plan.strict_from_now, timezone: plan.timezone }, capability);
    return null;
  }

  private defaultWindow(capability: CapabilityDeclaration): { from: string; to: string } {
    const now = this.deps.clock.now();
    return { from: new Date(now.getTime() - (capability.schedule.reconcile_window_s ?? 86_400) * 1000).toISOString(), to: now.toISOString() };
  }

  private async failRun(tenant_id: string, run: RunRow, scope: string[], capability: CapabilityDeclaration, err: unknown, log: Logger, counters: RunResult['counters'], pages: number, totals_known: boolean, committed_cursor: number | null): Promise<RunResult> {
    const e = err as { code?: string; retryable?: boolean; retry_after_ms?: number | null; message: string };
    const code = e.code ?? 'run_failed';
    const retryable = e.retryable ?? !(err instanceof CredentialError || err instanceof PollingUnsupportedError);
    const now = this.deps.clock.now();
    const attempt = run.attempt;
    const backoffMs = Math.min((capability.schedule.max_interval_s ?? 3600) * 1000, Math.max(5000, (capability.schedule.interval_s ?? 300) * 1000 * 2 ** Math.min(attempt, 6)));
    const retryAfter = err instanceof ThrottledError ? new Date(now.getTime() + err.retry_after_ms) : err instanceof ProviderUnavailableError && err.retry_after_ms ? new Date(now.getTime() + err.retry_after_ms) : null;
    const nextCheck = retryable ? new Date(Math.max(now.getTime() + backoffMs, retryAfter?.getTime() ?? 0)) : null;
    await withTenant(this.deps.pool, tenant_id, async (client) => {
      await client.query(`UPDATE import_runs SET state = $2, updated_at = now(), error_code = $3, next_action = $4, lease_token = NULL, attempt = attempt + 1, failed = failed + 1, errors = errors || $5::jsonb, finished_at = CASE WHEN $2 = 'failed' THEN $6 ELSE finished_at END, outcome = CASE WHEN $2 = 'failed' THEN 'failed' ELSE outcome END WHERE run_id = $1`,
        [run.run_id, retryable ? 'queued' : 'failed', code, retryable ? 'retry' : (code === 'unauthorized' || code === 'token_expired' ? 'reauthorize' : 'inspect dead letter'), JSON.stringify([{ at: now.toISOString(), code, message: String(e.message).slice(0, 300), attempt }]), now]);
      await client.query(`UPDATE capability_health SET last_attempt_at = $3, status = $4, last_error_code = $5, last_error_at = $3, consecutive_failures = consecutive_failures + 1, retry_after_until = $6, next_check_at = $7, next_check_reason = $8, next_action = $9, failed_count = failed_count + 1, updated_at = now() WHERE connection_id = $1 AND capability_id = ANY($2)`,
        [run.connection_id, scope, now, err instanceof ProviderUnavailableError || err instanceof ThrottledError ? 'unavailable' : 'degraded', code, retryAfter, nextCheck, retryable ? 'backoff' : code, retryable ? `retry after backoff (attempt ${attempt + 1})` : (code === 'unauthorized' || code === 'token_expired' ? 'reconnect with valid credentials' : 'inspect dead letter')]);
      if (!retryable) await client.query(`INSERT INTO worker_dead_letters (tenant_id, connection_id, capability_id, run_id, job_name, reason_code, detail, attempts, payload) VALUES ($1, $2, $3, $4, 'source.run', $5, $6, $7, $8)`, [tenant_id, run.connection_id, capability.id, run.run_id, code, String(e.message).slice(0, 500), attempt, JSON.stringify({ kind: run.kind })]);
      if (err instanceof CredentialError && err.code !== 'forbidden') await client.query("UPDATE connections SET status = 'reauthorization_required', updated_at = now() WHERE connection_id = $1", [run.connection_id]);
    });
    log.log(retryable ? 'warn' : 'error', 'source.run_failed', retryable ? 'run failed; will retry from checkpoint' : 'run failed; dead-lettered', { error_code: code, retryable, next_retry_at: nextCheck?.toISOString() ?? undefined, action_code: retryable ? 'retry' : 'inspect_dead_letter' });
    return { run_id: run.run_id, state: retryable ? 'queued' : 'failed', pages, counters, totals_known, committed_cursor, error_code: code };
  }

  /** Inserts missing capability_health rows for a connection; next_check is null until a plan exists. */
  async ensureHealthRows(client: pg.PoolClient, tenant_id: string, connection: ConnectionRow): Promise<void> {
    const plan = await client.query<{ plan_id: string }>('SELECT plan_id FROM import_plans WHERE connection_id = $1 AND superseded_at IS NULL ORDER BY plan_revision DESC LIMIT 1', [connection.connection_id]);
    for (const cap of capabilitiesFor(connection.provider)) {
      const polls = cap.modes.local_standalone.methods.includes('polling');
      const reason = !polls ? cap.schedule.no_poll_reason ?? cap.modes.local_standalone.reason : !plan.rows[0] ? 'no_import_plan' : 'scheduled';
      await client.query(`INSERT INTO capability_health (tenant_id, connection_id, capability_id, status, poll_group, method, schedule_seconds, next_check_at, next_check_reason, limitations, history_kind)
         VALUES ($1, $2, $3, 'unknown', $4, $5, $6, $7, $8, $9::jsonb, $10) ON CONFLICT (connection_id, capability_id) DO NOTHING`,
        [tenant_id, connection.connection_id, cap.id, pollGroupOf(connection.provider, cap.id), cap.modes.local_standalone.methods[0] ?? null, cap.schedule.interval_s, polls && plan.rows[0] ? this.deps.clock.now() : null, reason, JSON.stringify(cap.limitations), cap.dataset === 'stock' || cap.dataset === 'positions' ? 'snapshot_only' : 'unknown']);
    }
  }

  private async loadConnection(tenant_id: string, connection_id: string): Promise<{ connection: ConnectionRow; adapter: SourceAdapter; plan: PlanRow | null }> {
    const { connection, plan } = await withTenant(this.deps.pool, tenant_id, async (client) => {
      const c = await client.query<ConnectionRow>('SELECT connection_id, provider, account_ref, status, config_json, secret_ciphertext, secret_key_version, disconnected_at FROM connections WHERE connection_id = $1', [connection_id]);
      if (!c.rows[0]) throw Object.assign(new Error('connection not found in this workspace'), { code: 'connection_not_found', retryable: false });
      if (c.rows[0].disconnected_at) throw Object.assign(new Error('connection is disconnected'), { code: 'disconnected', retryable: false });
      const p = await client.query<PlanRow>('SELECT plan_id, plan_revision, preset, timezone, requested_from, initial_cutoff, include_open_context, include_opening_state, strict_from_now FROM import_plans WHERE connection_id = $1 AND superseded_at IS NULL ORDER BY plan_revision DESC LIMIT 1', [connection_id]);
      await this.ensureHealthRows(client, tenant_id, c.rows[0]);
      return { connection: c.rows[0], plan: p.rows[0] ?? null };
    });
    let secret: Record<string, unknown> | null = null;
    if (connection.secret_ciphertext) {
      if (!this.deps.keyring) throw Object.assign(new Error('secret key not configured for the worker'), { code: 'secret_key_missing', retryable: false });
      secret = openSecret(connection.secret_ciphertext, connection.secret_key_version, this.deps.keyring, tenant_id);
    }
    const adapter = this.deps.adapterFactory ? this.deps.adapterFactory(connection.provider, connection.config_json, secret, connection.account_ref) : createAdapter(connection.provider, connection.config_json, secret, connection.account_ref);
    return { connection, adapter, plan: plan ? { ...plan, requested_from: toIso(plan.requested_from), initial_cutoff: toIso(plan.initial_cutoff)! } : null };
  }
}

function toIso(v: unknown): string | null { return v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString(); }
