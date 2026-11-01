import type { DerivedDraft, FamilyMapping, MappingContext } from "./types.js";

/**
 * Table-driven mapping from producer observations to journal tracks (GOLDEN-ORDER-TO-CASH.json
 * semantics). Every family listed in packages/contracts/events.json is accepted as a Source entry;
 * the entries below decide which additional tracks a concrete observation extends:
 *
 * - fact: typed assertion about the primary record (always for golden kinds)
 * - commitment: obligations (customer order, receivable, credit note, payout announcement)
 * - movement: actual cash/goods movements (capture, fee, refund paid, payout sent, bank credit,
 *   goods dispatched/received/restocked). Authorizations, invoice payment markers, payout
 *   announcements, return approvals and carrier delivery scans are NOT movements.
 * - reservation: stock reservations and provider holds, with explicit releases.
 */

const rid = (type: string, id: unknown): string => `${type}:${String(id)}`;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const qty = (v: unknown): string => String(num(v));
const str = (v: unknown): string => String(v ?? "");
const money = (ctx: MappingContext, field: string): { amount_minor: number; currency: string } => ({ amount_minor: num(ctx.payload[field]), currency: str(ctx.payload.currency) });

function fact(ctx: MappingContext, primary: string, eventType: string, extra: Record<string, unknown> = {}): DerivedDraft {
  const id = ctx.payload[primary] ?? ctx.entity[primary];
  return { track: "fact", record_id: rid(primary, id), event_type: eventType, payload: { ...ctx.payload, ...extra } };
}

const movementCash = (ctx: MappingContext, record: string, eventType: string, amountField: string, direction: "in" | "out", ledger: string, extra: Record<string, unknown> = {}): DerivedDraft => ({
  track: "movement",
  record_id: record,
  event_type: eventType,
  payload: { kind: "cash", direction, ledger, ...money(ctx, amountField), ...extra },
});

const movementGoods = (record: string, eventType: string, item: string, quantity: string, unit: string, direction: "in" | "out" | "transfer", extra: Record<string, unknown> = {}): DerivedDraft => ({
  track: "movement",
  record_id: record,
  event_type: eventType,
  entity_refs: { item },
  payload: { kind: "goods", direction, item, quantity, unit, ...extra },
});

const S = (field: string) => ({ field, type: "string" as const });
const I = (field: string) => ({ field, type: "integer" as const });
const N = (field: string) => ({ field, type: "number" as const });
const B = (field: string) => ({ field, type: "boolean" as const });

export const GOLDEN_FAMILIES: Record<string, FamilyMapping> = {
  "inventory.snapshot": {
    dataset: "stock",
    tracks: ["source", "fact"],
    required: [S("sku"), N("physical"), N("quarantined"), N("reserved"), S("unit")],
    entityKeys: [],
    primary: "item",
    note: "Opening/current stock observation with basis snapshot; never a goods movement.",
    derive: (ctx) => [
      {
        track: "fact",
        record_id: rid("item", ctx.entity.item ?? ctx.payload.sku),
        event_type: "inventory.snapshot",
        entity_refs: { item: str(ctx.entity.item ?? ctx.payload.sku) },
        payload: { basis: "snapshot", item: str(ctx.entity.item ?? ctx.payload.sku), physical: qty(ctx.payload.physical), quarantined: qty(ctx.payload.quarantined), reserved: qty(ctx.payload.reserved), unit: str(ctx.payload.unit), is_new_movement: false },
      },
    ],
  },
  "order.accepted": {
    dataset: "orders",
    tracks: ["source", "fact", "commitment"],
    required: [S("order"), N("quantity"), I("unit_gross_minor"), I("gross_minor"), S("currency")],
    entityKeys: ["order"],
    primary: "order",
    note: "Accepted customer order: fact plus a customer-order commitment (quantity and gross amount). No cash, no stock movement.",
    derive: (ctx) => [
      fact(ctx, "order", "order.accepted", { quantity: qty(ctx.payload.quantity), unit: ctx.unit }),
      { track: "commitment", record_id: rid("order", ctx.payload.order), event_type: "commitment.customer_order_recorded", payload: { kind: "customer_order", quantity: qty(ctx.payload.quantity), unit: ctx.unit, ...money(ctx, "gross_minor"), item: ctx.entity.item ?? null } },
    ],
  },
  "inventory.reserved": {
    dataset: "allocations",
    tracks: ["source", "fact", "reservation"],
    required: [S("reservation"), N("quantity")],
    entityKeys: ["reservation"],
    primary: "reservation",
    note: "Active stock reservation for an order line; reduces available (not physical) stock.",
    derive: (ctx) => [
      fact(ctx, "reservation", "inventory.reserved", { quantity: qty(ctx.payload.quantity), unit: ctx.unit }),
      { track: "reservation", record_id: rid("reservation", ctx.payload.reservation), event_type: "reservation.recorded", payload: { kind: "stock", state: "active", quantity: qty(ctx.payload.quantity), unit: ctx.unit, item: ctx.entity.item ?? null, order: ctx.entity.order ?? null } },
    ],
  },
  "invoice.issued": {
    dataset: "invoices",
    tracks: ["source", "fact", "commitment"],
    required: [S("invoice"), I("gross_minor"), S("currency"), S("due_date")],
    entityKeys: ["invoice"],
    primary: "invoice",
    note: "Invoice issued: receivable commitment for the gross amount (open until payment is reconciled).",
    derive: (ctx) => [
      fact(ctx, "invoice", "invoice.issued"),
      { track: "commitment", record_id: rid("invoice", ctx.payload.invoice), event_type: "commitment.receivable_recorded", payload: { kind: "receivable", ...money(ctx, "gross_minor"), due_date: str(ctx.payload.due_date), order: ctx.entity.order ?? null } },
    ],
  },
  "payment.authorized": {
    dataset: "payments",
    tracks: ["source", "fact"],
    required: [S("transaction"), I("authorized_minor"), S("currency")],
    entityKeys: ["transaction"],
    primary: "transaction",
    note: "Authorization is not a capture: fact only, no cash movement.",
    derive: (ctx) => [fact(ctx, "transaction", "payment.authorized", { is_cash_movement: false })],
  },
  "payment.captured": {
    dataset: "payments",
    tracks: ["source", "fact", "movement"],
    required: [S("transaction"), I("captured_minor"), S("currency")],
    entityKeys: ["transaction"],
    primary: "transaction",
    note: "Captured payment: cash movement into the provider balance.",
    derive: (ctx) => [fact(ctx, "transaction", "payment.captured"), movementCash(ctx, rid("transaction", ctx.payload.transaction), "movement.cash_captured", "captured_minor", "in", "provider_balance", { transaction: str(ctx.payload.transaction) })],
  },
  "payment.fee_booked": {
    dataset: "provider_ledger",
    tracks: ["source", "fact", "movement"],
    required: [S("transaction"), I("fee_minor"), S("currency")],
    entityKeys: ["transaction"],
    primary: "transaction",
    note: "Provider fee: cash movement out of the provider balance.",
    derive: (ctx) => [fact(ctx, "transaction", "payment.fee_booked"), movementCash(ctx, rid("transaction", ctx.payload.transaction), "movement.provider_fee", "fee_minor", "out", "provider_balance", { transaction: str(ctx.payload.transaction) })],
  },
  "invoice.payment_marked": {
    dataset: "invoices",
    tracks: ["source", "fact"],
    required: [S("invoice"), S("transaction"), I("paid_minor"), S("currency"), B("is_new_cash_movement")],
    entityKeys: ["invoice", "transaction"],
    primary: "invoice",
    note: "Invoice marked paid against a transaction: closes the receivable; never creates cash. Cash evidence must arrive as payment.captured (events.json gives this family no movement track), so is_new_cash_movement=true is recorded as a fact that requires payment evidence.",
    derive: (ctx) => [fact(ctx, "invoice", "invoice.payment_marked", { requires_payment_evidence: ctx.payload.is_new_cash_movement === true })],
  },
  "shipment.dispatched": {
    dataset: "fulfillments",
    tracks: ["source", "fact", "movement", "reservation"],
    required: [S("shipment"), N("quantity"), N("physical_stock_delta"), N("reservation_released"), S("reservation")],
    entityKeys: ["shipment", "reservation"],
    primary: "shipment",
    note: "Dispatch: goods movement out (physical stock delta) and release of the covering reservation.",
    derive: (ctx) => [
      fact(ctx, "shipment", "shipment.dispatched", { quantity: qty(ctx.payload.quantity), unit: ctx.unit, status: "dispatched" }),
      movementGoods(rid("shipment", ctx.payload.shipment), "movement.goods_dispatched", str(ctx.entity.item), qty(Math.abs(num(ctx.payload.physical_stock_delta))), ctx.unit, "out", { physical_stock_delta: qty(ctx.payload.physical_stock_delta), shipment: str(ctx.payload.shipment), order: ctx.entity.order ?? null }),
      { track: "reservation", record_id: rid("reservation", ctx.payload.reservation), event_type: "reservation.released", payload: { kind: "stock", state: "released", quantity: qty(ctx.payload.reservation_released), unit: ctx.unit, reason: "dispatched", shipment: str(ctx.payload.shipment) } },
    ],
  },
  "shipment.delivered": {
    dataset: "fulfillments",
    tracks: ["source", "fact"],
    required: [S("shipment"), S("carrier_status")],
    entityKeys: ["shipment"],
    primary: "shipment",
    note: "Carrier delivery observation: status fact only; goods already left stock at dispatch.",
    derive: (ctx) => [fact(ctx, "shipment", "shipment.delivered", { status: str(ctx.payload.carrier_status) })],
  },
  "return.approved": {
    dataset: "returns",
    tracks: ["source", "fact"],
    required: [S("return"), N("quantity"), I("expected_credit_minor"), S("currency")],
    entityKeys: ["return"],
    primary: "return",
    note: "Return intent/approval: not a warehouse receipt and not a credit note or refund.",
    derive: (ctx) => [fact(ctx, "return", "return.approved", { quantity: qty(ctx.payload.quantity), unit: ctx.unit, state: "approved" })],
  },
  "return.received": {
    dataset: "receipts",
    tracks: ["source", "fact", "movement"],
    required: [S("return"), N("quantity"), N("physical_stock_delta"), N("quarantine_delta")],
    entityKeys: ["return"],
    primary: "return",
    note: "Warehouse receipt of returned goods into quarantine: goods movement in; not automatically sellable.",
    derive: (ctx) => [
      fact(ctx, "return", "return.received", { quantity: qty(ctx.payload.quantity), unit: ctx.unit, state: "received" }),
      movementGoods(rid("return", ctx.payload.return), "movement.goods_received", str(ctx.entity.item), qty(ctx.payload.quantity), ctx.unit, "in", { physical_stock_delta: qty(ctx.payload.physical_stock_delta), quarantine_delta: qty(ctx.payload.quarantine_delta), to_state: "quarantined", return: str(ctx.payload.return) }),
    ],
  },
  "return.restocked": {
    dataset: "receipts",
    tracks: ["source", "fact", "movement"],
    required: [S("return"), N("quantity"), N("quarantine_delta"), N("physical_stock_delta")],
    entityKeys: ["return"],
    primary: "return",
    note: "Quarantine to sellable transfer: physical unchanged, available increases.",
    derive: (ctx) => [
      fact(ctx, "return", "return.restocked", { quantity: qty(ctx.payload.quantity), unit: ctx.unit, state: "restocked" }),
      movementGoods(rid("return", ctx.payload.return), "movement.goods_restocked", str(ctx.entity.item), qty(ctx.payload.quantity), ctx.unit, "transfer", { physical_stock_delta: qty(ctx.payload.physical_stock_delta), quarantine_delta: qty(ctx.payload.quarantine_delta), from_state: "quarantined", to_state: "available", return: str(ctx.payload.return) }),
    ],
  },
  "invoice.credit_issued": {
    dataset: "invoices",
    tracks: ["source", "fact", "commitment"],
    required: [S("credit"), S("invoice"), I("credit_minor"), S("currency"), B("cash_refund_confirmed")],
    entityKeys: ["credit", "invoice"],
    primary: "invoice",
    note: "Credit note reduces the receivable/net invoice; it is not a cash refund (cash_refund_confirmed=false).",
    derive: (ctx) => [
      fact(ctx, "invoice", "invoice.credit_issued"),
      { track: "commitment", record_id: rid("invoice", ctx.payload.invoice), event_type: "commitment.credit_note_recorded", payload: { kind: "credit_note", credit: str(ctx.payload.credit), ...money(ctx, "credit_minor"), cash_refund_confirmed: ctx.payload.cash_refund_confirmed === true } },
    ],
  },
  "refund.pending": {
    dataset: "refunds",
    tracks: ["source", "fact", "reservation"],
    required: [S("refund"), S("transaction"), I("amount_minor"), I("held_minor"), S("currency")],
    entityKeys: ["refund", "transaction"],
    primary: "refund",
    note: "Pending refund places a provider hold on the balance; no cash has left yet.",
    derive: (ctx) => [
      fact(ctx, "refund", "refund.pending", { state: "pending" }),
      { track: "reservation", record_id: rid("refund", ctx.payload.refund), event_type: "hold.recorded", payload: { kind: "provider_hold", state: "active", ...money(ctx, "held_minor"), transaction: str(ctx.payload.transaction) } },
    ],
  },
  "refund.completed": {
    dataset: "refunds",
    tracks: ["source", "fact", "movement", "reservation"],
    required: [S("refund"), S("transaction"), I("amount_minor"), I("hold_released_minor"), S("currency")],
    entityKeys: ["refund", "transaction"],
    primary: "refund",
    note: "Completed refund: cash movement out of the provider balance and release of the hold.",
    derive: (ctx) => [
      fact(ctx, "refund", "refund.completed", { state: "completed" }),
      movementCash(ctx, rid("refund", ctx.payload.refund), "movement.cash_refunded", "amount_minor", "out", "provider_balance", { refund: str(ctx.payload.refund), transaction: str(ctx.payload.transaction) }),
      { track: "reservation", record_id: rid("refund", ctx.payload.refund), event_type: "hold.released", payload: { kind: "provider_hold", state: "released", ...money(ctx, "hold_released_minor"), transaction: str(ctx.payload.transaction) } },
    ],
  },
  "payout.announced": {
    dataset: "payouts",
    tracks: ["source", "fact", "commitment"],
    required: [S("payout"), I("amount_minor"), S("currency")],
    entityKeys: ["payout"],
    primary: "payout",
    note: "Payout announcement is a provider commitment; it does not move cash.",
    derive: (ctx) => [
      fact(ctx, "payout", "payout.announced", { state: "announced" }),
      { track: "commitment", record_id: rid("payout", ctx.payload.payout), event_type: "commitment.payout_announced", payload: { kind: "payout", ...money(ctx, "amount_minor") } },
    ],
  },
  "payout.sent": {
    dataset: "payouts",
    tracks: ["source", "fact", "movement"],
    required: [S("payout"), I("amount_minor"), S("currency")],
    entityKeys: ["payout"],
    primary: "payout",
    note: "Payout sent: cash leaves the provider balance into transit; it does not establish a bank credit.",
    derive: (ctx) => [fact(ctx, "payout", "payout.sent", { state: "sent" }), movementCash(ctx, rid("payout", ctx.payload.payout), "movement.payout_sent", "amount_minor", "out", "provider_balance", { payout: str(ctx.payload.payout), to_ledger: "in_transit" })],
  },
  "bank.credit_booked": {
    dataset: "bank",
    tracks: ["source", "fact", "movement"],
    required: [S("bank_entry"), I("amount_minor"), S("currency"), S("status")],
    entityKeys: ["bank_entry", "payout"],
    primary: "bank_entry",
    note: "Independently booked bank credit; matched to a payout only when the payout reference is present and unambiguous.",
    derive: (ctx) => [
      fact(ctx, "bank_entry", "bank.credit_booked", { state: str(ctx.payload.status) }),
      movementCash(ctx, rid("bank_entry", ctx.payload.bank_entry), "movement.bank_credit", "amount_minor", "in", "bank", { bank_entry: str(ctx.payload.bank_entry), payout: ctx.payload.payout ?? null, from_ledger: ctx.payload.payout ? "in_transit" : null }),
    ],
  },
  "bank.debit_booked": {
    dataset: "bank",
    tracks: ["source", "fact", "movement"],
    required: [S("bank_entry"), I("amount_minor"), S("currency"), S("status")],
    entityKeys: ["bank_entry"],
    primary: "bank_entry",
    note: "Independently booked bank debit.",
    derive: (ctx) => [fact(ctx, "bank_entry", "bank.debit_booked", { state: str(ctx.payload.status) }), movementCash(ctx, rid("bank_entry", ctx.payload.bank_entry), "movement.bank_debit", "amount_minor", "out", "bank", { bank_entry: str(ctx.payload.bank_entry) })],
  },
  "business.rule_recorded": {
    dataset: "policy",
    tracks: ["source", "fact"],
    required: [S("rule"), N("version")],
    entityKeys: ["rule"],
    primary: "rule",
    note: "Merchant policy/rule version recorded as a fact; later versions supersede by reference.",
    derive: (ctx) => [fact(ctx, "rule", "business.rule_recorded")],
  },
};

/** Primary entity type per dataset for families without an explicit mapping (generic fact). */
export const DATASET_PRIMARY: Record<string, string> = {
  orders: "order",
  stock: "item",
  allocations: "reservation",
  supply: "supply",
  promises: "promise",
  fulfillments: "shipment",
  tracking: "shipment",
  communications: "communication",
  invoices: "invoice",
  invoice_dispatch: "invoice",
  payments: "transaction",
  payment_allocations: "transaction",
  policy: "rule",
  cases: "case",
  provider_ledger: "transaction",
  positions: "account",
  payouts: "payout",
  bank: "bank_entry",
  holds: "hold",
  returns: "return",
  receipts: "return",
  entitlements: "entitlement",
  refunds: "refund",
  disputes: "dispute",
  coverage: "coverage",
  identity: "link",
};
