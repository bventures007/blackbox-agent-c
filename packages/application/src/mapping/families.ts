import type { FamilyMapping } from "./types.js";

/**
 * Validation/description table for the golden families (GOLDEN-ORDER-TO-CASH.json semantics).
 * The journal entry shapes themselves are produced by the shared builder in
 * `@blackbox/connectors` (`buildEntryDrafts`): every family yields one Source entry plus the
 * derived tracks listed in `DERIVED_TRACKS` there, all with event_type = family kind and the flat
 * golden payload the Rust reducers read. This table adds what the producer paths check before
 * appending (required typed fields, entity keys) and the semantic note shown by
 * describe_business_schema:
 *
 * - fact: typed assertion about the primary record (always for golden kinds)
 * - commitment: obligations (customer order, receivable, credit note, payout announcement)
 * - movement: actual cash/goods movements (capture, fee, refund paid, payout sent, bank credit,
 *   goods dispatched/received/restocked). Authorizations, invoice payment markers, payout
 *   announcements, return approvals and carrier delivery scans are NOT movements.
 * - reservation: stock reservations and provider holds, with explicit releases.
 */

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
  },
  "order.accepted": {
    dataset: "orders",
    tracks: ["source", "fact", "commitment"],
    required: [S("order"), N("quantity"), I("unit_gross_minor"), I("gross_minor"), S("currency")],
    entityKeys: ["order"],
    primary: "order",
    note: "Accepted customer order: fact plus a customer-order commitment (quantity and gross amount). No cash, no stock movement.",
  },
  "inventory.reserved": {
    dataset: "allocations",
    tracks: ["source", "fact", "reservation"],
    required: [S("reservation"), N("quantity")],
    entityKeys: ["reservation"],
    primary: "reservation",
    note: "Active stock reservation for an order line; reduces available (not physical) stock.",
  },
  "invoice.issued": {
    dataset: "invoices",
    tracks: ["source", "fact", "commitment"],
    required: [S("invoice"), I("gross_minor"), S("currency"), S("due_date")],
    entityKeys: ["invoice"],
    primary: "invoice",
    note: "Invoice issued: receivable commitment for the gross amount (open until payment is reconciled).",
  },
  "payment.authorized": {
    dataset: "payments",
    tracks: ["source", "fact"],
    required: [S("transaction"), I("authorized_minor"), S("currency")],
    entityKeys: ["transaction"],
    primary: "transaction",
    note: "Authorization is not a capture: fact only, no cash movement.",
  },
  "payment.captured": {
    dataset: "payments",
    tracks: ["source", "fact", "movement"],
    required: [S("transaction"), I("captured_minor"), S("currency")],
    entityKeys: ["transaction"],
    primary: "transaction",
    note: "Captured payment: cash movement into the provider balance.",
  },
  "payment.fee_booked": {
    dataset: "provider_ledger",
    tracks: ["source", "fact", "movement"],
    required: [S("transaction"), I("fee_minor"), S("currency")],
    entityKeys: ["transaction"],
    primary: "transaction",
    note: "Provider fee: cash movement out of the provider balance.",
  },
  "invoice.payment_marked": {
    dataset: "invoices",
    tracks: ["source", "fact"],
    required: [S("invoice"), S("transaction"), I("paid_minor"), S("currency"), B("is_new_cash_movement")],
    entityKeys: ["invoice", "transaction"],
    primary: "invoice",
    note: "Invoice marked paid against a transaction: closes the receivable; never creates cash. Cash evidence must arrive as payment.captured (events.json gives this family no movement track), so is_new_cash_movement=true is recorded as a fact that requires payment evidence.",
  },
  "shipment.dispatched": {
    dataset: "fulfillments",
    tracks: ["source", "fact", "movement", "reservation"],
    required: [S("shipment"), N("quantity"), N("physical_stock_delta"), N("reservation_released"), S("reservation")],
    entityKeys: ["shipment", "reservation"],
    primary: "shipment",
    note: "Dispatch: goods movement out (physical stock delta) and release of the covering reservation.",
  },
  "shipment.delivered": {
    dataset: "fulfillments",
    tracks: ["source", "fact"],
    required: [S("shipment"), S("carrier_status")],
    entityKeys: ["shipment"],
    primary: "shipment",
    note: "Carrier delivery observation: status fact only; goods already left stock at dispatch.",
  },
  "return.approved": {
    dataset: "returns",
    tracks: ["source", "fact"],
    required: [S("return"), N("quantity"), I("expected_credit_minor"), S("currency")],
    entityKeys: ["return"],
    primary: "return",
    note: "Return intent/approval: not a warehouse receipt and not a credit note or refund.",
  },
  "return.received": {
    dataset: "receipts",
    tracks: ["source", "fact", "movement"],
    required: [S("return"), N("quantity"), N("physical_stock_delta"), N("quarantine_delta")],
    entityKeys: ["return"],
    primary: "return",
    note: "Warehouse receipt of returned goods into quarantine: goods movement in; not automatically sellable.",
  },
  "return.restocked": {
    dataset: "receipts",
    tracks: ["source", "fact", "movement"],
    required: [S("return"), N("quantity"), N("quarantine_delta"), N("physical_stock_delta")],
    entityKeys: ["return"],
    primary: "return",
    note: "Quarantine to sellable transfer: physical unchanged, available increases.",
  },
  "invoice.credit_issued": {
    dataset: "invoices",
    tracks: ["source", "fact", "commitment"],
    required: [S("credit"), S("invoice"), I("credit_minor"), S("currency"), B("cash_refund_confirmed")],
    entityKeys: ["credit", "invoice"],
    primary: "invoice",
    note: "Credit note reduces the receivable/net invoice; it is not a cash refund (cash_refund_confirmed=false).",
  },
  "refund.pending": {
    dataset: "refunds",
    tracks: ["source", "fact", "reservation"],
    required: [S("refund"), S("transaction"), I("amount_minor"), I("held_minor"), S("currency")],
    entityKeys: ["refund", "transaction"],
    primary: "refund",
    note: "Pending refund places a provider hold on the balance; no cash has left yet.",
  },
  "refund.completed": {
    dataset: "refunds",
    tracks: ["source", "fact", "movement", "reservation"],
    required: [S("refund"), S("transaction"), I("amount_minor"), I("hold_released_minor"), S("currency")],
    entityKeys: ["refund", "transaction"],
    primary: "refund",
    note: "Completed refund: cash movement out of the provider balance and release of the hold.",
  },
  "payout.announced": {
    dataset: "payouts",
    tracks: ["source", "fact", "commitment"],
    required: [S("payout"), I("amount_minor"), S("currency")],
    entityKeys: ["payout"],
    primary: "payout",
    note: "Payout announcement is a provider commitment; it does not move cash.",
  },
  "payout.sent": {
    dataset: "payouts",
    tracks: ["source", "fact", "movement"],
    required: [S("payout"), I("amount_minor"), S("currency")],
    entityKeys: ["payout"],
    primary: "payout",
    note: "Payout sent: cash leaves the provider balance into transit; it does not establish a bank credit.",
  },
  "bank.credit_booked": {
    dataset: "bank",
    tracks: ["source", "fact", "movement"],
    required: [S("bank_entry"), I("amount_minor"), S("currency"), S("status")],
    entityKeys: ["bank_entry", "payout"],
    primary: "bank_entry",
    note: "Independently booked bank credit; matched to a payout only when the payout reference is present and unambiguous.",
  },
  "bank.debit_booked": {
    dataset: "bank",
    tracks: ["source", "fact", "movement"],
    required: [S("bank_entry"), I("amount_minor"), S("currency"), S("status")],
    entityKeys: ["bank_entry"],
    primary: "bank_entry",
    note: "Independently booked bank debit.",
  },
  "business.rule_recorded": {
    dataset: "policy",
    tracks: ["source", "fact"],
    required: [S("rule"), N("version")],
    entityKeys: ["rule"],
    primary: "rule",
    note: "Merchant policy/rule version recorded as a fact; later versions supersede by reference.",
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
