/**
 * Shopify GraphQL objects -> normalized observations. Pure functions; no I/O.
 * Identity: provider_event_id = "<shop numeric id>|<object>:<numeric id>|<revision or state>", account-scoped.
 * PII is never copied: customer is referenced by opaque gid only; no names, emails or addresses.
 */
import { moneyFrom, quantity, toMinor } from '../../money.js';
import type { Observation, RejectedInput } from '../../types.js';

export interface Money { amount: string; currencyCode: string }
export interface MoneyBag { shopMoney: Money }

export interface ShopifyLineItem {
  id: string; sku: string | null; quantity: number; currentQuantity: number; unfulfilledQuantity: number;
  variant: { id: string; inventoryItem: { id: string } | null } | null;
  originalTotalSet: MoneyBag; discountedTotalSet: MoneyBag; totalDiscountSet: MoneyBag | null;
  taxLines: Array<{ priceSet: MoneyBag }>;
}
export interface ShopifyTransaction {
  id: string; kind: string; status: string; test: boolean; gateway: string | null; processedAt: string | null; createdAt?: string; errorCode?: string | null;
  amountSet: MoneyBag; parentTransaction: { id: string } | null;
}
export interface ShopifyFulfillment {
  id: string; status: string; createdAt: string; updatedAt: string; inTransitAt: string | null; deliveredAt: string | null;
  location: { id: string } | null; trackingInfo: Array<{ company: string | null; number: string | null }>;
  fulfillmentLineItems: { pageInfo: { hasNextPage: boolean }; nodes: Array<{ id: string; quantity: number; lineItem: { id: string } }> };
}
export interface ShopifyRefund {
  id: string; createdAt: string; updatedAt: string; totalRefundedSet: MoneyBag;
  refundLineItems: { pageInfo: { hasNextPage: boolean }; nodes: Array<{ quantity: number; restockType: string; restocked: boolean; location: { id: string } | null; lineItem: { id: string } }> };
  transactions: { pageInfo: { hasNextPage: boolean }; nodes: ShopifyTransaction[] };
}
export interface ShopifyReturn {
  id: string; status: string;
  returnLineItems: { pageInfo: { hasNextPage: boolean }; nodes: Array<{ id: string; quantity: number; fulfillmentLineItem?: { lineItem: { id: string } } | null }> };
  reverseFulfillmentOrders: { nodes: Array<{ id: string; status: string; lineItems: { nodes: Array<{ id: string; fulfillmentLineItem: { lineItem: { id: string } } | null; dispositions: Array<{ id: string; type: string; quantity: number; location: { id: string } | null }> }> } }> };
}
export interface ShopifyOrder {
  id: string; name: string; createdAt: string; updatedAt: string; cancelledAt: string | null; closedAt: string | null; test: boolean; currencyCode: string;
  displayFinancialStatus: string | null; displayFulfillmentStatus: string;
  customer: { id: string } | null;
  originalTotalPriceSet: MoneyBag; currentTotalPriceSet: MoneyBag; totalShippingPriceSet: MoneyBag; totalTaxSet: MoneyBag | null; totalDiscountsSet: MoneyBag | null;
  lineItems: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyLineItem[] };
  transactions: ShopifyTransaction[];
  fulfillments: ShopifyFulfillment[];
  refunds: ShopifyRefund[];
  returns: { pageInfo: { hasNextPage: boolean }; nodes: ShopifyReturn[] };
}

export interface NormalizeContext { account_ref: string; shop_numeric_id: string }
export interface NormalizeResult { observations: Observation[]; rejected: RejectedInput[] }

export function numericId(gid: string): string {
  const m = /\/([A-Za-z]+)\/(\d+)(\?.*)?$/.exec(gid);
  return m ? m[2]! : gid;
}

function idKey(ctx: NormalizeContext, object: string, gid: string, suffix: string): string {
  return `${ctx.shop_numeric_id}|${object}:${numericId(gid)}|${suffix}`;
}

function sumMinor(parts: Array<MoneyBag | null | undefined>, currency: string): number | null {
  let total = 0; let any = false;
  for (const p of parts) { const m = moneyFrom(p?.shopMoney); if (!m) continue; if (m.currency !== currency) return null; total += m.minor; any = true; }
  return any ? total : 0;
}

export function normalizeOrder(order: ShopifyOrder, ctx: NormalizeContext): NormalizeResult {
  const observations: Observation[] = [];
  const rejected: RejectedInput[] = [];
  const seen = new Set<string>();
  const push = (o: Observation) => { if (!seen.has(o.provider_event_id)) { seen.add(o.provider_event_id); observations.push(o); } };
  const orderRef = `order:${order.id}`;
  const entity: Record<string, string> = { order: order.id };
  if (order.customer?.id) entity.customer = order.customer.id;
  const currency = order.currencyCode;
  const truncated: string[] = [];
  if (order.lineItems.pageInfo.hasNextPage) truncated.push('lineItems');
  if (order.returns.pageInfo.hasNextPage) truncated.push('returns');
  const baseEvidence = (kind: string, content: unknown) => ({ kind, media_type: 'application/json', content });

  const gross = moneyFrom(order.originalTotalPriceSet?.shopMoney);
  if (!gross) {
    rejected.push({ provider_ref: order.id, dataset: 'orders', reason_code: 'missing_required_field', detail: 'originalTotalPriceSet.shopMoney missing' });
  } else {
    const lines = order.lineItems.nodes.map((li) => {
      const original = moneyFrom(li.originalTotalSet?.shopMoney);
      return {
        line_id: li.id, item_id: li.variant?.inventoryItem?.id ?? null, variant_id: li.variant?.id ?? null, sku: li.sku ?? null,
        ...quantity(li.quantity, 'piece'), line_net_minor: original?.minor ?? null, line_tax_minor: null, line_gross_minor: null, discount_minor: null,
        amount_basis: 'originalTotalSet (pre-discount, pre-tax, as ordered)',
      };
    });
    push({
      provider_event_id: idKey(ctx, 'order', order.id, 'accepted'), kind: 'order.accepted', record_id: orderRef, dataset: 'orders',
      occurred_at: order.createdAt, source_time: order.createdAt, entity, correlation_id: order.id, test: order.test,
      payload: {
        order_id: order.id, order: order.name, customer_id: order.customer?.id ?? null, currency, gross_minor: gross.minor, test: order.test,
        agreed_version: order.createdAt, cancellation_state: 'none', updated_at: order.createdAt,
        shipping_minor: null, lines, truncated_connections: truncated, amount_basis: 'originalTotalPriceSet (agreed total at acceptance)',
      },
      evidence: baseEvidence('shopify.order.accepted', { id: order.id, name: order.name, createdAt: order.createdAt, currencyCode: currency, test: order.test, originalTotalPriceSet: order.originalTotalPriceSet, lineItems: order.lineItems.nodes.map((l) => ({ id: l.id, sku: l.sku, quantity: l.quantity, variant: l.variant, originalTotalSet: l.originalTotalSet })) }),
    });
    if (order.updatedAt > order.createdAt) {
      const current = moneyFrom(order.currentTotalPriceSet?.shopMoney);
      const lines = order.lineItems.nodes.map((li) => {
        const net = moneyFrom(li.discountedTotalSet?.shopMoney);
        const tax = sumMinor(li.taxLines?.map((t) => t.priceSet) ?? [], currency);
        const discount = moneyFrom(li.totalDiscountSet?.shopMoney);
        return {
          line_id: li.id, item_id: li.variant?.inventoryItem?.id ?? null, variant_id: li.variant?.id ?? null, sku: li.sku ?? null,
          ...quantity(li.currentQuantity, 'piece'), ordered_quantity: String(li.quantity), unfulfilled_quantity: String(li.unfulfilledQuantity),
          line_net_minor: net?.minor ?? null, line_tax_minor: tax, line_gross_minor: net && tax !== null ? net.minor + tax : null, discount_minor: discount?.minor ?? null,
          amount_basis: 'discountedTotalSet (current, after discounts, before taxes) + taxLines',
        };
      });
      push({
        provider_event_id: idKey(ctx, 'order', order.id, `rev:${order.updatedAt}`), kind: 'order.revised', record_id: orderRef, dataset: 'orders',
        occurred_at: order.updatedAt, source_time: order.updatedAt, entity, correlation_id: order.id, test: order.test,
        payload: {
          order_id: order.id, order: order.name, customer_id: order.customer?.id ?? null, currency, gross_minor: current?.minor ?? null, test: order.test,
          shipping_minor: moneyFrom(order.totalShippingPriceSet?.shopMoney)?.minor ?? null, tax_minor: moneyFrom(order.totalTaxSet?.shopMoney)?.minor ?? null,
          discount_minor: moneyFrom(order.totalDiscountsSet?.shopMoney)?.minor ?? null,
          agreed_version: order.createdAt, updated_at: order.updatedAt, cancellation_state: order.cancelledAt ? 'cancelled' : 'none',
          financial_status: order.displayFinancialStatus, fulfillment_status: order.displayFulfillmentStatus, closed_at: order.closedAt,
          lines, truncated_connections: truncated, amount_basis: 'currentTotalPriceSet (current totals after edits/refunds)',
        },
        evidence: baseEvidence('shopify.order.revised', { id: order.id, updatedAt: order.updatedAt, currentTotalPriceSet: order.currentTotalPriceSet, totalShippingPriceSet: order.totalShippingPriceSet, totalTaxSet: order.totalTaxSet, totalDiscountsSet: order.totalDiscountsSet, displayFinancialStatus: order.displayFinancialStatus, displayFulfillmentStatus: order.displayFulfillmentStatus, cancelledAt: order.cancelledAt, closedAt: order.closedAt, lineItems: order.lineItems.nodes }),
      });
    }
    if (order.cancelledAt) {
      push({
        provider_event_id: idKey(ctx, 'order', order.id, 'cancelled'), kind: 'order.cancelled', record_id: orderRef, dataset: 'orders',
        occurred_at: order.cancelledAt, source_time: order.cancelledAt, entity, correlation_id: order.id, test: order.test,
        payload: { order_id: order.id, order: order.name, currency, cancellation_state: 'cancelled', cancelled_at: order.cancelledAt, agreed_version: order.createdAt, updated_at: order.updatedAt, test: order.test },
        evidence: baseEvidence('shopify.order.cancelled', { id: order.id, cancelledAt: order.cancelledAt }),
      });
    }
  }

  // Transactions: refund transaction -> Refund object id (for linkage), otherwise payments dataset.
  const refundByTxn = new Map<string, ShopifyRefund>();
  for (const r of order.refunds ?? []) for (const t of r.transactions?.nodes ?? []) refundByTxn.set(t.id, r);
  const allTxns: ShopifyTransaction[] = [...(order.transactions ?? [])];
  for (const r of order.refunds ?? []) for (const t of r.transactions?.nodes ?? []) if (!allTxns.some((x) => x.id === t.id)) allTxns.push(t);
  for (const t of allTxns) {
    const amount = moneyFrom(t.amountSet?.shopMoney);
    if (!amount || typeof t.test !== 'boolean' || !t.kind || !t.status) {
      rejected.push({ provider_ref: t.id ?? order.id, dataset: 'payments', reason_code: 'missing_required_field', detail: `transaction ${t.id ?? '?'}: amountSet/test/kind/status required` });
      continue;
    }
    const occurred = t.processedAt ?? t.createdAt ?? order.updatedAt;
    const kind = t.kind.toUpperCase(); const status = t.status.toUpperCase();
    const txnEntity = { ...entity, transaction: t.id };
    const common = {
      transaction_id: t.id, original_transaction_id: t.parentTransaction?.id ?? null, order_id: order.id, account_id: ctx.account_ref,
      gateway: t.gateway ?? null, kind: kind.toLowerCase(), status: status.toLowerCase(), amount_minor: amount.minor, currency: amount.currency,
      occurred_at: occurred, economic_effect_id: `shopify:transaction:${numericId(t.id)}`, test: t.test, error_code: t.errorCode ?? null,
    };
    const evidence = baseEvidence('shopify.order_transaction', { id: t.id, kind: t.kind, status: t.status, test: t.test, gateway: t.gateway, processedAt: t.processedAt, amountSet: t.amountSet, parentTransaction: t.parentTransaction, errorCode: t.errorCode ?? null });
    let family: string | null = null; let dataset = 'payments'; let payload: Record<string, unknown> = common;
    if (kind === 'REFUND') {
      dataset = 'refunds';
      const refund = refundByTxn.get(t.id);
      family = status === 'SUCCESS' ? 'refund.completed' : status === 'PENDING' ? 'refund.pending' : (status === 'FAILURE' || status === 'ERROR') ? 'refund.failed' : null;
      payload = {
        refund_id: refund?.id ?? t.id, transaction_id: t.id, original_transaction_id: t.parentTransaction?.id ?? null, order_id: order.id, account_id: ctx.account_ref,
        amount_minor: amount.minor, currency: amount.currency, status: status.toLowerCase(),
        destination: t.gateway === 'gift_card' ? 'gift_card' : 'original_payment_method', gateway: t.gateway ?? null,
        economic_effect_id: `shopify:transaction:${numericId(t.id)}`, occurred_at: occurred, test: t.test,
        ...(family === 'refund.pending' ? { held_minor: amount.minor } : {}), ...(family === 'refund.completed' ? { hold_released_minor: amount.minor } : {}),
      };
      if (refund) Object.assign(txnEntity, { refund: refund.id });
    } else if (status === 'FAILURE' || status === 'ERROR') family = 'payment.failed';
    else if (status === 'SUCCESS' && kind === 'AUTHORIZATION') { family = 'payment.authorized'; payload = { ...common, authorized_minor: amount.minor }; }
    else if (status === 'SUCCESS' && (kind === 'SALE' || kind === 'CAPTURE')) { family = 'payment.captured'; payload = { ...common, captured_minor: amount.minor }; }
    else if (status === 'SUCCESS' && kind === 'VOID') family = 'payment.voided';
    else if (status === 'PENDING' || status === 'AWAITING_RESPONSE') { family = null; }
    if (!family) {
      rejected.push({ provider_ref: t.id, dataset, reason_code: 'unsupported_event', detail: `transaction kind ${kind} status ${status} has no canonical family (recorded as unsupported, not as cash)` });
      continue;
    }
    push({ provider_event_id: idKey(ctx, 'txn', t.id, status.toLowerCase()), kind: family, record_id: dataset === 'refunds' ? `refund:${payload.refund_id as string}` : `transaction:${t.id}`, dataset, occurred_at: occurred, source_time: occurred, entity: txnEntity, payload, evidence, correlation_id: order.id, test: t.test });
  }

  // Fulfillments.
  for (const f of order.fulfillments ?? []) {
    if (!f.id || !f.status || !f.createdAt) { rejected.push({ provider_ref: f.id ?? order.id, dataset: 'fulfillments', reason_code: 'missing_required_field', detail: 'fulfillment id/status/createdAt required' }); continue; }
    const lines = (f.fulfillmentLineItems?.nodes ?? []).map((n) => ({ line_id: n.lineItem.id, fulfillment_line_id: n.id, ...quantity(n.quantity, 'piece'), physical_stock_delta: String(-n.quantity), reservation_released: null }));
    const tracking = f.trackingInfo?.[0] ?? null;
    const base = {
      shipment_id: f.id, order_id: order.id, location_id: f.location?.id ?? null, carrier: tracking?.company ?? null, tracking_number: tracking?.number ?? null,
      handover_at: f.status.toUpperCase() === 'SUCCESS' ? f.createdAt : null, delivered_at: f.deliveredAt ?? null, in_transit_at: f.inTransitAt ?? null, state: f.status.toLowerCase(), lines,
      truncated_connections: f.fulfillmentLineItems?.pageInfo?.hasNextPage ? ['fulfillmentLineItems'] : [], test: order.test,
    };
    const fEntity = { ...entity, shipment: f.id };
    const evidence = baseEvidence('shopify.fulfillment', { id: f.id, status: f.status, createdAt: f.createdAt, updatedAt: f.updatedAt, inTransitAt: f.inTransitAt, deliveredAt: f.deliveredAt, location: f.location, trackingInfo: f.trackingInfo, fulfillmentLineItems: f.fulfillmentLineItems });
    const st = f.status.toUpperCase();
    if (st === 'SUCCESS') push({ provider_event_id: idKey(ctx, 'ful', f.id, 'dispatched'), kind: 'shipment.dispatched', record_id: `shipment:${f.id}`, dataset: 'fulfillments', occurred_at: f.createdAt, source_time: f.updatedAt, entity: fEntity, payload: { ...base, physical_stock_delta_basis: 'fulfillment creation = handover to carrier; reservation release unknown (Shopify exposes no reservation evidence)' }, evidence, correlation_id: order.id, test: order.test });
    else if (st === 'CANCELLED') push({ provider_event_id: idKey(ctx, 'ful', f.id, 'cancelled'), kind: 'shipment.cancelled', record_id: `shipment:${f.id}`, dataset: 'fulfillments', occurred_at: f.updatedAt, source_time: f.updatedAt, entity: fEntity, payload: base, evidence, correlation_id: order.id, test: order.test });
    else push({ provider_event_id: idKey(ctx, 'ful', f.id, `observed:${st.toLowerCase()}`), kind: 'shipment.observed', record_id: `shipment:${f.id}`, dataset: 'fulfillments', occurred_at: f.updatedAt, source_time: f.updatedAt, entity: fEntity, payload: base, evidence, correlation_id: order.id, test: order.test });
    if (f.deliveredAt) push({ provider_event_id: idKey(ctx, 'ful', f.id, 'delivered'), kind: 'shipment.delivered', record_id: `shipment:${f.id}`, dataset: 'fulfillments', occurred_at: f.deliveredAt, source_time: f.updatedAt, entity: fEntity, payload: { shipment_id: f.id, order_id: order.id, delivered_at: f.deliveredAt, carrier_status: 'delivered', state: 'delivered', lines, test: order.test }, evidence, correlation_id: order.id, test: order.test });
  }

  // Returns and dispositions. Return objects expose no own timestamp in the selected fields: effective time = order.updatedAt (disclosed).
  for (const r of order.returns?.nodes ?? []) {
    if (!r.id || !r.status) { rejected.push({ provider_ref: r.id ?? order.id, dataset: 'returns', reason_code: 'missing_required_field', detail: 'return id/status required' }); continue; }
    const st = r.status.toUpperCase();
    const lines = (r.returnLineItems?.nodes ?? []).map((n) => ({ return_line_id: n.id, line_id: n.fulfillmentLineItem?.lineItem?.id ?? null, ...quantity(n.quantity, 'piece') }));
    const total = lines.reduce((a, l) => a + Number(l.quantity), 0);
    const family = st === 'OPEN' ? 'return.approved' : (st === 'CANCELED' || st === 'CANCELLED' || st === 'DECLINED') ? 'return.cancelled' : 'return.revised';
    const rEntity = { ...entity, return: r.id };
    const payload = { return_id: r.id, order_id: order.id, state: st.toLowerCase(), ...quantity(total, 'piece'), lines, reverse_shipment_id: null, expected_credit_minor: null, currency, effective_time_basis: 'order.updatedAt (Return exposes no timestamp in the selected fields)', truncated_connections: r.returnLineItems?.pageInfo?.hasNextPage ? ['returnLineItems'] : [], test: order.test };
    const evidence = baseEvidence('shopify.return', { id: r.id, status: r.status, returnLineItems: r.returnLineItems, reverseFulfillmentOrders: r.reverseFulfillmentOrders });
    push({ provider_event_id: idKey(ctx, 'ret', r.id, st.toLowerCase()), kind: family, record_id: `return:${r.id}`, dataset: 'returns', occurred_at: order.updatedAt, source_time: order.updatedAt, entity: rEntity, payload, evidence, correlation_id: order.id, test: order.test });
    for (const rfo of r.reverseFulfillmentOrders?.nodes ?? []) {
      for (const li of rfo.lineItems?.nodes ?? []) {
        const hasQuarantine = li.dispositions.some((d) => d.type.toUpperCase() === 'PROCESSING_REQUIRED');
        for (const d of li.dispositions ?? []) {
          const type = d.type.toUpperCase();
          const q = d.quantity;
          let family: string; let physical = '0'; let quarantine = '0';
          if (type === 'PROCESSING_REQUIRED') { family = 'return.received'; physical = String(q); quarantine = String(q); }
          else if (type === 'RESTOCKED') { family = 'return.restocked'; if (hasQuarantine) { quarantine = String(-q); } else { physical = String(q); } }
          else family = 'return.disposition_observed';
          push({
            provider_event_id: idKey(ctx, 'disp', d.id, type.toLowerCase()), kind: family, record_id: `receipt:${d.id}`, dataset: 'receipts',
            occurred_at: order.updatedAt, source_time: order.updatedAt, entity: { ...rEntity, line: li.fulfillmentLineItem?.lineItem?.id ?? '' , receipt: d.id }, correlation_id: order.id, test: order.test,
            payload: { receipt_id: d.id, return_id: r.id, reverse_fulfillment_order_id: rfo.id, line_id: li.fulfillmentLineItem?.lineItem?.id ?? null, location_id: d.location?.id ?? null, ...quantity(q, 'piece'), disposition: type.toLowerCase(), physical_delta: physical, quarantine_delta: quarantine, occurred_at: order.updatedAt, effective_time_basis: 'order.updatedAt (dispositions expose no timestamp)', restock_basis: type === 'RESTOCKED' && !hasQuarantine ? 'restocked without prior PROCESSING_REQUIRED: counted as the physical receipt' : type === 'RESTOCKED' ? 'quarantine release after prior receipt' : null, test: order.test },
            evidence: baseEvidence('shopify.reverse_fulfillment_order_disposition', { reverseFulfillmentOrderId: rfo.id, lineItemId: li.id, disposition: d }),
          });
        }
      }
    }
  }
  return { observations, rejected };
}

export interface ShopifyInventoryItem {
  id: string; sku: string | null; tracked: boolean; updatedAt: string;
  inventoryLevels: { pageInfo: { hasNextPage: boolean }; nodes: Array<{ id: string; updatedAt: string; location: { id: string }; quantities: Array<{ name: string; quantity: number }> }> };
}

export function normalizeInventoryItem(item: ShopifyInventoryItem, ctx: NormalizeContext): NormalizeResult {
  const observations: Observation[] = []; const rejected: RejectedInput[] = [];
  for (const level of item.inventoryLevels?.nodes ?? []) {
    if (!level.id || !level.location?.id || !level.updatedAt) { rejected.push({ provider_ref: level.id ?? item.id, dataset: 'stock', reason_code: 'missing_required_field', detail: 'inventory level id/location/updatedAt required' }); continue; }
    const q: Record<string, string | null> = {};
    for (const name of ['available', 'on_hand', 'committed', 'reserved', 'damaged', 'safety_stock', 'quality_control', 'incoming']) {
      const found = level.quantities?.find((x) => x.name === name);
      q[name] = found ? quantity(found.quantity).quantity : null;
    }
    observations.push({
      provider_event_id: idKey(ctx, 'inv', level.id, level.updatedAt), kind: 'inventory.snapshot', record_id: `stock:${item.id}@${level.location.id}`, dataset: 'stock',
      occurred_at: level.updatedAt, source_time: level.updatedAt, entity: { item: item.id, location: level.location.id }, correlation_id: null, test: null,
      payload: { item_id: item.id, sku: item.sku ?? null, location_id: level.location.id, unit: 'piece', observed_at: level.updatedAt, basis: 'shopify_named_quantity_states', tracked: item.tracked,
        physical: q.on_hand, available: q.available, committed: q.committed, reserved: q.reserved, damaged: q.damaged, safety_stock: q.safety_stock, quality_control: q.quality_control, incoming: q.incoming,
        note: 'available is already net of committed/reserved/unavailable states; do not subtract again. incoming is not on hand.' },
      evidence: { kind: 'shopify.inventory_level', media_type: 'application/json', content: { item: { id: item.id, sku: item.sku, tracked: item.tracked }, level } },
    });
  }
  return { observations, rejected };
}

export interface ShopifyFulfillmentOrder {
  id: string; status: string; requestStatus: string; updatedAt: string; createdAt: string;
  assignedLocation: { location: { id: string } | null } | null; order: { id: string };
  lineItems: { pageInfo: { hasNextPage: boolean }; nodes: Array<{ id: string; totalQuantity: number; remainingQuantity: number; lineItem: { id: string }; inventoryItemId: string | null }> };
}

/** Planned fulfillment work: a fact about assignment, explicitly not a stock reservation. */
export function normalizeFulfillmentOrder(fo: ShopifyFulfillmentOrder, ctx: NormalizeContext): NormalizeResult {
  if (!fo.id || !fo.order?.id || !fo.updatedAt) return { observations: [], rejected: [{ provider_ref: fo.id ?? '?', dataset: 'allocations', reason_code: 'missing_required_field', detail: 'fulfillment order id/order/updatedAt required' }] };
  const location = fo.assignedLocation?.location?.id ?? null;
  const lines = (fo.lineItems?.nodes ?? []).map((n) => ({ allocation_id: n.id, line_id: n.lineItem.id, item_id: n.inventoryItemId ?? null, location_id: location, ...quantity(n.remainingQuantity), total_quantity: String(n.totalQuantity), status: n.remainingQuantity === 0 ? 'completed' : fo.status.toLowerCase() }));
  return { rejected: [], observations: [{
    provider_event_id: idKey(ctx, 'fo', fo.id, fo.updatedAt), kind: 'allocation.revised', record_id: `allocation:${fo.id}`, dataset: 'allocations',
    occurred_at: fo.updatedAt, source_time: fo.updatedAt, entity: { order: fo.order.id, allocation: fo.id, ...(location ? { location } : {}) }, correlation_id: fo.order.id, test: null,
    payload: { allocation_id: fo.id, order_id: fo.order.id, location_id: location, status: fo.status.toLowerCase(), request_status: fo.requestStatus?.toLowerCase() ?? null, unit: 'piece', lines,
      policy_version: 'shopify-fulfillment-order-assignment.v1', is_stock_reservation: false, basis: 'FulfillmentOrder location assignment and remaining quantity; not reservation evidence (CONNECTOR-CAPABILITIES finding 1)' },
    evidence: { kind: 'shopify.fulfillment_order', media_type: 'application/json', content: fo },
  }] };
}

export function minorOf(m: Money | null | undefined): number | null { return m ? toMinor(m.amount, m.currencyCode) : null; }
