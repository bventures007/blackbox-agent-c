// Pure view-model adapters over the real API responses. They only reorganise what the API
// returned (grouping, aggregation of timestamps, presentation metadata such as catalogue
// categories); no business value is computed here.

import type { Capability, CapabilityHealth, CatalogueItem, ConnectionDetail, ConnectionHealth, ConnectionSummary, QuestionReadiness, ReviewAction, ReviewCase, SourceCategory, SourceStatus } from './types';

/** Presentation metadata for the source catalogue: category grouping (reference 11–15) and which connect dialog exists. */
export const PROVIDER_META: Record<string, { category: SourceCategory; connect_kind: CatalogueItem['connect_kind'] }> = {
  shopify: { category: 'shops', connect_kind: 'shopify' },
  woocommerce: { category: 'shops', connect_kind: null },
  shopware: { category: 'shops', connect_kind: null },
  shopify_payments: { category: 'payment', connect_kind: 'shopify_payments' },
  bank_csv: { category: 'payment', connect_kind: 'bank_csv' },
  stripe: { category: 'payment', connect_kind: null },
  paypal: { category: 'payment', connect_kind: null },
  mollie: { category: 'payment', connect_kind: null },
  easybill: { category: 'billing', connect_kind: null },
  lexware: { category: 'billing', connect_kind: null },
  sevdesk: { category: 'billing', connect_kind: null },
  billbee: { category: 'billing', connect_kind: null },
  sufio: { category: 'billing', connect_kind: null },
  dhl: { category: 'shipping', connect_kind: null },
  dpd: { category: 'shipping', connect_kind: null },
  ups: { category: 'shipping', connect_kind: null },
  generic: { category: 'other', connect_kind: 'generic' },
  replay: { category: 'other', connect_kind: 'replay' },
  policy: { category: 'other', connect_kind: null },
  email: { category: 'other', connect_kind: null },
};

/** Internal API rows that are not user-connectable sources (hidden from the catalogue, documented in reports/evidence/UI-01/comparison.md). */
const HIDDEN_PROVIDERS = new Set(['runtime']);

/** Providers from the integration register that the API does not list yet; shown as "planned" so the catalogue stays truthful about scope. */
export const PLANNED_PROVIDERS = ['woocommerce', 'shopware', 'stripe', 'paypal', 'mollie', 'lexware', 'sevdesk', 'billbee', 'sufio', 'dpd', 'ups', 'email'];

const DEGRADED_STATES = new Set(['degraded', 'unavailable', 'paused', 'disconnected']);

const maxTs = (values: Array<string | null | undefined>): string | null => values.reduce<string | null>((acc, v) => (v && (!acc || v > acc) ? v : acc), null);
const minTs = (values: Array<string | null | undefined>): string | null => values.reduce<string | null>((acc, v) => (v && (!acc || v < acc) ? v : acc), null);

interface RawConnection {
  connection_id: string;
  provider: string;
  display_name: string;
  account_ref: string | null;
  status: string;
  config: Record<string, unknown> | null;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
  disconnected_at: string | null;
}

export function adaptConnection(raw: RawConnection, caps: Capability[] | CapabilityHealth[] = []): ConnectionSummary {
  const own = (caps as Array<Capability | CapabilityHealth>).filter((c) => c.connection_id === raw.connection_id);
  const states = own.map((c) => ('state' in c ? c.state : c.status));
  const degraded = DEGRADED_STATES.has(raw.status) || states.some((s) => s === 'degraded' || s === 'unavailable');
  const next = own.filter((c) => c.next_check_at).sort((a, b) => String(a.next_check_at).localeCompare(String(b.next_check_at)))[0];
  const config = raw.config ?? {};
  return {
    ...raw,
    config,
    account_label: raw.account_ref && !raw.account_ref.startsWith('demo:') ? raw.account_ref : typeof config.shop_domain === 'string' ? config.shop_domain : null,
    demo: Boolean(raw.account_ref?.startsWith('demo:') || config.demo === true),
    state: raw.status as SourceStatus,
    last_successful_check_at: maxTs(own.map((c) => c.last_successful_check_at)),
    last_new_event_at: maxTs(own.map((c) => c.last_new_event_at)),
    next_check_at: next?.next_check_at ?? null,
    next_check_reason: next?.next_check_reason ?? own[0]?.next_check_reason ?? null,
    degraded,
  };
}

interface RawCatalogueItem {
  provider: string;
  name: string;
  category: string;
  state: string;
  capabilities: Capability[];
  connections: RawConnection[];
}

export function adaptCatalogue(raw: { catalogue: RawCatalogueItem[]; readiness_observed_at?: string }): { catalogue: CatalogueItem[]; readiness_observed_at?: string } {
  const items: CatalogueItem[] = raw.catalogue
    .filter((i) => !HIDDEN_PROVIDERS.has(i.provider))
    .map((i) => {
      const meta = PROVIDER_META[i.provider] ?? { category: 'other' as SourceCategory, connect_kind: null };
      // One pill per capability id on the card; the worst state across connections wins.
      const byId = new Map<string, Capability>();
      for (const c of i.capabilities) {
        const prev = byId.get(c.id);
        if (!prev || rank(c.state) > rank(prev.state)) byId.set(c.id, { ...c, limitations: Array.from(new Set([...(prev?.limitations ?? []), ...c.limitations])) });
      }
      return {
        provider: i.provider,
        name: i.name,
        category: meta.category,
        api_category: i.category,
        state: i.state as CatalogueItem['state'],
        capabilities: Array.from(byId.values()),
        connections: i.connections.map((c) => adaptConnection(c, i.capabilities)),
        connect_kind: meta.connect_kind,
        from_api: true,
      };
    });
  const known = new Set(items.map((i) => i.provider));
  for (const p of PLANNED_PROVIDERS) {
    if (known.has(p)) continue;
    const meta = PROVIDER_META[p]!;
    items.push({ provider: p, name: p, category: meta.category, state: 'planned', capabilities: [], connections: [], connect_kind: null, from_api: false });
  }
  return { catalogue: items, readiness_observed_at: raw.readiness_observed_at };
}

function rank(state: string): number {
  return { unavailable: 4, degraded: 3, paused: 2, working: 1, unknown: 1, healthy: 0 }[state] ?? 1;
}

export function aggregateHealth(connection: RawConnection, caps: CapabilityHealth[]): ConnectionHealth {
  const next = caps.filter((c) => c.next_check_at).sort((a, b) => String(a.next_check_at).localeCompare(String(b.next_check_at)))[0];
  const failing = caps.filter((c) => c.last_error_code);
  return {
    observed_at: maxTs(caps.map((c) => c.observed_at)),
    state: connection.status as SourceStatus,
    last_attempt_at: maxTs(caps.map((c) => c.last_attempt_at)),
    last_successful_check_at: maxTs(caps.map((c) => c.last_successful_check_at)),
    last_new_event_at: maxTs(caps.map((c) => c.last_new_event_at)),
    last_journal_commit_at: maxTs(caps.map((c) => c.last_journal_commit_at)),
    next_check_at: next?.next_check_at ?? null,
    next_check_reason: next?.next_check_reason ?? caps[0]?.next_check_reason ?? null,
    coverage: caps.map((c) => ({ capability_id: c.capability_id, from: c.coverage_from, to: c.coverage_to, completeness: c.coverage_state, history_kind: c.history_kind })),
    limitations: Array.from(new Set(caps.flatMap((c) => c.limitations))),
    pending_count: caps.reduce((n, c) => n + (c.pending_count ?? 0), 0),
    failed_count: caps.reduce((n, c) => n + (c.failed_count ?? 0), 0),
    consecutive_failures: Math.max(0, ...caps.map((c) => c.consecutive_failures ?? 0)),
    last_error_code: failing.sort((a, b) => String(b.last_error_at).localeCompare(String(a.last_error_at)))[0]?.last_error_code ?? null,
    missing_grants: Array.from(new Set(caps.flatMap((c) => c.missing_grants ?? []))),
    next_action: caps.find((c) => c.next_action)?.next_action ?? null,
  };
}

export function adaptConnectionDetail(raw: { connection: RawConnection; health: CapabilityHealth[]; import_plan: ConnectionDetail['import_plan']; import_plan_proposal?: ConnectionDetail['import_plan_proposal']; runs: ConnectionDetail['runs']; readiness: QuestionReadiness[] }): ConnectionDetail {
  const caps = raw.health ?? [];
  return {
    connection: adaptConnection(raw.connection, caps),
    capabilities: caps,
    health: aggregateHealth(raw.connection, caps),
    import_plan: raw.import_plan ?? null,
    import_plan_proposal: raw.import_plan_proposal ?? null,
    runs: raw.runs ?? [],
    readiness: raw.readiness ?? [],
  };
}

/** Review case: the API stores case references in `refs`; which decisions make sense follows from the case type (PILOT-OPERATIONS §3). */
export function adaptReviewCase(raw: Omit<ReviewCase, 'available_actions' | 'affected_records' | 'proposed_link'>): ReviewCase {
  const refs = raw.refs ?? {};
  const linkTypes = new Set(['ambiguous_bank_match', 'unresolved_link']);
  const available: ReviewAction[] = raw.state === 'resolved' ? [] : linkTypes.has(raw.type) ? ['confirm_link', 'reject_link', 'append_correction', 'leave_open'] : ['retry', 'append_correction', 'leave_open'];
  const records = [refs.identity, refs.bank_entry, refs.record_id, refs.provider_event_id].filter((v): v is string => typeof v === 'string');
  const candidates = Array.isArray(refs.candidates) ? (refs.candidates as Array<unknown>) : [];
  const link = refs.link && typeof refs.link === 'object' ? (refs.link as { from?: string; to?: string }) : null;
  const firstCandidate = candidates[0];
  const proposed = link?.from && link?.to ? { from: link.from, to: link.to } : typeof refs.bank_entry === 'string' && firstCandidate ? { from: refs.bank_entry, to: typeof firstCandidate === 'string' ? firstCandidate : JSON.stringify(firstCandidate) } : null;
  return { ...raw, history: (raw.history ?? []) as ReviewCase['history'], available_actions: available, affected_records: records, proposed_link: proposed };
}

/** Evidence refs of answers/states are `journal:<entry_id>` (journal entries carry the raw evidence ids). */
export function journalRefId(ref: string): string | null {
  return ref.startsWith('journal:') ? ref.slice('journal:'.length) : null;
}
