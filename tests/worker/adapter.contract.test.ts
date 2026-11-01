/**
 * Adapter contract tests against the provider-shaped local fixture (synthetic; not live evidence).
 * Covers: LOCAL-07 (pagination, duplicate/reordered pages, expired cursors, 429/Retry-After, 503, token
 * rejection, mode declarations), INGEST-05 (pagination/429/token expiry/unavailable/poison), SLICE-01 step 2
 * (actual adapter HTTP/pagination/normalization; explicit test-payment flag), SOURCE-01 mapping subset.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CredentialError, CursorExpiredError, InternalProducerAdapter, PollingUnsupportedError, ProviderUnavailableError, ShopifyAdapter, ShopifyPaymentsAdapter,
  SHOPIFY_API_VERSION, SHOPIFY_CAPABILITIES, SHOPIFY_PAYMENTS_CAPABILITIES, INTERNAL_CAPABILITIES, validateMappingTable, derivedTracks, toMinor, validateObservation, parseRetryAfter,
  type BackfillPlan, type Observation, type Page, type SourceAdapter,
} from '@blackbox/connectors';
import { startFixture, FIXTURE_TOKEN, FIXTURE_CLIENT, FIXTURE_CLOCK, noSleep, type RunningFixture } from './helpers/fixture.ts';

let fixture: RunningFixture;
const PLAN: BackfillPlan = { plan_id: 'p', plan_revision: 1, requested_from: new Date(FIXTURE_CLOCK - 30 * 86_400_000).toISOString(), initial_cutoff: new Date(FIXTURE_CLOCK).toISOString(), include_open_items: true, include_related_records: true, include_opening_state: true, strict_from_now: false, timezone: 'Europe/Berlin' };

async function drain(adapter: SourceAdapter, cap: string, mode: 'backfill' | 'incremental' | 'reconcile', extra: { plan?: BackfillPlan; window?: { from: string; to: string }; cursor?: Page['next_cursor'] } = {}): Promise<{ observations: Observation[]; pages: Page[]; cursor: Page['next_cursor'] }> {
  const pages: Page[] = []; const observations: Observation[] = []; let cursor = extra.cursor ?? null; let guard = 0;
  for (;;) {
    const page: Page = mode === 'backfill' ? await adapter.backfill(cap, extra.plan ?? PLAN, cursor) : mode === 'incremental' ? await adapter.incremental(cap, cursor, new Date(FIXTURE_CLOCK)) : await adapter.reconcile(cap, extra.window!, cursor);
    pages.push(page); observations.push(...page.observations); cursor = page.next_cursor;
    if (page.done || ++guard > 200) break;
  }
  return { observations, pages, cursor };
}

const sleeps: number[] = [];
const recordSleep = async (ms: number) => { sleeps.push(ms); };
const adapterFor = (f: RunningFixture, overrides: Record<string, unknown> = {}) => new ShopifyAdapter({ shop_domain: 'fixture-42.myshopify.com', base_url: f.url, auth: { type: 'admin_token', access_token: FIXTURE_TOKEN }, sleep: recordSleep, page_size: 7, ...overrides });

beforeAll(async () => { fixture = await startFixture({ seed: 42, orders: 40, port: 0 }); });
afterAll(async () => { await fixture.close(); });
beforeEach(async () => { await fetch(`${fixture.url}/__fixture/reset`, { method: 'POST', body: JSON.stringify({ seed: 42, orders: 40, clock: FIXTURE_CLOCK }) }); sleeps.length = 0; });

describe('mapping table and declarations', () => {
  it('derives only tracks allowed by events.json', () => {
    expect(validateMappingTable()).toEqual([]);
    // Unified table (shared with the API replay path): every family derives a fact; movements/commitments/
    // reservations only where the golden semantics say so (authorization and paid marker are facts only).
    expect(derivedTracks('order.accepted')).toEqual(['fact', 'commitment']);
    expect(derivedTracks('payment.captured')).toEqual(['fact', 'movement']);
    expect(derivedTracks('payment.authorized')).toEqual(['fact']);
    expect(derivedTracks('shipment.dispatched')).toEqual(['fact', 'movement', 'reservation']);
    expect(derivedTracks('invoice.payment_marked')).toEqual(['fact']);
    expect(derivedTracks('allocation.revised')).toEqual(['fact']);
    expect(() => derivedTracks('nonsense.event')).toThrow();
  });
  it('declares all three modes per capability; gateway/public are unsupported with no methods (LOCAL-07)', () => {
    for (const cap of [...SHOPIFY_CAPABILITIES, ...SHOPIFY_PAYMENTS_CAPABILITIES, ...Object.values(INTERNAL_CAPABILITIES).flat()]) {
      expect(Object.keys(cap.modes).sort()).toEqual(['local_gateway', 'local_standalone', 'public_server']);
      expect(cap.modes.local_gateway.status).toBe('unsupported'); expect(cap.modes.local_gateway.methods).toEqual([]); expect(cap.modes.local_gateway.reason.length).toBeGreaterThan(10);
      expect(cap.modes.public_server.status).toBe('unsupported'); expect(cap.modes.public_server.methods).toEqual([]);
      expect(cap.modes.local_standalone.methods.includes('direct_webhook')).toBe(false);
      if (cap.modes.local_standalone.status === 'unsupported') expect(cap.modes.local_standalone.methods).toEqual([]);
      else expect(cap.modes.local_standalone.methods.length).toBeGreaterThan(0);
    }
    expect(SHOPIFY_PAYMENTS_CAPABILITIES.find((c) => c.id === 'shopify_payments.holds')!.modes.local_standalone.status).toBe('unsupported');
    expect(SHOPIFY_API_VERSION).toBe('2026-10');
  });
  it('internal producers refuse polling explicitly', async () => {
    for (const provider of ['generic', 'bank_csv', 'replay', 'policy', 'runtime']) {
      const a = new InternalProducerAdapter(provider);
      await expect(a.incremental(a.capabilities[0]!.id, null, new Date())).rejects.toBeInstanceOf(PollingUnsupportedError);
      expect((await a.checkCredentials()).ok).toBe(true);
    }
  });
  it('money normalization is exact integer minor units', () => {
    expect(toMinor('119.00', 'EUR')).toBe(11900); expect(toMinor('-23.80', 'EUR')).toBe(-2380); expect(toMinor('1000', 'JPY')).toBe(1000);
    expect(() => toMinor('1.005', 'EUR')).toThrow(); expect(parseRetryAfter('1.5')).toBe(1500);
  });
});

describe('shopify adapter against the fixture', () => {
  it('checks credentials, grants and the immutable shop identity', async () => {
    const check = await adapterFor(fixture).checkCredentials();
    expect(check.ok).toBe(true); expect(check.account_ref).toBe('gid://shopify/Shop/1042'); expect(check.api_version).toBe('2026-10');
    expect(check.missing_grants).toEqual([]); expect(check.blocked_capabilities).toEqual([]);
    await fixture.control({ missing_scopes: ['read_returns'] });
    const partial = await adapterFor(fixture).checkCredentials();
    expect(partial.missing_grants).toEqual(['read_returns']); expect(partial.blocked_capabilities.sort()).toEqual(['shopify.receipts', 'shopify.returns']);
    const mismatch = await adapterFor(fixture, { expected_account_ref: 'gid://shopify/Shop/999' }).checkCredentials();
    expect(mismatch.ok).toBe(false); expect(mismatch.error_code).toBe('account_mismatch');
  });
  it('rejects an invalid token as a credential error without retry', async () => {
    await fixture.control({ reject_token: true });
    await expect(adapterFor(fixture).checkCredentials()).rejects.toBeInstanceOf(CredentialError);
    expect(sleeps).toEqual([]);
  });
  it('supports the client-credentials grant (no redirect) and refreshes the 24h token', async () => {
    let now = FIXTURE_CLOCK;
    const adapter = new ShopifyAdapter({ shop_domain: 'fixture-42.myshopify.com', base_url: fixture.url, auth: { type: 'client_credentials', ...FIXTURE_CLIENT }, sleep: noSleep, now: () => now });
    expect((await adapter.checkCredentials()).ok).toBe(true);
    const before = adapter.client.stats.requests;
    now += 86_400_000;
    expect((await adapter.checkCredentials()).ok).toBe(true);
    expect(adapter.client.stats.requests).toBe(before + 2);
    const state = await fixture.state();
    expect((state.requests as number)).toBeGreaterThan(before + 2);
  });
  it('backfills window + open phases with cursor pagination and exact totals', async () => {
    const adapter = adapterFor(fixture);
    const { observations, pages } = await drain(adapter, 'shopify.orders', 'backfill');
    expect(pages.length).toBeGreaterThan(3);
    expect(pages[0]!.total_records).toBeGreaterThan(0);
    const phases = new Set(pages.map((p) => (p.next_cursor as { phase: string } | null)?.phase));
    expect(phases.has('open') || phases.has('done')).toBe(true);
    const accepted = observations.filter((o) => o.kind === 'order.accepted');
    const ids = new Set(observations.map((o) => o.provider_event_id));
    expect(ids.size).toBe(observations.length);
    expect(accepted.length).toBeGreaterThan(20);
    for (const o of observations) expect(validateObservation(o)).toBeNull();
    const kinds = new Set(observations.map((o) => o.kind));
    for (const k of ['order.accepted', 'order.revised', 'order.cancelled', 'payment.authorized', 'payment.captured', 'payment.failed', 'payment.voided', 'refund.completed', 'shipment.dispatched', 'shipment.delivered', 'shipment.observed', 'return.approved', 'return.received', 'return.restocked']) expect(kinds, k).toContain(k);
    const rejected = pages.flatMap((p) => p.rejected);
    expect(rejected.some((r) => r.reason_code === 'unsupported_event' && /PENDING/.test(r.detail))).toBe(true);
    for (const o of observations) { expect(JSON.stringify(o.payload)).not.toMatch(/@|email|address/i); }
  });
  it('preserves the explicit provider test flag on payments (SLICE-02 labeling rule)', async () => {
    const { observations } = await drain(adapterFor(fixture), 'shopify.orders', 'backfill');
    const captures = observations.filter((o) => o.kind === 'payment.captured');
    expect(captures.some((o) => o.payload.test === true)).toBe(true);
    expect(captures.every((o) => typeof o.payload.test === 'boolean')).toBe(true);
    const testOrder = observations.find((o) => o.kind === 'order.accepted' && o.test === true)!;
    expect(captures.find((c) => c.entity.order === testOrder.entity.order)!.payload.test).toBe(true);
  });
  it('yields identical identities with duplicate and reordered pages (INGEST-02/04)', async () => {
    const clean = await drain(adapterFor(fixture), 'shopify.orders', 'backfill');
    await fixture.control({ duplicate_pages: true, shuffle: true });
    const chaos = await drain(adapterFor(fixture), 'shopify.orders', 'backfill');
    expect(chaos.pages.length).toBeGreaterThan(clean.pages.length);
    const cleanIds = new Set(clean.observations.map((o) => o.provider_event_id));
    const chaosIds = new Set(chaos.observations.map((o) => o.provider_event_id));
    expect(chaosIds).toEqual(cleanIds);
    expect(chaos.observations.length).toBeGreaterThan(clean.observations.length); // duplicates reach the dedupe boundary, not the journal
  });
  it('honours 429 Retry-After and recovers from 503 (INGEST-05)', async () => {
    const throttled = new ShopifyAdapter({ shop_domain: 'fixture-42.myshopify.com', base_url: `${fixture.url}?fixture_throttle=2`, auth: { type: 'admin_token', access_token: FIXTURE_TOKEN }, sleep: recordSleep, page_size: 20 });
    const page = await throttled.backfill('shopify.orders', PLAN, null);
    expect(page.observations.length).toBeGreaterThan(0);
    expect(sleeps.filter((s) => s === 1000).length).toBeGreaterThanOrEqual(2);
    expect(throttled.client.stats.retry_after_waits).toBeGreaterThanOrEqual(2);
    await fixture.control({ unavailable_next: 2 });
    const page2 = await adapterFor(fixture).backfill('shopify.orders', PLAN, null);
    expect(page2.observations.length).toBeGreaterThan(0);
    await fixture.control({ unavailable_next: 50 });
    await expect(adapterFor(fixture, { max_retries: 2 }).backfill('shopify.orders', PLAN, null)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
  it('surfaces an expired cursor explicitly', async () => {
    const adapter = adapterFor(fixture);
    const first = await adapter.backfill('shopify.orders', PLAN, null);
    await fixture.control({ expire_cursor_next: 1 });
    await expect(adapter.backfill('shopify.orders', PLAN, first.next_cursor)).rejects.toBeInstanceOf(CursorExpiredError);
  });
  it('records missing required fields as explicit rejections, never as zero (poison payload)', async () => {
    await fixture.control({ poison: true });
    const page = await adapterFor(fixture).backfill('shopify.orders', PLAN, null);
    expect(page.rejected.some((r) => r.reason_code === 'missing_required_field' && r.dataset === 'payments')).toBe(true);
    expect(page.observations.length).toBeGreaterThan(0);
  });
  it('incremental polling advances the floor with overlap and reconcile re-reads a window', async () => {
    const adapter = adapterFor(fixture);
    const inc = await drain(adapter, 'shopify.orders', 'incremental');
    const last = inc.pages[inc.pages.length - 1]!.next_cursor as { floor: string; max_seen: string };
    expect(Date.parse(last.floor)).toBeLessThanOrEqual(Date.parse(last.max_seen));
    await fixture.control({ mutate: { revise_order: 5003, at: new Date(FIXTURE_CLOCK - 60_000).toISOString() } });
    const again = await drain(adapter, 'shopify.orders', 'incremental', { cursor: inc.cursor });
    expect(again.observations.some((o) => o.kind === 'order.revised' && o.entity.order === 'gid://shopify/Order/5003')).toBe(true);
    const rec = await drain(adapter, 'shopify.orders', 'reconcile', { window: { from: new Date(FIXTURE_CLOCK - 7 * 86_400_000).toISOString(), to: new Date(FIXTURE_CLOCK).toISOString() } });
    expect(rec.pages[rec.pages.length - 1]!.done).toBe(true);
  });
  it('strict from-now plans import no history', async () => {
    const page = await adapterFor(fixture).backfill('shopify.orders', { ...PLAN, strict_from_now: true }, null);
    expect(page.done).toBe(true); expect(page.observations).toEqual([]); expect(page.total_records).toBe(0);
  });
  it('reads stock snapshots with named states and planned fulfillment work without a reservation', async () => {
    const stock = await drain(adapterFor(fixture), 'shopify.stock', 'backfill');
    expect(stock.observations.length).toBe(12);
    for (const o of stock.observations) { expect(o.kind).toBe('inventory.snapshot'); expect(o.payload.basis).toBe('shopify_named_quantity_states'); expect(typeof o.payload.available).toBe('string'); }
    const alloc = await drain(adapterFor(fixture), 'shopify.allocations', 'backfill');
    expect(alloc.observations.length).toBeGreaterThan(0);
    for (const o of alloc.observations) { expect(o.kind).toBe('allocation.revised'); expect(o.payload.is_stock_reservation).toBe(false); expect(derivedTracks(o.kind)).not.toContain('reservation'); }
  });
});

describe('shopify payments adapter against the fixture', () => {
  const pay = (overrides: Record<string, unknown> = {}) => new ShopifyPaymentsAdapter({ shop_domain: 'fixture-42.myshopify.com', base_url: fixture.url, auth: { type: 'admin_token', access_token: FIXTURE_TOKEN }, sleep: noSleep, ...overrides });
  it('requires an active Shopify Payments account and the payout/dispute grants', async () => {
    const ok = await pay().checkCredentials();
    expect(ok.ok).toBe(true); expect(ok.account_ref).toBe('gid://shopify/ShopifyPaymentsAccount/1042'); expect(ok.blocked_capabilities).toEqual(['shopify_payments.holds']);
    await fixture.control({ missing_scopes: ['read_shopify_payments_disputes'] });
    const noDisputes = await pay().checkCredentials();
    expect(noDisputes.blocked_capabilities).toContain('shopify_payments.disputes');
    await fixture.control({ missing_scopes: [], payments_inactive: true });
    const inactive = await pay().checkCredentials();
    expect(inactive.ok).toBe(false); expect(inactive.error_code).toBe('no_payments_account');
  });
  it('maps payouts, ledger entries (with fee breakdown), refunds, disputes and balance snapshots', async () => {
    const a = pay();
    const payouts = await drain(a, 'shopify_payments.payouts', 'backfill', { plan: { ...PLAN, requested_from: new Date(FIXTURE_CLOCK - 60 * 86_400_000).toISOString() } });
    const kinds = payouts.observations.map((o) => o.kind);
    expect(kinds).toContain('payout.sent'); expect(kinds).toContain('payout.announced'); expect(kinds).toContain('payout.failed');
    for (const o of payouts.observations) { expect(o.payload.settlement_basis).toMatch(/bank evidence/); expect(validateObservation(o)).toBeNull(); }
    const ledger = await drain(a, 'shopify_payments.provider_ledger', 'backfill', { plan: { ...PLAN, requested_from: new Date(FIXTURE_CLOCK - 60 * 86_400_000).toISOString() } });
    const lk = ledger.observations.map((o) => o.kind);
    expect(lk).toContain('provider.ledger_posted'); expect(lk).toContain('payment.fee_booked'); expect(lk).toContain('refund.completed'); expect(lk).toContain('chargeback.debit_posted'); expect(lk).toContain('chargeback.reversed');
    const fee = ledger.observations.find((o) => o.kind === 'payment.fee_booked')!;
    expect(fee.payload.included_in_ledger_entry).toBe(true); expect(typeof fee.payload.test).toBe('boolean');
    const refund = ledger.observations.find((o) => o.kind === 'refund.completed')!;
    expect(String(refund.payload.economic_effect_id)).toMatch(/^shopify:transaction:\d+$/);
    for (const o of ledger.observations) expect(validateObservation(o)).toBeNull();
    const disputes = await drain(a, 'shopify_payments.disputes', 'backfill', { plan: { ...PLAN, requested_from: new Date(FIXTURE_CLOCK - 60 * 86_400_000).toISOString() } });
    expect(disputes.observations.map((o) => o.kind).sort()).toEqual(['dispute.opened', 'dispute.resolved']);
    for (const o of disputes.observations) expect(validateObservation(o)).toBeNull();
    const positions = await a.incremental('shopify_payments.positions', null, new Date());
    expect(positions.observations[0]!.kind).toBe('provider.balance_observed'); expect(positions.observations[0]!.payload.held_minor).toBeNull(); expect(positions.observations[0]!.payload.coverage).toBe('total_balance_only');
    const holds = await a.incremental('shopify_payments.holds', null, new Date());
    expect(holds.observations).toEqual([]); expect(holds.done).toBe(true);
  });
  it('shop refund transaction and ledger refund share one economic identity (no double debit)', async () => {
    const shop = await drain(adapterFor(fixture), 'shopify.orders', 'backfill', { plan: { ...PLAN, requested_from: new Date(FIXTURE_CLOCK - 60 * 86_400_000).toISOString() } });
    const ledger = await drain(pay(), 'shopify_payments.refunds', 'backfill', { plan: { ...PLAN, requested_from: new Date(FIXTURE_CLOCK - 60 * 86_400_000).toISOString() } });
    const shopIds = new Set(shop.observations.filter((o) => o.kind === 'refund.completed').map((o) => o.payload.economic_effect_id));
    const ledgerIds = ledger.observations.filter((o) => o.kind === 'refund.completed').map((o) => o.payload.economic_effect_id);
    expect(ledgerIds.length).toBeGreaterThan(0);
    for (const id of ledgerIds) expect(shopIds.has(id)).toBe(true);
  });
});
