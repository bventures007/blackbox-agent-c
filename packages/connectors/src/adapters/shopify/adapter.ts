/**
 * Shopify source adapter (GraphQL Admin API, pinned version in client.ts).
 *
 * Poll groups: one provider query serves several register capabilities:
 *   orders  -> shopify.orders, shopify.payments, shopify.fulfillments, shopify.refunds, shopify.returns, shopify.receipts
 *   stock   -> shopify.stock
 *   allocations -> shopify.allocations (planned fulfillment work only; never a reservation)
 * Backfill phases for the orders group: "window" (created_at in [requested_from, initial_cutoff)) then
 * "open" (older open/unsettled orders when the plan includes open items). Incremental uses updated_at
 * with overlap; reconcile re-reads updated_at within a bounded window.
 */
import type { BackfillPlan, CapabilityDeclaration, CredentialCheck, Cursor, Observation, Page, RejectedInput, SourceAdapter } from '../../types.js';
import { ShopifyGraphqlClient, SHOPIFY_API_VERSION, type ShopifyClientConfig } from './client.js';
import { normalizeFulfillmentOrder, normalizeInventoryItem, normalizeOrder, numericId, type NormalizeContext, type ShopifyFulfillmentOrder, type ShopifyInventoryItem, type ShopifyOrder } from './normalize.js';
import { FULFILLMENT_ORDERS_QUERY, INVENTORY_ITEMS_QUERY, ORDERS_COUNT_QUERY, ORDERS_QUERY, ORDER_LINE_ITEMS_QUERY, PAGE_SIZE, SCOPES_QUERY, SHOP_QUERY } from './queries.js';

const UNSUPPORTED_GATEWAY = { status: 'unsupported' as const, methods: [], reason: 'local_gateway is deferred scope for the pilot; no gateway runtime is provisioned (SOURCE-SYNCHRONIZATION.md, LOCAL-07).' };
const UNSUPPORTED_PUBLIC = { status: 'unsupported' as const, methods: [], reason: 'public_server is deferred scope for the pilot; no public callback is registered and localhost cannot receive provider webhooks.' };

const ORDER_SCHEDULE = { interval_s: 300, min_interval_s: 60, max_interval_s: 3600, jitter_s: 30, overlap_s: 900, reconcile_every_s: 6 * 3600, reconcile_window_s: 48 * 3600, no_poll_reason: null };
const STOCK_SCHEDULE = { interval_s: 900, min_interval_s: 300, max_interval_s: 6 * 3600, jitter_s: 60, overlap_s: 900, reconcile_every_s: 24 * 3600, reconcile_window_s: 24 * 3600, no_poll_reason: null };

export const SHOPIFY_CAPABILITIES: Array<CapabilityDeclaration & { poll_group: 'orders' | 'stock' | 'allocations' }> = [
  cap('shopify.orders', 'orders', 'orders', 'Order.createdAt selects the import window; Order.updatedAt drives incremental/reconcile; historical revisions before first import are not reconstructed.', ['read_orders'], ['Default order access covers only the last 60 days; older orders need the read_all_orders approval.', 'Only the current version of an order is observable; intermediate edits before the first poll are not reconstructed.', 'Line items beyond the nested page are fetched with follow-up queries; other nested connections flag truncated_connections.'], ['order.accepted', 'order.revised', 'order.cancelled'], ORDER_SCHEDULE, 'supported'),
  cap('shopify.payments', 'orders', 'payments', 'OrderTransaction.processedAt is the effective time; records are selected through their order (created_at window / updated_at increment).', ['read_orders'], ['Transactions are read through their order; a transaction on an order outside the plan window is only seen when the order is in scope (open items included).', 'Transaction kinds other than authorization/sale/capture/void/refund and pending states are recorded as unsupported, not as cash.', 'test:true transactions are preserved as an explicit payload flag and never prove settlement.'], ['payment.authorized', 'payment.captured', 'payment.failed', 'payment.voided'], ORDER_SCHEDULE, 'supported'),
  cap('shopify.fulfillments', 'orders', 'fulfillments', 'Fulfillment.createdAt (handover) and deliveredAt; selected through the order window/update.', ['read_orders', 'read_fulfillments'], ['A fulfillment with status SUCCESS is treated as handover; tracking labels alone are not movements.', 'Reservation release quantities are unknown (no reservation evidence from Shopify).'], ['shipment.observed', 'shipment.dispatched', 'shipment.delivered', 'shipment.cancelled'], ORDER_SCHEDULE, 'partial'),
  cap('shopify.refunds', 'orders', 'refunds', 'Refund transaction processedAt; selected through the order.', ['read_orders'], ['Only successful refund transactions count as cash; pending/failed are distinct.', 'Destination is derived from the gateway (gift_card vs original payment method); other destinations are unknown.'], ['refund.pending', 'refund.completed', 'refund.failed'], ORDER_SCHEDULE, 'partial'),
  cap('shopify.returns', 'orders', 'returns', 'Return objects carry no own timestamp in the selected fields: effective time is Order.updatedAt (disclosed in payload).', ['read_orders', 'read_returns'], ['Return state is a workflow assertion, not receipt.', 'reverse_shipment_id is not exposed; expected credit is unknown until a refund exists.'], ['return.approved', 'return.revised', 'return.cancelled'], ORDER_SCHEDULE, 'partial'),
  cap('shopify.receipts', 'orders', 'receipts', 'ReverseFulfillmentOrder dispositions (no own timestamp: Order.updatedAt is used and disclosed).', ['read_orders', 'read_returns'], ['Dispositions prove merchant processing decisions, not SKU-level checked receipt; MISSING is not received.', 'RESTOCKED without a prior PROCESSING_REQUIRED disposition is counted once as the physical receipt.'], ['return.received', 'return.restocked', 'return.disposition_observed'], ORDER_SCHEDULE, 'partial'),
  cap('shopify.stock', 'stock', 'stock', 'InventoryLevel.updatedAt; snapshots only (no stock movement history from Shopify).', ['read_inventory', 'read_products'], ['Snapshot-only: differences between snapshots do not prove the cause of a movement.', 'Named quantity states depend on the location/app configuration; absent states are null, never zero.'], ['inventory.snapshot'], STOCK_SCHEDULE, 'partial'),
  cap('shopify.allocations', 'allocations', 'allocations', 'FulfillmentOrder.updatedAt.', ['read_merchant_managed_fulfillment_orders', 'read_assigned_fulfillment_orders'], ['Fulfillment-order assignment is planned work, not a stock reservation: no reservation track is derived (is_stock_reservation=false).', 'inventory.reserved / inventory.reservation_released are unsupported without explicit reservation evidence.'], ['allocation.revised'], STOCK_SCHEDULE, 'partial'),
];

function cap(id: string, poll_group: 'orders' | 'stock' | 'allocations', dataset: string, time_selection: string, grants: string[], limitations: string[], emits: string[], schedule: CapabilityDeclaration['schedule'], status: 'supported' | 'partial') {
  return {
    id, provider: 'shopify', dataset, poll_group, time_selection, schedule, required_grants: grants, limitations, emits,
    modes: {
      local_standalone: { status, methods: ['polling' as const], reason: status === 'supported' ? 'Outbound GraphQL polling with cursor pagination, updated_at overlap and bounded reconciliation; no inbound route needed.' : 'Outbound polling works for the declared field subset; the listed limitations keep the capability partial.' },
      local_gateway: UNSUPPORTED_GATEWAY,
      public_server: UNSUPPORTED_PUBLIC,
    },
  };
}

export interface ShopifyAdapterConfig extends ShopifyClientConfig {
  /** Known immutable shop id (gid) from the connection; verified on every credential check. */
  expected_account_ref?: string | null;
  page_size?: number;
}

interface PhaseCursor { [key: string]: unknown; phase: 'window' | 'open' | 'done'; after: string | null; floor: string | null; ceiling: string | null; max_seen: string | null; pages: number; totals_reported?: boolean }

export class ShopifyAdapter implements SourceAdapter {
  readonly provider = 'shopify';
  readonly capabilities = SHOPIFY_CAPABILITIES;
  readonly client: ShopifyGraphqlClient;
  private ctx: NormalizeContext | null = null;
  private readonly pageSize: number;

  constructor(private readonly cfg: ShopifyAdapterConfig) {
    this.client = new ShopifyGraphqlClient(cfg);
    this.pageSize = cfg.page_size ?? PAGE_SIZE.orders;
  }

  static pollGroup(capability_id: string): 'orders' | 'stock' | 'allocations' {
    const c = SHOPIFY_CAPABILITIES.find((x) => x.id === capability_id);
    if (!c) throw new Error(`unknown shopify capability ${capability_id}`);
    return c.poll_group;
  }

  async checkCredentials(): Promise<CredentialCheck> {
    const shop = await this.client.request<{ shop: { id: string; name: string; myshopifyDomain: string; currencyCode: string; ianaTimezone: string } }>('BlackboxShop', SHOP_QUERY);
    let granted: string[] = [];
    try {
      const scopes = await this.client.request<{ currentAppInstallation: { accessScopes: Array<{ handle: string }> } }>('BlackboxScopes', SCOPES_QUERY);
      granted = scopes.data.currentAppInstallation.accessScopes.map((s) => s.handle);
    } catch { granted = []; }
    const required = new Set(this.capabilities.flatMap((c) => c.required_grants));
    const missing = [...required].filter((g) => !granted.includes(g));
    const blocked = this.capabilities.filter((c) => c.required_grants.some((g) => !granted.includes(g))).map((c) => c.id);
    const account_ref = shop.data.shop.id;
    this.ctx = { account_ref, shop_numeric_id: numericId(account_ref) };
    const mismatch = this.cfg.expected_account_ref && this.cfg.expected_account_ref !== account_ref;
    return {
      ok: !mismatch, account_ref, account_label: shop.data.shop.myshopifyDomain, api_version: this.client.api_version, granted, missing_grants: missing, blocked_capabilities: blocked,
      error_code: mismatch ? 'account_mismatch' : null,
      detail: mismatch ? 'credentials belong to a different shop than this connection; a different account needs a new connection' : null,
    };
  }

  private async context(): Promise<NormalizeContext> {
    if (this.ctx) return this.ctx;
    const shop = await this.client.request<{ shop: { id: string } }>('BlackboxShop', SHOP_QUERY);
    if (this.cfg.expected_account_ref && this.cfg.expected_account_ref !== shop.data.shop.id) throw Object.assign(new Error('account_mismatch: refusing to read with cursors of another shop'), { code: 'account_mismatch', retryable: false });
    this.ctx = { account_ref: shop.data.shop.id, shop_numeric_id: numericId(shop.data.shop.id) };
    return this.ctx;
  }

  async backfill(capability_id: string, plan: BackfillPlan, cursor: Cursor | null): Promise<Page> {
    const group = ShopifyAdapter.pollGroup(capability_id);
    const c = (cursor as PhaseCursor | null) ?? { phase: plan.strict_from_now ? 'done' : 'window', after: null, floor: plan.requested_from, ceiling: plan.initial_cutoff, max_seen: null, pages: 0 };
    if (c.phase === 'done') return emptyPage(c);
    if (group === 'stock') {
      // Snapshot only: a backfill reads the current levels once (history_kind snapshot_only).
      return this.inventoryPage(c, null);
    }
    if (group === 'allocations') return this.fulfillmentOrdersPage(c, `updated_at:>='${c.floor}'`);
    const query = c.phase === 'window'
      ? `created_at:>='${plan.requested_from}' AND created_at:<'${plan.initial_cutoff}'`
      : `created_at:<'${plan.requested_from}' AND (status:open OR financial_status:pending OR financial_status:authorized OR financial_status:partially_paid OR fulfillment_status:unshipped OR fulfillment_status:partial)`;
    const page = await this.ordersPage(c, query, c.pages === 0 && !c.totals_reported);
    const next = page.next_cursor as PhaseCursor | null;
    if (!next || next.phase === 'done') {
      if (c.phase === 'window' && plan.include_open_items) {
        page.next_cursor = { phase: 'open', after: null, floor: plan.requested_from, ceiling: plan.initial_cutoff, max_seen: c.max_seen, pages: 0 } satisfies PhaseCursor;
        page.done = false;
      }
    }
    return page;
  }

  async incremental(capability_id: string, cursor: Cursor | null, now: Date): Promise<Page> {
    const group = ShopifyAdapter.pollGroup(capability_id);
    const overlap = (this.capabilities.find((x) => x.id === capability_id)?.schedule.overlap_s ?? 900) * 1000;
    const c = (cursor as PhaseCursor | null) ?? { phase: 'window', after: null, floor: new Date(now.getTime() - overlap).toISOString(), ceiling: null, max_seen: null, pages: 0 };
    if (c.phase === 'done') c.phase = 'window';
    const query = `updated_at:>='${c.floor}'`;
    const page = group === 'stock' ? await this.inventoryPage(c, query) : group === 'allocations' ? await this.fulfillmentOrdersPage(c, query) : await this.ordersPage(c, query, false);
    if (page.done) {
      // Advance the floor to the newest revision seen minus overlap; never beyond now; never backwards.
      const newest = page.max_source_time ?? c.max_seen;
      const floor = newest ? new Date(Math.max(Date.parse(c.floor ?? '1970-01-01T00:00:00Z'), Math.min(Date.parse(newest), now.getTime()) - overlap)).toISOString() : c.floor;
      page.next_cursor = { phase: 'window', after: null, floor, ceiling: null, max_seen: newest ?? null, pages: 0 } satisfies PhaseCursor;
    }
    return page;
  }

  async reconcile(capability_id: string, window: { from: string; to: string }, cursor: Cursor | null): Promise<Page> {
    const group = ShopifyAdapter.pollGroup(capability_id);
    const c = (cursor as PhaseCursor | null) ?? { phase: 'window', after: null, floor: window.from, ceiling: window.to, max_seen: null, pages: 0 };
    const query = `updated_at:>='${window.from}' AND updated_at:<='${window.to}'`;
    return group === 'stock' ? this.inventoryPage(c, query) : group === 'allocations' ? this.fulfillmentOrdersPage(c, query) : this.ordersPage(c, query, false);
  }

  private async ordersPage(c: PhaseCursor, query: string, wantTotal: boolean): Promise<Page> {
    const ctx = await this.context();
    let total: number | null = null;
    if (wantTotal) {
      const count = await this.client.request<{ ordersCount: { count: number; precision: string } | null }>('BlackboxOrdersCount', ORDERS_COUNT_QUERY, { query });
      if (count.data.ordersCount && count.data.ordersCount.precision === 'EXACT') total = count.data.ordersCount.count;
    }
    const res = await this.client.request<{ orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyOrder[] } }>('BlackboxOrders', ORDERS_QUERY, { first: this.pageSize, after: c.after, query, lineItems: PAGE_SIZE.line_items });
    const observations: Observation[] = []; const rejected: RejectedInput[] = []; let maxSeen = c.max_seen;
    for (const order of res.data.orders.nodes) {
      if (order.lineItems?.pageInfo?.hasNextPage) await this.fetchRemainingLineItems(order);
      const r = normalizeOrder(order, ctx);
      observations.push(...r.observations); rejected.push(...r.rejected);
      if (order.updatedAt && (!maxSeen || order.updatedAt > maxSeen)) maxSeen = order.updatedAt;
    }
    const hasNext = res.data.orders.pageInfo.hasNextPage;
    const next: PhaseCursor = { ...c, after: hasNext ? res.data.orders.pageInfo.endCursor : null, max_seen: maxSeen, pages: c.pages + 1, totals_reported: true, phase: hasNext ? c.phase : 'done' };
    return { observations, rejected, next_cursor: next, done: !hasNext, loaded_records: res.data.orders.nodes.length, total_records: total, max_source_time: maxSeen, throttle: res.throttle };
  }

  private async fetchRemainingLineItems(order: ShopifyOrder): Promise<void> {
    let after = order.lineItems.pageInfo.endCursor; let guard = 0;
    while (after && guard++ < 50) {
      const res = await this.client.request<{ order: { lineItems: ShopifyOrder['lineItems'] } | null }>('BlackboxOrderLineItems', ORDER_LINE_ITEMS_QUERY, { id: order.id, first: PAGE_SIZE.line_items, after });
      const li = res.data.order?.lineItems; if (!li) break;
      order.lineItems.nodes.push(...li.nodes);
      after = li.pageInfo.hasNextPage ? li.pageInfo.endCursor : null;
    }
    order.lineItems.pageInfo = { hasNextPage: Boolean(after), endCursor: after };
  }

  private async inventoryPage(c: PhaseCursor, query: string | null): Promise<Page> {
    const ctx = await this.context();
    const res = await this.client.request<{ inventoryItems: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyInventoryItem[] } }>('BlackboxInventoryItems', INVENTORY_ITEMS_QUERY, { first: PAGE_SIZE.inventory_items, after: c.after, query, levels: PAGE_SIZE.inventory_levels });
    const observations: Observation[] = []; const rejected: RejectedInput[] = []; let maxSeen = c.max_seen;
    for (const item of res.data.inventoryItems.nodes) {
      const r = normalizeInventoryItem(item, ctx); observations.push(...r.observations); rejected.push(...r.rejected);
      for (const o of r.observations) if (!maxSeen || o.source_time! > maxSeen) maxSeen = o.source_time!;
    }
    const hasNext = res.data.inventoryItems.pageInfo.hasNextPage;
    return { observations, rejected, next_cursor: { ...c, after: hasNext ? res.data.inventoryItems.pageInfo.endCursor : null, max_seen: maxSeen, pages: c.pages + 1, phase: hasNext ? c.phase : 'done' }, done: !hasNext, loaded_records: res.data.inventoryItems.nodes.length, total_records: null, max_source_time: maxSeen, throttle: res.throttle };
  }

  private async fulfillmentOrdersPage(c: PhaseCursor, query: string): Promise<Page> {
    const ctx = await this.context();
    const res = await this.client.request<{ fulfillmentOrders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyFulfillmentOrder[] } }>('BlackboxFulfillmentOrders', FULFILLMENT_ORDERS_QUERY, { first: PAGE_SIZE.fulfillment_orders, after: c.after, query });
    const observations: Observation[] = []; const rejected: RejectedInput[] = []; let maxSeen = c.max_seen;
    for (const fo of res.data.fulfillmentOrders.nodes) {
      const r = normalizeFulfillmentOrder(fo, ctx); observations.push(...r.observations); rejected.push(...r.rejected);
      if (fo.updatedAt && (!maxSeen || fo.updatedAt > maxSeen)) maxSeen = fo.updatedAt;
    }
    const hasNext = res.data.fulfillmentOrders.pageInfo.hasNextPage;
    return { observations, rejected, next_cursor: { ...c, after: hasNext ? res.data.fulfillmentOrders.pageInfo.endCursor : null, max_seen: maxSeen, pages: c.pages + 1, phase: hasNext ? c.phase : 'done' }, done: !hasNext, loaded_records: res.data.fulfillmentOrders.nodes.length, total_records: null, max_source_time: maxSeen, throttle: res.throttle };
  }
}

function emptyPage(c: PhaseCursor): Page {
  return { observations: [], rejected: [], next_cursor: { ...c, phase: 'done' }, done: true, loaded_records: 0, total_records: 0, max_source_time: c.max_seen, throttle: null };
}

export { SHOPIFY_API_VERSION };
