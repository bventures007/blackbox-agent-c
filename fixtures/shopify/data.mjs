// Deterministic, seeded, provider-shaped synthetic Shopify data. No real payloads are copied; field names
// follow the public GraphQL Admin API schema. Amounts/ids vary with the seed. Synthetic only.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const money = (minor, currency = 'EUR') => ({ amount: (minor / 100).toFixed(2), currencyCode: currency });
const bag = (minor, currency) => ({ shopMoney: money(minor, currency) });
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;

export function generate({ seed = 42, orders = 40, clock = Date.now(), currency = 'EUR' } = {}) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const shopId = 1000 + (seed % 1000);
  const shop = { id: `gid://shopify/Shop/${shopId}`, name: `Fixture Shop ${seed}`, myshopifyDomain: `fixture-${seed}.myshopify.com`, currencyCode: currency, ianaTimezone: 'Europe/Berlin' };
  const locations = [{ id: 'gid://shopify/Location/1' }, { id: 'gid://shopify/Location/2' }];
  const catalog = Array.from({ length: 6 }, (_, i) => ({
    variantId: `gid://shopify/ProductVariant/${7000 + i}`, inventoryItemId: `gid://shopify/InventoryItem/${8000 + i}`, sku: `SKU-${seed}-${i}`, unitMinor: 500 + int(0, 60) * 100,
  }));
  const customers = Array.from({ length: 12 }, (_, i) => `gid://shopify/Customer/${9000 + i}`);

  let txnSeq = 20000, lineSeq = 30000, fulSeq = 40000, refSeq = 50000, retSeq = 60000, rfoSeq = 70000, dispSeq = 80000, foSeq = 90000;
  const orderList = [];
  const balanceTxns = [];
  const disputes = [];
  const base = clock - 55 * DAY;
  for (let i = 0; i < orders; i++) {
    const idNum = 5001 + i;
    const createdAt = base + Math.floor((i / orders) * 54 * DAY) + int(0, 3600_000);
    const lines = Array.from({ length: int(1, 3) }, () => {
      const c = pick(catalog); const qty = int(1, 10);
      const original = c.unitMinor * qty; const discount = rnd() < 0.3 ? Math.round(original * 0.1) : 0;
      const net = original - discount; const tax = Math.round(net * 0.19 / 1.19);
      return { id: `gid://shopify/LineItem/${lineSeq++}`, sku: c.sku, quantity: qty, currentQuantity: qty, unfulfilledQuantity: qty, variant: { id: c.variantId, inventoryItem: { id: c.inventoryItemId } }, originalTotalSet: bag(original, currency), discountedTotalSet: bag(net, currency), totalDiscountSet: bag(discount, currency), taxLines: [{ priceSet: bag(tax, currency) }], _unit: c.unitMinor };
    });
    const shipping = pick([0, 490, 590, 0]);
    const subtotal = lines.reduce((a, l) => a + Number(l.discountedTotalSet.shopMoney.amount) * 100, 0);
    const total = Math.round(subtotal) + shipping;
    const pattern = i % 8;
    const test = pattern === 6;
    const txns = []; const refunds = []; const fulfillments = []; const returns = [];
    let cancelledAt = null; let updatedAt = createdAt + int(60_000, 600_000); let financial = 'PAID'; let fulfillmentStatus = 'UNFULFILLED';
    const t = (kind, status, minor, parent, at, extra = {}) => { const id = `gid://shopify/OrderTransaction/${txnSeq++}`; txns.push({ id, kind, status, test, gateway: test ? 'bogus' : 'shopify_payments', processedAt: iso(at), createdAt: iso(at), errorCode: status === 'FAILURE' ? 'card_declined' : null, amountSet: bag(minor, currency), parentTransaction: parent ? { id: parent } : null, ...extra }); return id; };
    if (pattern === 0) { const a = t('AUTHORIZATION', 'SUCCESS', total, null, createdAt + 1000); t('CAPTURE', 'SUCCESS', total, a, createdAt + 3_600_000); }
    else if (pattern === 1) t('SALE', 'SUCCESS', total, null, createdAt + 1000);
    else if (pattern === 2) { t('AUTHORIZATION', 'FAILURE', total, null, createdAt + 500); const a = t('AUTHORIZATION', 'SUCCESS', total, null, createdAt + 2000); t('CAPTURE', 'SUCCESS', total, a, createdAt + 7_200_000); }
    else if (pattern === 3) { t('AUTHORIZATION', 'SUCCESS', total, null, createdAt + 1000); financial = 'AUTHORIZED'; }
    else if (pattern === 4) {
      const s = t('SALE', 'SUCCESS', total, null, createdAt + 1000);
      const line = lines[0]; const rq = 1; const refundMinor = line._unit * rq;
      const rAt = createdAt + 5 * DAY; updatedAt = Math.max(updatedAt, rAt + 60_000);
      const rid = t('REFUND', 'SUCCESS', refundMinor, s, rAt);
      refunds.push({ id: `gid://shopify/Refund/${refSeq++}`, createdAt: iso(rAt), updatedAt: iso(rAt), totalRefundedSet: bag(refundMinor, currency),
        refundLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ quantity: rq, restockType: 'RETURN', restocked: true, location: locations[0], lineItem: { id: line.id } }] },
        transactions: { pageInfo: { hasNextPage: false }, nodes: [txns.find((x) => x.id === rid)] } });
      line.currentQuantity = line.quantity - rq;
      const rfoLine = { id: `gid://shopify/ReverseFulfillmentOrderLineItem/${rfoSeq++}`, fulfillmentLineItem: { lineItem: { id: line.id } }, dispositions: i % 16 === 4 ? [{ id: `gid://shopify/ReverseFulfillmentOrderDisposition/${dispSeq++}`, type: 'PROCESSING_REQUIRED', quantity: rq, location: locations[0] }, { id: `gid://shopify/ReverseFulfillmentOrderDisposition/${dispSeq++}`, type: 'RESTOCKED', quantity: rq, location: locations[0] }] : [{ id: `gid://shopify/ReverseFulfillmentOrderDisposition/${dispSeq++}`, type: 'RESTOCKED', quantity: rq, location: locations[0] }] };
      returns.push({ id: `gid://shopify/Return/${retSeq++}`, status: 'OPEN', returnLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: `gid://shopify/ReturnLineItem/${retSeq++}`, quantity: rq, fulfillmentLineItem: { lineItem: { id: line.id } } }] }, reverseFulfillmentOrders: { nodes: [{ id: `gid://shopify/ReverseFulfillmentOrder/${rfoSeq++}`, status: 'OPEN', lineItems: { nodes: [rfoLine] } }] } });
      financial = 'PARTIALLY_REFUNDED';
      balanceTxns.push({ _at: rAt + 1000, type: 'REFUND', test, gross: -refundMinor, fee: 0, srcTxn: rid, order: `gid://shopify/Order/${idNum}` });
    }
    else if (pattern === 5) { const a = t('AUTHORIZATION', 'SUCCESS', total, null, createdAt + 1000); t('VOID', 'SUCCESS', total, a, createdAt + 2 * DAY); cancelledAt = createdAt + 2 * DAY; updatedAt = cancelledAt + 1000; financial = 'VOIDED'; }
    else if (pattern === 6) t('SALE', 'SUCCESS', total, null, createdAt + 1000);
    else if (pattern === 7) { t('SALE', 'PENDING', total, null, createdAt + 1000); financial = 'PENDING'; }
    // Fulfillments for paid orders.
    const paid = txns.some((x) => (x.kind === 'CAPTURE' || x.kind === 'SALE') && x.status === 'SUCCESS');
    if (paid && !cancelledAt && pattern !== 6) {
      const fAt = createdAt + DAY; const delivered = i % 3 === 0 ? fAt + 2 * DAY : null; const pending = i % 5 === 2;
      fulfillments.push({ id: `gid://shopify/Fulfillment/${fulSeq++}`, status: pending ? 'PENDING' : 'SUCCESS', createdAt: iso(fAt), updatedAt: iso(delivered ?? fAt), inTransitAt: pending ? null : iso(fAt + 3_600_000), deliveredAt: delivered ? iso(delivered) : null, location: locations[0], trackingInfo: pending ? [] : [{ company: 'DHL', number: `00340${seed}${idNum}` }], fulfillmentLineItems: { pageInfo: { hasNextPage: false }, nodes: lines.map((l) => ({ id: `gid://shopify/FulfillmentLineItem/${fulSeq++}`, quantity: l.quantity, lineItem: { id: l.id } })) } });
      if (!pending) { fulfillmentStatus = 'FULFILLED'; for (const l of lines) l.unfulfilledQuantity = 0; updatedAt = Math.max(updatedAt, delivered ?? fAt); }
    }
    // Ledger entries for successful captures/sales.
    for (const x of txns) if ((x.kind === 'CAPTURE' || x.kind === 'SALE') && x.status === 'SUCCESS') {
      const gross = Math.round(Number(x.amountSet.shopMoney.amount) * 100); const fee = Math.round(gross * 0.029) + 30;
      balanceTxns.push({ _at: Date.parse(x.processedAt) + 1000, type: 'CHARGE', test, gross, fee, srcTxn: x.id, order: `gid://shopify/Order/${idNum}` });
    }
    const edited = i % 3 === 0 && pattern !== 5;
    if (edited) updatedAt = Math.max(updatedAt, createdAt + 3 * DAY);
    // Provider timestamps never lie in the future of the fixture clock.
    updatedAt = Math.min(updatedAt, clock - 60_000);
    for (const f of fulfillments) { if (Date.parse(f.updatedAt) > clock - 60_000) { f.updatedAt = iso(clock - 60_000); } if (f.deliveredAt && Date.parse(f.deliveredAt) > clock - 60_000) { f.deliveredAt = null; f.updatedAt = iso(Math.min(Date.parse(f.updatedAt), clock - 60_000)); } }
    const current = lines.reduce((a, l) => a + Number(l.discountedTotalSet.shopMoney.amount) * 100 * (l.currentQuantity / l.quantity), 0) + shipping;
    orderList.push({
      id: `gid://shopify/Order/${idNum}`, name: `#${1001 + i}`, createdAt: iso(createdAt), updatedAt: iso(updatedAt), cancelledAt: cancelledAt ? iso(cancelledAt) : null, closedAt: fulfillmentStatus === 'FULFILLED' && financial === 'PAID' ? iso(updatedAt) : null, test, currencyCode: currency,
      displayFinancialStatus: financial, displayFulfillmentStatus: fulfillmentStatus, customer: { id: pick(customers) },
      originalTotalPriceSet: bag(total, currency), currentTotalPriceSet: bag(Math.round(current), currency), totalShippingPriceSet: bag(shipping, currency), totalTaxSet: bag(lines.reduce((a, l) => a + Number(l.taxLines[0].priceSet.shopMoney.amount) * 100, 0), currency), totalDiscountsSet: bag(lines.reduce((a, l) => a + Number(l.totalDiscountSet.shopMoney.amount) * 100, 0), currency),
      lineItems: lines.map(({ _unit, ...l }) => l), transactions: txns, fulfillments, refunds, returns,
      _createdMs: createdAt, _updatedMs: updatedAt, _financial: financial.toLowerCase(), _fulfillment: fulfillmentStatus.toLowerCase(), _open: !cancelledAt && !(fulfillmentStatus === 'FULFILLED' && financial === 'PAID'),
    });
  }
  // Inventory levels.
  const inventoryItems = catalog.map((c, i) => ({ id: c.inventoryItemId, sku: c.sku, tracked: true, updatedAt: iso(clock - int(0, 10) * DAY), inventoryLevels: locations.map((loc, j) => {
    const onHand = int(20, 200); const committed = int(0, 10); const reserved = int(0, 5); const damaged = i === 1 && j === 0 ? 3 : 0; const qc = i === 2 && j === 1 ? 4 : 0;
    const updatedAt = iso(clock - int(0, 10) * DAY - j * 3600_000);
    return { id: `gid://shopify/InventoryLevel/${100 + i * 10 + j}`, updatedAt, location: loc, _updatedMs: Date.parse(updatedAt), quantities: [
      { name: 'available', quantity: onHand - committed - reserved - damaged - qc }, { name: 'on_hand', quantity: onHand }, { name: 'committed', quantity: committed }, { name: 'reserved', quantity: reserved }, { name: 'damaged', quantity: damaged }, { name: 'safety_stock', quantity: 0 }, { name: 'quality_control', quantity: qc }, { name: 'incoming', quantity: i === 0 ? 50 : 0 }] };
  }) }));
  for (const it of inventoryItems) it._updatedMs = Math.max(...it.inventoryLevels.map((l) => l._updatedMs));
  // Fulfillment orders for unfulfilled, non-cancelled orders.
  const fulfillmentOrders = orderList.filter((o) => o._fulfillment === 'unfulfilled' && !o.cancelledAt).map((o) => ({ id: `gid://shopify/FulfillmentOrder/${foSeq++}`, status: 'OPEN', requestStatus: 'UNSUBMITTED', createdAt: o.createdAt, updatedAt: o.updatedAt, _updatedMs: o._updatedMs, assignedLocation: { location: locations[0] }, order: { id: o.id }, lineItems: { pageInfo: { hasNextPage: false }, nodes: o.lineItems.map((l) => ({ id: `gid://shopify/FulfillmentOrderLineItem/${foSeq++}`, totalQuantity: l.quantity, remainingQuantity: l.unfulfilledQuantity, lineItem: { id: l.id }, inventoryItemId: l.variant.inventoryItem.id })) } }));
  // Payouts (weekly) and remaining ledger entries.
  const account = { id: `gid://shopify/ShopifyPaymentsAccount/${shopId}`, activated: true, defaultCurrency: currency, country: 'DE' };
  const payouts = [];
  const weeks = 8;
  for (let w = 0; w < weeks; w++) {
    const issued = clock - (weeks - w) * 7 * DAY + 3 * DAY;
    const status = w === weeks - 1 ? 'SCHEDULED' : w === weeks - 2 ? 'IN_TRANSIT' : w === 2 ? 'FAILED' : 'PAID';
    payouts.push({ id: `gid://shopify/ShopifyPaymentsPayout/${100000 + w}`, status, issuedAt: iso(issued), _issuedMs: issued, transactionType: 'DEPOSIT', net: money(0, currency), summary: { chargesFee: money(0, currency), chargesGross: money(0, currency), refundsFee: money(0, currency), refundsFeeGross: money(0, currency), adjustmentsFee: money(0, currency), adjustmentsGross: money(0, currency), reservedFundsFee: money(0, currency), reservedFundsGross: money(0, currency), retriedPayoutsFee: money(0, currency), retriedPayoutsGross: money(0, currency) } });
  }
  // Dispute on the first CHARGE older than 20 days.
  const disputedCharge = balanceTxns.find((b) => b.type === 'CHARGE' && b._at < clock - 20 * DAY && !b.test);
  if (disputedCharge) {
    const dId = `gid://shopify/ShopifyPaymentsDispute/${200001}`;
    disputes.push({ id: dId, status: 'NEEDS_RESPONSE', type: 'CHARGEBACK', initiatedAt: iso(disputedCharge._at + 10 * DAY), _initiatedMs: disputedCharge._at + 10 * DAY, finalizedOn: null, evidenceDueBy: iso(disputedCharge._at + 17 * DAY), amount: money(disputedCharge.gross, currency), reasonDetails: { reason: 'PRODUCT_NOT_RECEIVED', networkReasonCode: '13.1' }, order: { id: disputedCharge.order } });
    balanceTxns.push({ _at: disputedCharge._at + 10 * DAY, type: 'DISPUTE', test: false, gross: -disputedCharge.gross, fee: 1500, srcTxn: disputedCharge.srcTxn, order: disputedCharge.order, sourceId: '200001' });
    const second = balanceTxns.filter((b) => b.type === 'CHARGE' && b._at < clock - 25 * DAY && !b.test)[1];
    if (second) {
      const d2 = `gid://shopify/ShopifyPaymentsDispute/${200002}`;
      disputes.push({ id: d2, status: 'WON', type: 'CHARGEBACK', initiatedAt: iso(second._at + 5 * DAY), _initiatedMs: second._at + 5 * DAY, finalizedOn: iso(second._at + 15 * DAY), evidenceDueBy: iso(second._at + 12 * DAY), amount: money(second.gross, currency), reasonDetails: { reason: 'FRAUDULENT', networkReasonCode: '10.4' }, order: { id: second.order } });
      balanceTxns.push({ _at: second._at + 5 * DAY, type: 'DISPUTE', test: false, gross: -second.gross, fee: 1500, srcTxn: second.srcTxn, order: second.order, sourceId: '200002' });
      balanceTxns.push({ _at: second._at + 15 * DAY, type: 'DISPUTE_REVERSAL', test: false, gross: second.gross, fee: -1500, srcTxn: second.srcTxn, order: second.order, sourceId: '200002' });
    }
  }
  balanceTxns.push({ _at: clock - 12 * DAY, type: 'ADJUSTMENT', test: false, gross: -250, fee: 0, srcTxn: null, order: null, adjustmentReason: 'Manual correction' });
  balanceTxns.sort((a, b) => a._at - b._at);
  let btSeq = 300000;
  const balanceTransactions = balanceTxns.map((b) => {
    const payout = b.test ? null : payouts.find((p) => p._issuedMs > b._at && p.status !== 'FAILED') ?? null;
    if (payout) { payout.net = money(Math.round(Number(payout.net.amount) * 100) + b.gross - b.fee, currency); }
    return { id: `gid://shopify/ShopifyPaymentsBalanceTransaction/${btSeq++}`, type: b.type, test: b.test, transactionDate: iso(b._at), _processedMs: b._at, amount: money(b.gross, currency), fee: money(b.fee, currency), net: money(b.gross - b.fee, currency), sourceId: b.sourceId ?? (b.srcTxn ? b.srcTxn.split('/').pop() : null), sourceType: b.type === 'CHARGE' ? 'CHARGE' : b.type === 'REFUND' ? 'REFUND' : b.type === 'ADJUSTMENT' ? 'ADJUSTMENT' : 'DISPUTE', sourceOrderTransactionId: b.srcTxn ? b.srcTxn.split('/').pop() : null, adjustmentReason: b.adjustmentReason ?? null, associatedOrder: b.order ? { id: b.order } : null, associatedPayout: payout ? { id: payout.id, status: payout.status } : { id: null, status: null } };
  });
  for (const p of payouts) p.transactionType = Number(p.net.amount) < 0 ? 'WITHDRAWAL' : 'DEPOSIT';
  const balance = [money(balanceTransactions.filter((b) => !b.test && (!b.associatedPayout.id || payouts.find((p) => p.id === b.associatedPayout.id)?.status === 'SCHEDULED')).reduce((a, b) => a + Math.round(Number(b.net.amount) * 100), 0), currency)];
  return { shop, scopes: ['read_orders', 'read_all_orders', 'read_products', 'read_inventory', 'read_fulfillments', 'read_returns', 'read_merchant_managed_fulfillment_orders', 'read_assigned_fulfillment_orders', 'read_shopify_payments_payouts', 'read_shopify_payments_disputes'], orders: orderList, inventoryItems, fulfillmentOrders, account: { ...account, balance }, payouts, balanceTransactions, disputes };
}
