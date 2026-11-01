/**
 * Shopify Payments adapter: ShopifyPaymentsAccount { payouts, balanceTransactions, disputes, balance }.
 * Requires an active Shopify Payments account plus read_shopify_payments_payouts (payouts/balance
 * transactions) and read_shopify_payments_disputes (disputes). Holds are not exposed by the provider
 * and stay unsupported. Payout state is a provider assertion, never bank evidence.
 */
import { moneyFrom } from '../../money.js';
import type { BackfillPlan, CapabilityDeclaration, CredentialCheck, Cursor, Observation, Page, RejectedInput, SourceAdapter } from '../../types.js';
import { ShopifyGraphqlClient, type ShopifyClientConfig } from '../shopify/client.js';
import { numericId } from '../shopify/normalize.js';
import { BALANCE_TRANSACTIONS_QUERY, DISPUTES_QUERY, PAGE_SIZE, PAYMENTS_ACCOUNT_QUERY, PAYOUTS_QUERY, SCOPES_QUERY, SHOP_QUERY } from '../shopify/queries.js';

const UNSUPPORTED_GATEWAY = { status: 'unsupported' as const, methods: [], reason: 'local_gateway is deferred scope for the pilot; no gateway runtime is provisioned.' };
const UNSUPPORTED_PUBLIC = { status: 'unsupported' as const, methods: [], reason: 'public_server is deferred scope for the pilot; no public callback exists for finance objects.' };
const FINANCE_SCHEDULE = { interval_s: 1800, min_interval_s: 300, max_interval_s: 24 * 3600, jitter_s: 120, overlap_s: 3600, reconcile_every_s: 24 * 3600, reconcile_window_s: 7 * 24 * 3600, no_poll_reason: null };
const NO_POLL = { interval_s: null, min_interval_s: null, max_interval_s: null, jitter_s: 0, overlap_s: 0, reconcile_every_s: null, reconcile_window_s: null, no_poll_reason: 'Shopify Payments exposes no hold objects; nothing to poll.' };

type Group = 'ledger' | 'payouts' | 'disputes' | 'positions' | 'none';

export const SHOPIFY_PAYMENTS_CAPABILITIES: Array<CapabilityDeclaration & { poll_group: Group }> = [
  cap('shopify_payments.provider_ledger', 'ledger', 'provider_ledger', 'ShopifyPaymentsBalanceTransaction.transactionDate (processed_at).', ['read_shopify_payments_payouts'], ['Optional order/transaction links can be absent; adjustments are not forced onto an order.', 'payment.fee_booked is the fee breakdown of the same ledger entry (included_in_ledger_entry=true), not an additional debit.'], ['provider.ledger_posted', 'payment.fee_booked'], 'partial'),
  cap('shopify_payments.refunds', 'ledger', 'refunds', 'Balance transactions of type REFUND by transactionDate.', ['read_shopify_payments_payouts'], ['Shares economic_effect_id with the shop-side refund transaction (sourceOrderTransactionId) so one refund is never two debits.', 'Pending/failed refunds are not visible in the ledger; they come from the shopify.refunds capability.'], ['refund.completed'], 'partial'),
  cap('shopify_payments.payouts', 'payouts', 'payouts', 'ShopifyPaymentsPayout.issuedAt.', ['read_shopify_payments_payouts'], ['Payout status is a provider assertion; bank settlement needs independent bank evidence (bank_csv).', 'Ledger membership is derived from balance transactions associatedPayout, not from the payout object.', 'No bank trace reference is exposed in the selected fields.'], ['payout.announced', 'payout.sent', 'payout.failed'], 'partial'),
  cap('shopify_payments.disputes', 'disputes', 'disputes', 'ShopifyPaymentsDispute.initiatedAt / finalizedOn; booked debits/reversals come from balance transactions.', ['read_shopify_payments_disputes', 'read_shopify_payments_payouts'], ['Dispute links an order, not the original transaction; ambiguous with multiple captures.', 'Booked chargeback debit/reversal mapping from balance transaction types is a proof obligation against a live account.'], ['dispute.opened', 'dispute.resolved', 'chargeback.debit_posted', 'chargeback.reversed'], 'partial'),
  cap('shopify_payments.positions', 'positions', 'positions', 'Observation time of each poll (account balance is a current total only).', ['read_shopify_payments_payouts'], ['Only the total balance per currency is exposed; processing/available/held breakdown is unknown.', 'Snapshots supersede; never summed.'], ['provider.balance_observed'], 'partial'),
  { id: 'shopify_payments.holds', provider: 'shopify_payments', dataset: 'holds', poll_group: 'none', time_selection: 'not applicable', schedule: NO_POLL, required_grants: [], limitations: ['Shopify Payments exposes no hold, reserve or release-promise objects in the pinned schema.'], emits: [],
    modes: { local_standalone: { status: 'unsupported', methods: [], reason: 'No provider object for holds/reserves/release promises; the capability is unsupported until a verified source exists.' }, local_gateway: UNSUPPORTED_GATEWAY, public_server: UNSUPPORTED_PUBLIC } },
];

function cap(id: string, poll_group: Group, dataset: string, time_selection: string, grants: string[], limitations: string[], emits: string[], status: 'supported' | 'partial') {
  return { id, provider: 'shopify_payments', dataset, poll_group, time_selection, schedule: FINANCE_SCHEDULE, required_grants: grants, limitations, emits,
    modes: { local_standalone: { status, methods: ['polling' as const], reason: 'Outbound GraphQL polling of the Shopify Payments account with cursor pagination and bounded reconciliation.' }, local_gateway: UNSUPPORTED_GATEWAY, public_server: UNSUPPORTED_PUBLIC } };
}

interface PhaseCursor { [key: string]: unknown; phase: 'window' | 'done'; after: string | null; floor: string | null; ceiling: string | null; max_seen: string | null; pages: number }

interface Payout { id: string; status: string; issuedAt: string; transactionType: string; net: { amount: string; currencyCode: string }; summary?: Record<string, { amount: string; currencyCode: string } | null> }
interface BalanceTx { id: string; type: string; test: boolean; transactionDate: string; amount: { amount: string; currencyCode: string }; fee: { amount: string; currencyCode: string }; net: { amount: string; currencyCode: string }; sourceId: string | null; sourceType: string | null; sourceOrderTransactionId: string | null; adjustmentReason: string | null; associatedOrder: { id: string } | null; associatedPayout: { id: string | null; status: string | null } | null }
interface Dispute { id: string; status: string; type: string; initiatedAt: string; finalizedOn: string | null; evidenceDueBy: string | null; amount: { amount: string; currencyCode: string }; reasonDetails: { reason: string | null; networkReasonCode: string | null } | null; order: { id: string } | null }

export interface ShopifyPaymentsAdapterConfig extends ShopifyClientConfig { expected_account_ref?: string | null }

export class ShopifyPaymentsAdapter implements SourceAdapter {
  readonly provider = 'shopify_payments';
  readonly capabilities = SHOPIFY_PAYMENTS_CAPABILITIES;
  readonly client: ShopifyGraphqlClient;
  private account: { account_id: string; shop_numeric_id: string } | null = null;

  constructor(private readonly cfg: ShopifyPaymentsAdapterConfig) { this.client = new ShopifyGraphqlClient(cfg); }

  static pollGroup(capability_id: string): Group {
    const c = SHOPIFY_PAYMENTS_CAPABILITIES.find((x) => x.id === capability_id);
    if (!c) throw new Error(`unknown shopify_payments capability ${capability_id}`);
    return c.poll_group;
  }

  async checkCredentials(): Promise<CredentialCheck> {
    const shop = await this.client.request<{ shop: { id: string; myshopifyDomain: string } }>('BlackboxShop', SHOP_QUERY);
    let granted: string[] = [];
    try { granted = (await this.client.request<{ currentAppInstallation: { accessScopes: Array<{ handle: string }> } }>('BlackboxScopes', SCOPES_QUERY)).data.currentAppInstallation.accessScopes.map((s) => s.handle); } catch { granted = []; }
    const acct = await this.client.request<{ shopifyPaymentsAccount: { id: string; activated: boolean; defaultCurrency: string } | null }>('BlackboxPaymentsAccount', PAYMENTS_ACCOUNT_QUERY);
    const required = new Set(this.capabilities.flatMap((c) => c.required_grants));
    const missing = [...required].filter((g) => !granted.includes(g));
    const blocked = this.capabilities.filter((c) => c.poll_group === 'none' || c.required_grants.some((g) => !granted.includes(g))).map((c) => c.id);
    if (!acct.data.shopifyPaymentsAccount || !acct.data.shopifyPaymentsAccount.activated) {
      return { ok: false, account_ref: null, account_label: shop.data.shop.myshopifyDomain, api_version: this.client.api_version, granted, missing_grants: missing, blocked_capabilities: this.capabilities.map((c) => c.id), error_code: 'no_payments_account', detail: 'Shopify Payments is not active for this shop; finance capabilities are blocked (account prerequisite).' };
    }
    const account_ref = acct.data.shopifyPaymentsAccount.id;
    this.account = { account_id: account_ref, shop_numeric_id: numericId(shop.data.shop.id) };
    const mismatch = this.cfg.expected_account_ref && this.cfg.expected_account_ref !== account_ref;
    return { ok: !mismatch, account_ref, account_label: shop.data.shop.myshopifyDomain, api_version: this.client.api_version, granted, missing_grants: missing, blocked_capabilities: blocked, error_code: mismatch ? 'account_mismatch' : null, detail: mismatch ? 'a different Shopify Payments account: new connection required' : null };
  }

  private async context(): Promise<{ account_id: string; shop_numeric_id: string }> {
    if (this.account) return this.account;
    const check = await this.checkCredentials();
    if (!check.account_ref || !check.ok) throw Object.assign(new Error(check.detail ?? check.error_code ?? 'no_payments_account'), { code: check.error_code ?? 'no_payments_account', retryable: false });
    return this.account!;
  }

  async backfill(capability_id: string, plan: BackfillPlan, cursor: Cursor | null): Promise<Page> {
    const group = ShopifyPaymentsAdapter.pollGroup(capability_id);
    const c = (cursor as PhaseCursor | null) ?? { phase: plan.strict_from_now && group !== 'positions' ? 'done' : 'window', after: null, floor: plan.requested_from, ceiling: plan.initial_cutoff, max_seen: null, pages: 0 };
    if (c.phase === 'done') return { observations: [], rejected: [], next_cursor: c, done: true, loaded_records: 0, total_records: 0, max_source_time: c.max_seen, throttle: null };
    return this.page(group, c, plan.requested_from, plan.initial_cutoff);
  }

  async incremental(capability_id: string, cursor: Cursor | null, now: Date): Promise<Page> {
    const group = ShopifyPaymentsAdapter.pollGroup(capability_id);
    const overlap = FINANCE_SCHEDULE.overlap_s * 1000;
    const c = (cursor as PhaseCursor | null) ?? { phase: 'window', after: null, floor: new Date(now.getTime() - overlap).toISOString(), ceiling: null, max_seen: null, pages: 0 };
    if (c.phase === 'done') c.phase = 'window';
    const page = await this.page(group, c, c.floor, null);
    if (page.done) {
      const newest = page.max_source_time ?? c.max_seen;
      const floor = newest ? new Date(Math.max(Date.parse(c.floor ?? '1970-01-01T00:00:00Z'), Math.min(Date.parse(newest), now.getTime()) - overlap)).toISOString() : c.floor;
      page.next_cursor = { phase: 'window', after: null, floor, ceiling: null, max_seen: newest ?? null, pages: 0 } satisfies PhaseCursor;
    }
    return page;
  }

  async reconcile(capability_id: string, window: { from: string; to: string }, cursor: Cursor | null): Promise<Page> {
    const group = ShopifyPaymentsAdapter.pollGroup(capability_id);
    const c = (cursor as PhaseCursor | null) ?? { phase: 'window', after: null, floor: window.from, ceiling: window.to, max_seen: null, pages: 0 };
    return this.page(group, c, window.from, window.to);
  }

  private async page(group: Group, c: PhaseCursor, from: string | null, to: string | null): Promise<Page> {
    const ctx = await this.context();
    const observations: Observation[] = []; const rejected: RejectedInput[] = []; let maxSeen = c.max_seen;
    const range = (field: string) => [from ? `${field}:>='${from}'` : null, to ? `${field}:<='${to}'` : null].filter(Boolean).join(' AND ') || null;
    const key = (object: string, gid: string, suffix: string) => `${ctx.shop_numeric_id}|${object}:${numericId(gid)}|${suffix}`;
    let hasNext = false; let endCursor: string | null = null; let loaded = 0; let throttle: Page['throttle'] = null;
    if (group === 'none') return { observations, rejected, next_cursor: { ...c, phase: 'done' }, done: true, loaded_records: 0, total_records: 0, max_source_time: null, throttle };
    if (group === 'positions') {
      const res = await this.client.request<{ shopifyPaymentsAccount: { id: string; balance: Array<{ amount: string; currencyCode: string }> } }>('BlackboxPaymentsAccount', PAYMENTS_ACCOUNT_QUERY);
      const observed = new Date().toISOString();
      for (const b of res.data.shopifyPaymentsAccount.balance) {
        const m = moneyFrom(b); if (!m) { rejected.push({ provider_ref: ctx.account_id, dataset: 'positions', reason_code: 'missing_required_field', detail: 'balance amount/currency' }); continue; }
        observations.push({ provider_event_id: key('balance', ctx.account_id, `${m.currency}|${observed}`), kind: 'provider.balance_observed', record_id: `position:${ctx.account_id}:${m.currency}`, dataset: 'positions', occurred_at: observed, source_time: null, entity: { account: ctx.account_id }, correlation_id: null, test: null,
          payload: { account_id: ctx.account_id, currency: m.currency, observed_at: observed, total_minor: m.minor, processing_minor: null, available_minor: null, held_minor: null, coverage: 'total_balance_only', basis: 'ShopifyPaymentsAccount.balance (current total per currency; snapshot supersedes earlier snapshots)' },
          evidence: { kind: 'shopify_payments.balance', media_type: 'application/json', content: { id: res.data.shopifyPaymentsAccount.id, balance: b, observed_at: observed } } });
      }
      loaded = observations.length; throttle = res.throttle; maxSeen = observed;
    } else if (group === 'payouts') {
      const res = await this.client.request<{ shopifyPaymentsAccount: { payouts: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Payout[] } } }>('BlackboxPayouts', PAYOUTS_QUERY, { first: PAGE_SIZE.payouts, after: c.after, query: range('issued_at') });
      const conn = res.data.shopifyPaymentsAccount.payouts; hasNext = conn.pageInfo.hasNextPage; endCursor = conn.pageInfo.endCursor; loaded = conn.nodes.length; throttle = res.throttle;
      for (const p of conn.nodes) {
        const net = moneyFrom(p.net); const st = (p.status ?? '').toUpperCase();
        if (!net || !p.id || !p.issuedAt || !st) { rejected.push({ provider_ref: p.id ?? '?', dataset: 'payouts', reason_code: 'missing_required_field', detail: 'payout id/status/issuedAt/net required' }); continue; }
        const family = st === 'SCHEDULED' ? 'payout.announced' : (st === 'IN_TRANSIT' || st === 'PAID') ? 'payout.sent' : (st === 'FAILED' || st === 'CANCELED' || st === 'CANCELLED') ? 'payout.failed' : null;
        if (!family) { rejected.push({ provider_ref: p.id, dataset: 'payouts', reason_code: 'unsupported_event', detail: `payout status ${st} unsupported` }); continue; }
        const summary: Record<string, number | null> = {};
        for (const [k, v] of Object.entries(p.summary ?? {})) summary[k] = moneyFrom(v)?.minor ?? null;
        observations.push({ provider_event_id: key('payout', p.id, st.toLowerCase()), kind: family, record_id: `payout:${p.id}`, dataset: 'payouts', occurred_at: p.issuedAt, source_time: p.issuedAt, entity: { payout: p.id, account: ctx.account_id }, correlation_id: p.id, test: null,
          payload: { payout_id: p.id, account_id: ctx.account_id, status: st.toLowerCase(), direction: p.transactionType === 'WITHDRAWAL' ? 'from_bank' : 'to_bank', amount_minor: net.minor, currency: net.currency, issued_at: p.issuedAt, trace_reference: null, ledger_membership: null, reversal_id: null, fee_summary: summary, settlement_basis: 'provider assertion; bank evidence required (bank_csv)' },
          evidence: { kind: 'shopify_payments.payout', media_type: 'application/json', content: p } });
        if (!maxSeen || p.issuedAt > maxSeen) maxSeen = p.issuedAt;
      }
    } else if (group === 'ledger') {
      const res = await this.client.request<{ shopifyPaymentsAccount: { balanceTransactions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: BalanceTx[] } } }>('BlackboxBalanceTransactions', BALANCE_TRANSACTIONS_QUERY, { first: PAGE_SIZE.balance_transactions, after: c.after, query: range('processed_at') });
      const conn = res.data.shopifyPaymentsAccount.balanceTransactions; hasNext = conn.pageInfo.hasNextPage; endCursor = conn.pageInfo.endCursor; loaded = conn.nodes.length; throttle = res.throttle;
      for (const t of conn.nodes) {
        const gross = moneyFrom(t.amount), fee = moneyFrom(t.fee), net = moneyFrom(t.net);
        if (!gross || !fee || !net || typeof t.test !== 'boolean' || !t.transactionDate || !t.type) { rejected.push({ provider_ref: t.id ?? '?', dataset: 'provider_ledger', reason_code: 'missing_required_field', detail: 'balance transaction amount/fee/net/test/type/transactionDate required' }); continue; }
        const sourceTxn = t.sourceOrderTransactionId ? `gid://shopify/OrderTransaction/${t.sourceOrderTransactionId}` : null;
        const economic = t.sourceOrderTransactionId ? `shopify:transaction:${t.sourceOrderTransactionId}` : `shopify_payments:balance_transaction:${numericId(t.id)}`;
        const entity: Record<string, string> = { account: ctx.account_id, ledger_entry: t.id };
        if (t.associatedOrder?.id) entity.order = t.associatedOrder.id;
        if (sourceTxn) entity.transaction = sourceTxn;
        if (t.associatedPayout?.id) entity.payout = t.associatedPayout.id;
        const type = t.type.toUpperCase();
        const base = { ledger_entry_id: t.id, account_id: ctx.account_id, source_transaction_id: sourceTxn, order_link: t.associatedOrder?.id ?? null, payout_id: t.associatedPayout?.id ?? null, payout_status: t.associatedPayout?.status ?? null, posting_type: type.toLowerCase(), source_type: t.sourceType ?? null, gross_minor: gross.minor, fee_minor: fee.minor, net_minor: net.minor, currency: net.currency, effective_time: t.transactionDate, test: t.test, adjustment_reason: t.adjustmentReason ?? null, economic_effect_id: economic };
        const evidence = { kind: 'shopify_payments.balance_transaction', media_type: 'application/json', content: t };
        observations.push({ provider_event_id: key('bt', t.id, 'posted'), kind: 'provider.ledger_posted', record_id: `ledger:${t.id}`, dataset: 'provider_ledger', occurred_at: t.transactionDate, source_time: t.transactionDate, entity, correlation_id: t.associatedOrder?.id ?? null, test: t.test, payload: base, evidence });
        if (fee.minor !== 0 && type === 'CHARGE') observations.push({ provider_event_id: key('bt', t.id, 'fee'), kind: 'payment.fee_booked', record_id: `ledger:${t.id}`, dataset: 'provider_ledger', occurred_at: t.transactionDate, source_time: t.transactionDate, entity, correlation_id: t.associatedOrder?.id ?? null, test: t.test,
          payload: { transaction: sourceTxn, transaction_id: sourceTxn, ledger_entry_id: t.id, account_id: ctx.account_id, fee_minor: fee.minor, currency: fee.currency, included_in_ledger_entry: true, economic_effect_id: `${economic}:fee`, test: t.test }, evidence });
        if (type === 'REFUND') observations.push({ provider_event_id: key('bt', t.id, 'refund'), kind: 'refund.completed', record_id: `refund:ledger:${t.id}`, dataset: 'refunds', occurred_at: t.transactionDate, source_time: t.transactionDate, entity, correlation_id: t.associatedOrder?.id ?? null, test: t.test,
          payload: { refund_id: `ledger:${t.id}`, original_transaction_id: sourceTxn, order_id: t.associatedOrder?.id ?? null, account_id: ctx.account_id, amount_minor: Math.abs(gross.minor), hold_released_minor: Math.abs(gross.minor), currency: gross.currency, status: 'completed', destination: 'original_payment_method', economic_effect_id: economic, ledger_entry_id: t.id, test: t.test }, evidence });
        if (type === 'DISPUTE' || type === 'DISPUTE_REVERSAL') observations.push({ provider_event_id: key('bt', t.id, type.toLowerCase()), kind: type === 'DISPUTE' ? 'chargeback.debit_posted' : 'chargeback.reversed', record_id: `dispute-posting:${t.id}`, dataset: 'disputes', occurred_at: t.transactionDate, source_time: t.transactionDate, entity, correlation_id: t.associatedOrder?.id ?? null, test: t.test,
          payload: { dispute_id: t.sourceId ? `gid://shopify/ShopifyPaymentsDispute/${t.sourceId}` : null, original_transaction_id: sourceTxn, order_id: t.associatedOrder?.id ?? null, debit_posting_id: t.id, debit_minor: type === 'DISPUTE' ? Math.abs(net.minor) : null, reversal_minor: type === 'DISPUTE_REVERSAL' ? Math.abs(net.minor) : null, amount_minor: Math.abs(gross.minor), currency: gross.currency, state: type === 'DISPUTE' ? 'debited' : 'reversed', economic_effect_id: `shopify_payments:balance_transaction:${numericId(t.id)}`, test: t.test }, evidence });
        if (!maxSeen || t.transactionDate > maxSeen) maxSeen = t.transactionDate;
      }
    } else if (group === 'disputes') {
      const res = await this.client.request<{ shopifyPaymentsAccount: { disputes: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Dispute[] } } }>('BlackboxDisputes', DISPUTES_QUERY, { first: PAGE_SIZE.disputes, after: c.after, query: range('initiated_at') });
      const conn = res.data.shopifyPaymentsAccount.disputes; hasNext = conn.pageInfo.hasNextPage; endCursor = conn.pageInfo.endCursor; loaded = conn.nodes.length; throttle = res.throttle;
      for (const d of conn.nodes) {
        const amount = moneyFrom(d.amount); const st = (d.status ?? '').toUpperCase();
        if (!amount || !d.id || !d.initiatedAt || !st) { rejected.push({ provider_ref: d.id ?? '?', dataset: 'disputes', reason_code: 'missing_required_field', detail: 'dispute id/status/initiatedAt/amount required' }); continue; }
        const open = st === 'NEEDS_RESPONSE' || st === 'UNDER_REVIEW';
        const family = open ? 'dispute.opened' : 'dispute.resolved';
        const occurred = open ? d.initiatedAt : (d.finalizedOn ?? d.initiatedAt);
        const entity: Record<string, string> = { dispute: d.id, account: ctx.account_id }; if (d.order?.id) entity.order = d.order.id;
        observations.push({ provider_event_id: key('dispute', d.id, st.toLowerCase()), kind: family, record_id: `dispute:${d.id}`, dataset: 'disputes', occurred_at: occurred, source_time: occurred, entity, correlation_id: d.order?.id ?? null, test: null,
          payload: { dispute_id: d.id, original_transaction_id: null, order_id: d.order?.id ?? null, amount_minor: amount.minor, currency: amount.currency, state: st.toLowerCase(), dispute_type: d.type?.toLowerCase() ?? null, reason: d.reasonDetails?.reason ?? null, initiated_at: d.initiatedAt, finalized_on: d.finalizedOn ?? null, evidence_due_by: d.evidenceDueBy ?? null, debit_posting_id: null, debit_minor: null, reversal_minor: null, link_basis: 'order link only; original transaction not exposed by ShopifyPaymentsDispute' },
          evidence: { kind: 'shopify_payments.dispute', media_type: 'application/json', content: d } });
        if (!maxSeen || occurred > maxSeen) maxSeen = occurred;
      }
    }
    const done = !hasNext;
    return { observations, rejected, next_cursor: { ...c, after: hasNext ? endCursor : null, max_seen: maxSeen, pages: c.pages + 1, phase: done ? 'done' : 'window' }, done, loaded_records: loaded, total_records: null, max_source_time: maxSeen, throttle };
  }
}
