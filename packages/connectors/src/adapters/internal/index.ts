/**
 * Non-polling producers. They implement the same interface so the worker can declare capabilities,
 * schedules (none) and mode support truthfully; polling raises PollingUnsupportedError.
 *   generic  - signed typed push handled by the API (authenticated_push in local_standalone)
 *   bank_csv - owner upload import (import)
 *   replay   - synthetic acceptance fixtures through the same ingestion path (import)
 *   policy   - versioned workspace rules (internal)
 *   runtime  - coverage/identity checkpoints written by ingestion/reconciliation (internal)
 */
import { PollingUnsupportedError, type BackfillPlan, type CapabilityDeclaration, type CredentialCheck, type Cursor, type Page, type SourceAdapter, type SyncMethod } from '../../types.js';

const NO_SCHEDULE = (reason: string) => ({ interval_s: null, min_interval_s: null, max_interval_s: null, jitter_s: 0, overlap_s: 0, reconcile_every_s: null, reconcile_window_s: null, no_poll_reason: reason });

function internalCapability(provider: string, dataset: string, method: SyncMethod, reason: string, emits: string[], limitations: string[]): CapabilityDeclaration {
  return {
    id: `${provider}.${dataset}`, provider, dataset, time_selection: 'occurred_at supplied by the producer/import row; recorded_at is the actual import time.',
    schedule: NO_SCHEDULE(reason), required_grants: [], limitations, emits,
    modes: {
      local_standalone: { status: 'supported', methods: [method], reason },
      local_gateway: { status: 'unsupported', methods: [], reason: 'Deferred scope: no gateway runtime in the pilot.' },
      public_server: { status: 'unsupported', methods: [], reason: 'Deferred scope: no public server in the pilot.' },
    },
  };
}

export const INTERNAL_CAPABILITIES: Record<string, CapabilityDeclaration[]> = {
  generic: ['orders', 'stock', 'allocations', 'supply', 'promises', 'fulfillments', 'payments', 'returns', 'receipts', 'refunds', 'invoices', 'invoice_dispatch', 'payment_allocations', 'provider_ledger', 'positions', 'payouts', 'holds', 'disputes', 'entitlements', 'tracking', 'communications', 'cases', 'identity', 'bank'].map((ds) =>
    internalCapability('generic', ds, 'authenticated_push', 'Signed typed push to POST /api/ingest/generic on the local backend; no polling and no provider callback. The producer must actually exist and reach the local API.', [], ['A schema is not a data source: completeness is a labeled producer assertion until a verified producer supplies it.'])),
  bank_csv: [internalCapability('bank_csv', 'bank', 'import', 'Owner-uploaded statement CSV through POST /api/ingest/bank-csv with a versioned mapping; coverage is the declared statement interval.', ['bank.credit_booked', 'bank.debit_booked', 'bank.match_recorded', 'bank.match_revised'], ['No live bank feed; a next poll does not apply.', 'Coverage is the statement interval declared at import, not continuous.'])],
  replay: [internalCapability('replay', 'fixtures', 'import', 'Deterministic synthetic replay through POST /api/ingest/replay in an isolated workspace; proves the pipeline path only.', [], ['Synthetic: never provider evidence.'])],
  policy: [internalCapability('policy', 'policy', 'internal', 'Versioned workspace rules appended by owner settings; the query reads the version effective at its cutoff.', ['business.rule_recorded', 'business.rule_revised'], ['No undocumented default decides business obligations.'])],
  runtime: [internalCapability('runtime', 'coverage', 'internal', 'Coverage/identity checkpoints produced by tenant-scoped ingestion and reconciliation; written by the worker after successful scoped checks.', ['coverage.observed', 'coverage.gap_recorded', 'entity.link_recorded', 'entity.link_revised', 'entity.link_conflict'], ['A generic producer cannot mark another source complete.'])],
};

export class InternalProducerAdapter implements SourceAdapter {
  readonly capabilities: CapabilityDeclaration[];
  constructor(readonly provider: string) {
    this.capabilities = INTERNAL_CAPABILITIES[provider] ?? [];
    if (!this.capabilities.length) throw new Error(`unknown internal provider ${provider}`);
  }
  async checkCredentials(): Promise<CredentialCheck> {
    return { ok: true, account_ref: null, account_label: this.provider, api_version: 'internal', granted: [], missing_grants: [], blocked_capabilities: [], error_code: null, detail: `${this.provider} has no provider credentials; authorization is enforced by the API path (${this.capabilities[0]!.modes.local_standalone.methods.join(',')}).` };
  }
  async backfill(capability_id: string, _plan: BackfillPlan, _cursor: Cursor | null): Promise<Page> { throw this.unsupported(capability_id); }
  async incremental(capability_id: string, _cursor: Cursor | null, _now: Date): Promise<Page> { throw this.unsupported(capability_id); }
  async reconcile(capability_id: string, _window: { from: string; to: string }, _cursor: Cursor | null): Promise<Page> { throw this.unsupported(capability_id); }
  private unsupported(capability_id: string): PollingUnsupportedError {
    const cap = this.capabilities.find((c) => c.id === capability_id);
    return new PollingUnsupportedError(capability_id, cap?.schedule.no_poll_reason ?? `${this.provider} does not poll`);
  }
}
