#!/usr/bin/env node
// QUERY-01/02 question coverage against a RUNNING installed stack: all 24 intents through the HTTP API
// and the stdio MCP bridge (official SDK client), positive paths on a coverage scenario ported from
// apps/engine/tests/intents_http.rs (ids carry the suffix "-Q" so they stay disjoint from the labeled
// GOLDEN demo already in the owner workspace), missing-data paths on a sparse synthetic workspace
// (create-tenant --seed-order + create-tenant-agent-key, no owner), and an as_of re-check after a
// restart. Writes sanitized per-intent evidence to the output directory (no keys or cookies).
//
//   node tests/questions/coverage.mjs --phase positive|restart --api http://127.0.0.1:19185 \
//     --owner-key-file <file> --sparse-key-file <file> --out reports/evidence/QUERY-01 [--state <state.json>]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const PHASE = opt("phase", "positive");
const API = opt("api", "http://127.0.0.1:19185");
const OUT = opt("out", "reports/evidence/QUERY-01");
const STATE_FILE = opt("state", path.join(OUT, "state.json"));
const OWNER_KEY_FILE = opt("owner-key-file");
const SPARSE_KEY_FILE = opt("sparse-key-file");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MCP_SERVER = process.env.BLACKBOX_MCP_SERVER ?? path.join(repo, "packages/mcp/dist/server.js");
mkdirSync(OUT, { recursive: true });
const NOW = "2026-10-31T10:00:00Z";
const Q = (id) => `${id}-Q`;
const t = (h, m) => `2026-10-31T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

// ----- owner session ------------------------------------------------------------------------------------------
async function owner() {
  const key = readFileSync(OWNER_KEY_FILE, "utf8").trim();
  const login = await fetch(API + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: API }, body: JSON.stringify({ key, remember: false }) });
  if (login.status !== 204) throw new Error(`owner login ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const sess = await (await fetch(API + "/api/auth/session", { headers: { cookie } })).json();
  return { headers: { cookie, origin: API, "x-blackbox-csrf": sess.csrf_token, "content-type": "application/json" }, tenant_id: sess.workspace.tenant_id };
}
async function ownerJson(o, method, url, body) {
  const r = await fetch(API + url, { method, headers: o.headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
async function agentPost(key, url, body) {
  const r = await fetch(API + url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ----- MCP bridge ------------------------------------------------------------------------------------------------
async function bridge(keyFile) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_SERVER], env: { ...process.env, BLACKBOX_API_URL: API, BLACKBOX_AGENT_KEY_FILE: keyFile }, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "blackbox-question-coverage", version: "1.0.0" });
  await client.connect(transport);
  return {
    async answer(intent, params, consistency) {
      const r = await client.callTool({ name: "answer_question", arguments: { intent, params, ...(consistency ? { consistency } : {}) } });
      const text = r.content?.find((c) => c.type === "text")?.text ?? "";
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* ignore */
      }
      return { status: r.isError ? 500 : 200, json };
    },
    close: () => client.close().catch(() => {}),
  };
}

// ----- scenario (ported from intents_http.rs coverage_events; ids suffixed with -Q) ---------------------------------
const EVENTS = [];
let n = 0;
const ev = (conn, kind, at, entity, payload) => EVENTS.push({ provider_event_id: `C${String(++n).padStart(3, "0")}`, connection: conn, kind, occurred_at: at, entity, payload, evidence_refs: [] });
const CUP = Q("CUP-OLV"), MUG = Q("MUG-BLK");
ev("stock", "inventory.snapshot", t(8, 30), { item: CUP }, { sku: CUP, physical: 120, committed: 34, reserved: 0, quarantined: 0, damaged: 0, safety_stock: 0, quality_control: 0, available: 86, incoming: 80, unit: "piece" });
ev("stock", "inventory.snapshot", t(8, 0), { item: MUG }, { sku: MUG, physical: 10, quarantined: 0, reserved: 0, unit: "piece" });
ev("generic", "supply.commitment_recorded", t(8, 1), { item: CUP }, { promise: Q("P-S1"), supplier: Q("SUP-1"), quantity: 50, unit: "piece", promised_at: "2026-11-03", allocation_links: [Q("#D")] });
ev("generic", "supply.commitment_revised", t(8, 2), { item: CUP }, { promise: Q("P-S1"), promised_at: "2026-11-05" });
ev("shop", "order.accepted", t(8, 3), { order: Q("#D"), customer: Q("C-D"), item: CUP }, { order: Q("#D"), quantity: 5, unit_gross_minor: 1190, gross_minor: 5950, currency: "EUR", unit: "piece" });
ev("generic", "customer.commitment_recorded", t(8, 4), { order: Q("#D"), customer: Q("C-D") }, { promise: Q("P-D"), promised_at: "2026-11-04T17:00:00Z", timezone: "Europe/Berlin", promise_kind: "delivery_date" });
ev("shop", "order.accepted", t(8, 5), { order: Q("#A2"), customer: Q("C-A"), item: MUG }, { order: Q("#A2"), quantity: 6, unit_gross_minor: 900, gross_minor: 5400, currency: "EUR", unit: "piece" });
ev("shop", "order.accepted", t(8, 6), { order: Q("#B2"), customer: Q("C-B"), item: MUG }, { order: Q("#B2"), quantity: 6, unit_gross_minor: 900, gross_minor: 5400, currency: "EUR", unit: "piece" });
ev("policy", "business.rule_recorded", t(8, 7), {}, { rule: Q("RULE-1"), rule_kind: "operations", version: 1, effective_from: "2026-10-01", priority_method: "accepted_at", invoicing_trigger: "after_confirmed_dispatch", reminder_policy: "review_overdue", attention_rule: "exceptions_require_attention", stale_scan_seconds: 86400, risk_hours: 24, timezone: "Europe/Berlin", currency: "EUR" });
ev("shop", "order.accepted", t(8, 8), { order: Q("#V"), customer: Q("C-V"), item: CUP }, { order: Q("#V"), quantity: 10, unit_gross_minor: 1190, gross_minor: 11900, currency: "EUR", unit: "piece" });
ev("shop", "inventory.reserved", t(8, 9), { order: Q("#V"), customer: Q("C-V"), item: CUP }, { reservation: Q("R-V"), quantity: 4 });
ev("shop", "order.cancelled", t(8, 10), { order: Q("#V"), customer: Q("C-V") }, { order: Q("#V"), quantity: 2 });
ev("shop", "shipment.dispatched", t(8, 11), { order: Q("#V"), customer: Q("C-V"), item: CUP }, { shipment: Q("SV1"), quantity: 3, carrier: "dhl", tracking_number: Q("TRK-V1"), physical_stock_delta: 0, reservation_released: 0, reservation: Q("R-V") });
ev("shop", "order.accepted", t(7, 0), { order: Q("#S"), customer: Q("C-S"), item: CUP }, { order: Q("#S"), quantity: 1, unit_gross_minor: 1190, gross_minor: 1190, currency: "EUR", unit: "piece" });
ev("shop", "shipment.dispatched", t(8, 0), { order: Q("#S"), customer: Q("C-S"), item: CUP }, { shipment: Q("S1"), quantity: 1, carrier: "dhl", tracking_number: Q("TRK-S1"), physical_stock_delta: 0, reservation_released: 0, reservation: Q("R-S") });
ev("carrier", "carrier.scan_observed", t(9, 0), { order: Q("#S"), shipment: Q("S1") }, { shipment: Q("S1"), tracking_number: Q("TRK-S1"), status_code: "exception", effective_time: "2026-10-31T09:00:00Z", scan_identity: Q("scan-1") });
ev("generic", "coverage.observed", t(9, 1), {}, { connection: "carrier", capability: "tracking", backfill_complete: true, history_start: "2026-10-01", complete_through: "2026-10-31T10:00:00Z" });
ev("shop", "order.accepted", t(6, 0), { order: Q("#P"), customer: Q("C-P"), item: CUP }, { order: Q("#P"), quantity: 1, unit_gross_minor: 1190, gross_minor: 1190, currency: "EUR", unit: "piece" });
ev("generic", "customer.commitment_recorded", t(6, 1), { order: Q("#P"), customer: Q("C-P") }, { promise: Q("P-P"), promised_at: "2026-10-30T17:00:00+01:00", timezone: "Europe/Berlin", promise_kind: "delivery_date" });
ev("shop", "shipment.dispatched", t(6, 2), { order: Q("#P"), customer: Q("C-P"), item: CUP }, { shipment: Q("S-P"), quantity: 1, carrier: "dhl", tracking_number: Q("TRK-P"), physical_stock_delta: 0, reservation_released: 0, reservation: Q("R-P") });
ev("carrier", "carrier.scan_observed", t(7, 0), { order: Q("#P"), shipment: Q("S-P") }, { shipment: Q("S-P"), status_code: "in_transit", effective_time: "2026-10-31T07:00:00Z" });
ev("generic", "communication.observed", t(7, 30), { order: Q("#P"), customer: Q("C-P") }, { message: Q("M-P"), sent_at: "2026-10-31T07:30:00Z", actor: "support", summary: "We will update you after the next scan." });
ev("shop", "order.accepted", t(5, 0), { order: Q("#G"), customer: Q("C-G"), item: CUP }, { order: Q("#G"), quantity: 10, unit_gross_minor: 1190, gross_minor: 11900, currency: "EUR", unit: "piece" });
ev("shop", "order.cancelled", t(5, 1), { order: Q("#G"), customer: Q("C-G") }, { order: Q("#G"), quantity: 2 });
ev("shop", "shipment.dispatched", t(5, 2), { order: Q("#G"), customer: Q("C-G"), item: CUP }, { shipment: Q("SG1"), quantity: 5, carrier: "dhl", tracking_number: Q("TRK-G1"), physical_stock_delta: 0, reservation_released: 0, reservation: Q("R-G") });
ev("carrier", "shipment.delivered", t(5, 3), { order: Q("#G"), customer: Q("C-G"), shipment: Q("SG1") }, { shipment: Q("SG1"), carrier_status: "delivered", quantity: 3 });
ev("shop", "order.accepted", t(4, 0), { order: Q("#I"), customer: Q("C-I"), item: CUP }, { order: Q("#I"), quantity: 10, unit_gross_minor: 1190, gross_minor: 11900, currency: "EUR", unit: "piece" });
ev("invoice", "invoice.issued", t(4, 1), { order: Q("#I"), customer: Q("C-I") }, { invoice: Q("I-1"), gross_minor: 11900, currency: "EUR", due_date: "2026-10-30" });
ev("payment", "payment.authorized", t(4, 2), { order: Q("#I"), customer: Q("C-I") }, { transaction: Q("TX-I"), authorized_minor: 11900, currency: "EUR" });
ev("payment", "payment.captured", t(4, 3), { order: Q("#I"), customer: Q("C-I") }, { transaction: Q("TX-I"), captured_minor: 5000, currency: "EUR" });
ev("payment", "payment.fee_booked", t(4, 4), { order: Q("#I"), customer: Q("C-I") }, { transaction: Q("TX-I"), fee_minor: 350, currency: "EUR" });
ev("invoice", "invoice.credit_issued", t(4, 5), { order: Q("#I"), customer: Q("C-I") }, { credit: Q("CN-1"), invoice: Q("I-1"), credit_minor: 2380, currency: "EUR", cash_refund_confirmed: false });
ev("invoice", "invoice.payment_marked", t(4, 6), { order: Q("#I"), customer: Q("C-I") }, { invoice: Q("I-1"), transaction: Q("TX-I"), paid_minor: 5000, currency: "EUR", is_new_cash_movement: false });
ev("generic", "payment.allocation_recorded", t(4, 7), { order: Q("#I"), customer: Q("C-I") }, { allocation: Q("AL-1"), invoice: Q("I-1"), transaction: Q("TX-I"), amount_minor: 5000, currency: "EUR", confidence: "exact" });
ev("invoice", "invoice.dispatch_observed", t(4, 8), { order: Q("#I"), customer: Q("C-I") }, { dispatch: Q("DSP-1"), invoice: Q("I-1"), channel: "email", status: "OK", processed_at: "2026-10-31T04:08:00Z" });
ev("generic", "refund.entitlement_recorded", t(4, 9), { order: Q("#I"), customer: Q("C-I") }, { entitlement: Q("EN-1"), invoice: Q("I-1"), credit: Q("CN-1"), original_transaction: Q("TX-I"), amount_minor: 2380, currency: "EUR", destination: "cash", approved_at: "2026-10-31T04:09:00Z" });
for (const [conn, cap, at] of [["invoice", "invoices", t(4, 10)], ["invoice", "invoice_dispatch", t(4, 11)], ["payment", "payments", t(4, 12)], ["generic", "cases", t(4, 13)]]) ev("generic", "coverage.observed", at, {}, { connection: conn, capability: cap, backfill_complete: true, history_start: "2026-10-01", complete_through: "2026-10-31T10:00:00Z" });
ev("generic", "business.case_recorded", t(4, 14), { customer: Q("C-X") }, { case: Q("CASE-X"), customer: Q("C-X"), invoice: Q("I-X"), status: "closed" });
ev("shop", "order.accepted", t(3, 0), { order: Q("#X"), customer: Q("C-X"), item: CUP }, { order: Q("#X"), quantity: 10, unit_gross_minor: 1190, gross_minor: 11900, currency: "EUR", unit: "piece" });
ev("invoice", "invoice.issued", t(3, 1), { order: Q("#X"), customer: Q("C-X") }, { invoice: Q("I-X"), gross_minor: 12000, currency: "EUR", due_date: "2026-11-30" });
ev("shop", "order.accepted", t(2, 0), { order: Q("#R"), customer: Q("C-R"), item: CUP }, { order: Q("#R"), quantity: 10, unit_gross_minor: 1190, gross_minor: 11900, currency: "EUR", unit: "piece" });
ev("payment", "payment.failed", t(2, 1), { order: Q("#R"), customer: Q("C-R") }, { transaction: Q("T1"), attempt: Q("T1-a"), amount_minor: 11900, currency: "EUR", reason: "insufficient_funds" });
ev("payment", "payment.captured", t(2, 2), { order: Q("#R"), customer: Q("C-R") }, { transaction: Q("T2"), captured_minor: 11900, currency: "EUR" });
ev("payment", "payout.announced", t(1, 0), {}, { payout: Q("OUT-1"), amount_minor: 9170, currency: "EUR", account: Q("acct-main") });
ev("payment", "payout.sent", t(1, 1), {}, { payout: Q("OUT-1"), amount_minor: 9170, currency: "EUR", account: Q("acct-main") });
ev("payment", "provider.ledger_posted", t(1, 2), {}, { ledger_entry: Q("L-1"), account: Q("acct-main"), transaction: Q("TX-L"), payout: Q("OUT-1"), posting_type: "charge", gross_minor: 11900, fee_minor: 350, net_minor: 11550, currency: "EUR" });
ev("payment", "provider.ledger_posted", t(1, 3), {}, { ledger_entry: Q("L-2"), account: Q("acct-main"), transaction: Q("TX-L"), payout: Q("OUT-1"), posting_type: "refund", gross_minor: -2380, fee_minor: 0, net_minor: -2380, currency: "EUR" });
ev("bank_csv", "bank.credit_booked", t(1, 4), {}, { bank_entry: Q("BANK-1"), payout: Q("OUT-1"), amount_minor: 9170, currency: "EUR", status: "booked", booked_at: "2026-10-31T01:04:00Z" });
ev("payment", "payout.sent", t(1, 5), {}, { payout: Q("OUT-2"), amount_minor: 5000, currency: "EUR", account: Q("acct-main") });
ev("generic", "coverage.observed", t(1, 6), {}, { connection: "bank_csv", capability: "bank", backfill_complete: true, history_start: "2026-10-01", complete_through: "2026-10-31T09:00:00Z" });
ev("generic", "provider.hold_recorded", t(1, 7), {}, { hold: Q("H1"), account: Q("acct-main"), amount_minor: 9700, currency: "EUR", reason: "risk_review", release_promised_at: "2026-11-05" });
ev("payment", "provider.balance_observed", t(1, 8), {}, { account: Q("acct-main"), currency: "EUR", observed_at: "2026-10-31T01:08:00Z", total_minor: 10000, processing_minor: 0, available_minor: 300, held_minor: 9700 });
ev("shop", "order.accepted", t(0, 10), { order: Q("#L"), customer: Q("C-L"), item: CUP }, { order: Q("#L"), quantity: 2, unit_gross_minor: 1190, gross_minor: 2380, currency: "EUR", unit: "piece" });
ev("payment", "payment.captured", t(0, 11), { order: Q("#L"), customer: Q("C-L") }, { transaction: Q("TX-L2"), captured_minor: 2380, currency: "EUR" });
ev("shop", "return.approved", t(0, 12), { order: Q("#L"), customer: Q("C-L"), item: CUP }, { return: Q("RET-L"), quantity: 2, expected_credit_minor: 2380, currency: "EUR", unit: "piece" });
ev("stock", "return.received", t(0, 13), { order: Q("#L"), customer: Q("C-L"), item: CUP }, { return: Q("RET-L"), quantity: 2, physical_stock_delta: 2, quarantine_delta: 2 });
ev("payment", "refund.pending", t(0, 14), { order: Q("#L"), customer: Q("C-L") }, { refund: Q("RF-L"), transaction: Q("TX-L2"), amount_minor: 2380, held_minor: 2380, currency: "EUR" });
ev("shop", "order.accepted", t(0, 20), { order: Q("#C"), customer: Q("C-C"), item: CUP }, { order: Q("#C"), quantity: 2, unit_gross_minor: 1190, gross_minor: 2380, currency: "EUR", unit: "piece" });
ev("shop", "inventory.reserved", t(0, 21), { order: Q("#C"), customer: Q("C-C"), item: CUP }, { reservation: Q("R-C"), quantity: 2 });
ev("invoice", "invoice.issued", t(0, 22), { order: Q("#C"), customer: Q("C-C") }, { invoice: Q("I-C"), gross_minor: 2380, currency: "EUR", due_date: "2026-11-10" });
ev("payment", "payment.captured", t(0, 23), { order: Q("#C"), customer: Q("C-C") }, { transaction: Q("TX-C"), captured_minor: 2380, currency: "EUR" });
ev("generic", "refund.entitlement_recorded", t(0, 24), { order: Q("#C"), customer: Q("C-C") }, { entitlement: Q("EN-C"), invoice: Q("I-C"), original_transaction: Q("TX-C"), amount_minor: 2380, currency: "EUR", destination: "cash" });
ev("shop", "order.cancelled", t(0, 25), { order: Q("#C"), customer: Q("C-C") }, { order: Q("#C") });
ev("shop", "order.accepted", t(0, 30), { order: Q("#O"), customer: Q("C-O"), item: CUP }, { order: Q("#O"), quantity: 1, unit_gross_minor: 10000, gross_minor: 10000, currency: "EUR", unit: "piece" });
ev("payment", "payment.captured", t(0, 31), { order: Q("#O"), customer: Q("C-O") }, { transaction: Q("TX-O"), captured_minor: 10000, currency: "EUR" });
ev("payment", "refund.completed", t(0, 32), { order: Q("#O"), customer: Q("C-O") }, { refund: Q("RF-O"), transaction: Q("TX-O"), amount_minor: 10000, hold_released_minor: 0, currency: "EUR" });
ev("payment", "dispute.opened", t(0, 33), { order: Q("#O"), customer: Q("C-O") }, { dispute: Q("D-O"), transaction: Q("TX-O"), amount_minor: 10000, currency: "EUR" });
ev("payment", "chargeback.debit_posted", t(0, 34), { order: Q("#O"), customer: Q("C-O") }, { dispute: Q("D-O"), transaction: Q("TX-O"), debit_minor: 10000, fee_minor: 1500, currency: "EUR" });
ev("generic", "entity.link_recorded", t(0, 40), {}, { link: Q("LINK-1"), entity_type: "order", entity_id: Q("#I"), external_id: "shopify:gid://Order/1-Q", target_id: Q("I-1"), relationship_type: "order_invoice", confidence: "exact", connection: "shop" });

// ----- positive expectations (from intents_http.rs; tenant-wide lists are checked by containment because the
// owner workspace also holds the labeled GOLDEN demo and possibly other synthetic data) ---------------------------
const has = (arr, x) => Array.isArray(arr) && arr.includes(x);
const missing = (r, m) => has(r.missing_inputs, m);
const POSITIVE = [
  ["inventory.available_to_sell", { item_id: CUP, requested_quantity: 100 }, (r) => [["status complete", r.status === "complete"], ["available 86", r.result?.available === "86"], ["shortfall 14", r.result?.shortfall === "14"], ["incoming not counted", r.result?.incoming_counted_as_stock === false], ["incoming supply 50", r.result?.incoming_supply?.[0]?.quantity === "50"], ["entry ids", (r.entry_ids ?? []).length > 0]]],
  ["orders.fulfillable", { item_id: MUG }, (r) => [["status complete", r.status === "complete"], ["#A2 first fully", r.result?.orders?.[0]?.order_id === Q("#A2") && r.result?.orders?.[0]?.classification === "fully_fulfillable"], ["#B2 partial 4", r.result?.orders?.[1]?.order_id === Q("#B2") && r.result?.orders?.[1]?.classification === "partial" && r.result?.orders?.[1]?.lines?.[0]?.allocated === "4"], ["units used 10", r.result?.units_used === "10"]]],
  ["orders.reservation_variance", { order_id: Q("#V") }, (r) => [["status complete", r.status === "complete"], ["remaining 5", r.result?.lines?.[0]?.remaining_obligation === "5"], ["under reserved 1", r.result?.lines?.[0]?.under_reserved === "1"]]],
  ["orders.inbound_delay_impact", {}, (r) => [["status complete", r.status === "complete"], ["#D affected", has(r.result?.confirmed_affected_orders, Q("#D"))], ["risk incoming after deadline", JSON.stringify(r.result?.commitments ?? []).includes("incoming_after_customer_deadline")]]],
  ["shipments.attention", { now: NOW, order_id: Q("#S") }, (r) => [["status complete", r.status === "complete"], ["attention S1", has(r.result?.attention, Q("S1"))], ["scan age 3600", r.result?.shipments?.[0]?.latest_scan_age_seconds === 3600]]],
  ["shipments.promise_risk", { now: "2026-10-31T10:00:00+01:00", order_id: Q("#P") }, (r) => [["status complete", r.status === "complete"], ["overdue", r.result?.commitments?.[0]?.overdue === true], ["arrival unknown", r.result?.commitments?.[0]?.arrival_date === "unknown"], ["in transit", r.result?.commitments?.[0]?.last_state === "in_transit"]]],
  ["orders.partial_delivery_gaps", { order_id: Q("#G") }, (r) => [["status complete", r.status === "complete"], ["remaining dispatch 3", r.result?.orders?.[0]?.lines?.[0]?.remaining_to_dispatch === "3"], ["remaining deliver 5", r.result?.orders?.[0]?.lines?.[0]?.remaining_to_deliver === "5"]]],
  ["customer.delivery_reply", { order_id: Q("#P") }, (r) => [["status complete", r.status === "complete"], ["facts", JSON.stringify(r.result?.facts) === JSON.stringify(["arrival_unknown", "in_transit"])], ["no send action", r.result?.send_action === false], ["promises checked", r.result?.prior_promises_checked === true], ["prior message", r.result?.prior_communications?.[0]?.summary === "We will update you after the next scan." && r.result?.prior_communications?.[0]?.actor === "support"]]],
  ["invoices.outstanding", { customer_id: Q("C-I") }, (r) => [["status complete", r.status === "complete"], ["open 4520", r.result?.invoices?.[0]?.reported_open_minor === 4520], ["no new cash from marker", r.result?.invoices?.[0]?.new_cash_from_marker === 0]]],
  ["orders.missing_invoice", {}, (r) => [["status complete", r.status === "complete"], ["#S missing", has(r.result?.missing_invoice, Q("#S"))], ["#I not missing", !has(r.result?.missing_invoice, Q("#I"))]]],
  ["invoices.order_amount_variance", { invoice_id: Q("I-X") }, (r) => [["status complete", r.status === "complete"], ["difference 100", r.result?.invoices?.[0]?.difference_minor === 100]]],
  ["invoices.dispatch_evidence", {}, (r) => [["status complete", r.status === "complete"], ["I-X without evidence", has(r.result?.without_send_evidence, Q("I-X"))], ["I-1 provider reported", (r.result?.invoices ?? []).find((i) => i.invoice_id === Q("I-1"))?.evidence === "provider_reported_sent"], ["recipient not proven", (r.result?.invoices ?? []).find((i) => i.invoice_id === Q("I-1"))?.recipient_delivery_proven === false]]],
  ["orders.payment_state", { order_id: Q("#I") }, (r) => [["status complete", r.status === "complete"], ["collected 5000", r.result?.collected_minor === 5000], ["remaining 6900", r.result?.remaining_minor === 6900], ["partially collected", r.result?.state === "partially_collected"]]],
  ["payments.recovered_attempts", { order_id: Q("#R") }, (r) => [["status complete", r.status === "complete"], ["recovered", r.result?.orders?.[0]?.recovered === true], ["failed attempt retained", r.result?.orders?.[0]?.failed_history_retained?.[0]?.attempt_id === Q("T1-a")]]],
  ["invoices.payment_variance", { invoice_id: Q("I-1") }, (r) => [["status complete", r.status === "complete"], ["remaining 4520", r.result?.remaining_minor === 4520], ["fee not customer debt", r.result?.fee_added_to_customer_debt === 0]]],
  ["receivables.review_queue", { now: NOW }, (r) => [["status complete", r.status === "complete"], ["I-1 in review", has(r.result?.review, Q("I-1"))], ["no reminder", r.result?.send_reminder === false]]],
  ["providers.money_positions", { account_ref: Q("acct-main") }, (r) => [["status complete/partial", r.status === "complete" || r.status === "partial"], ["conservation", r.result?.accounts?.[0] && r.result.accounts[0].net_assets_minor === r.result.accounts[0].provider_balance_minor + r.result.accounts[0].in_transit_minor + r.result.accounts[0].bank_confirmed_minor], ["held 9700", r.result?.accounts?.[0]?.held_minor === 9700], ["bank confirmed 9170", r.result?.accounts?.[0]?.bank_confirmed_minor === 9170], ["in transit 5000", r.result?.accounts?.[0]?.in_transit_minor === 5000], ["unknown not zero", r.result?.unknown_components_are_zero === false]]],
  ["payouts.gross_to_net", { payout_id: Q("OUT-1") }, (r) => [["status complete", r.status === "complete"], ["net 9170", r.result?.computed_net_minor === 9170], ["unexplained 0", r.result?.unexplained_minor === 0]]],
  ["payouts.missing_bank_confirmation", {}, (r) => [["status complete", r.status === "complete"], ["OUT-2 missing", has(r.result?.missing_confirmation, Q("OUT-2"))], ["OUT-1 confirmed", !has(r.result?.missing_confirmation, Q("OUT-1"))], ["conclusion", (r.result?.payouts ?? []).find((p) => p.payout_id === Q("OUT-2"))?.conclusion === "no_evidence_in_imported_interval"]]],
  ["providers.holds_and_releases", { now: NOW }, (r) => [["status complete", r.status === "complete"], ["held 9700", r.result?.held_minor === 9700], ["released 0", r.result?.released_minor === 0], ["release only promised", r.result?.release_is_only_promised === true]]],
  ["returns.lifecycle", { return_id: Q("RET-L") }, (r) => [["status complete", r.status === "complete"], ["received", r.result?.returns?.[0]?.physical_return_received === true], ["sellable 0", r.result?.returns?.[0]?.sellable_added === "0"], ["refund not confirmed", r.result?.returns?.[0]?.cash_refund_confirmed === false], ["refund pending", r.result?.returns?.[0]?.refund_state === "pending"]]],
  ["credits.refund_gaps", { order_id: Q("#I") }, (r) => [["status complete", r.status === "complete"], ["cash refund due 2380", r.result?.cash_refund_due_minor === 2380]]],
  ["cancellations.outstanding_steps", { order_id: Q("#C") }, (r) => [["status complete", r.status === "complete"], ["remaining steps", JSON.stringify(r.result?.remaining_steps) === JSON.stringify(["release_reservation", "correct_invoice", "refund_payment"])], ["no receipt required", r.result?.stock_receipt_required === false]]],
  ["refunds.chargeback_overlap", { transaction_id: Q("TX-O") }, (r) => [["status complete", r.status === "complete"], ["net repayments 20000", r.result?.net_customer_repayments_minor === 20000], ["excess 10000", r.result?.excess_minor === 10000], ["review required", r.result?.transactions?.[0]?.review_required === true], ["duplicate proven", r.result?.duplicate_repayment_proven === true]]],
];
// ----- missing-data expectations on the sparse workspace (one accepted order "#M", nothing else) --------------------
const MISSING = [
  ["inventory.available_to_sell", { item_id: "CUP-OLV", requested_quantity: 100 }, (r) => [["unknown", r.status === "unknown"], ["stock.basis missing", missing(r, "stock.basis")], ["available null", r.result?.available === null]]],
  ["orders.fulfillable", {}, (r) => [["unknown", r.status === "unknown"], ["policy missing", missing(r, "policy.priority_method")], ["joint plan null", r.result?.joint_plan === null]]],
  ["orders.reservation_variance", {}, (r) => [["unknown", r.status === "unknown"], ["allocations missing", missing(r, "allocations.order_line_ownership")]]],
  ["orders.inbound_delay_impact", {}, (r) => [["unknown", r.status === "unknown"], ["affected null", r.result?.confirmed_affected_orders === null]]],
  ["shipments.attention", {}, (r) => [["unknown", r.status === "unknown"], ["tracking coverage missing", missing(r, "tracking.coverage")], ["delivery status unknown", r.result?.delivery_status === "unknown"]]],
  ["shipments.promise_risk", {}, (r) => [["unknown", r.status === "unknown"], ["promises missing", missing(r, "promises.promised_at")], ["breached null", r.result?.promise_breached === null]]],
  ["orders.partial_delivery_gaps", {}, (r) => [["unknown", r.status === "unknown"], ["fulfillments missing", missing(r, "fulfillments.line_quantity_links")]]],
  ["customer.delivery_reply", { order_id: "#M" }, (r) => [["partial", r.status === "partial"], ["communications missing", missing(r, "communications")], ["promises not checked", r.result?.prior_promises_checked === false]]],
  ["invoices.outstanding", {}, (r) => [["unknown", r.status === "unknown"], ["correction chain missing", missing(r, "invoices.correction_chain_coverage")], ["open null", r.result?.open_minor === null]]],
  ["orders.missing_invoice", { rule: "after_confirmed_dispatch" }, (r) => [["unknown", r.status === "unknown"], ["missing_invoice null", r.result?.missing_invoice === null]]],
  ["invoices.order_amount_variance", {}, (r) => [["unknown", r.status === "unknown"], ["line links missing", missing(r, "invoices.line_links")]]],
  ["invoices.dispatch_evidence", {}, (r) => [["unknown", r.status === "unknown"], ["population incomplete", r.result?.without_send_evidence_population_complete === false]]],
  ["orders.payment_state", { order_id: "#M" }, (r) => [["unknown", r.status === "unknown"], ["payments.status missing", missing(r, "payments.status")], ["collected null", r.result?.collected_minor === null]]],
  ["payments.recovered_attempts", {}, (r) => [["unknown", r.status === "unknown"], ["population incomplete", r.result?.recovered_population_complete === false]]],
  ["invoices.payment_variance", {}, (r) => [["unknown", r.status === "unknown"], ["allocations missing", missing(r, "payment_allocations")], ["unallocated separate", r.result?.unallocated_payments_separate === true]]],
  ["receivables.review_queue", { now: NOW }, (r) => [["unknown/partial", r.status === "unknown" || r.status === "partial"], ["no automatic action", r.result?.automatic_action !== true]]],
  ["providers.money_positions", {}, (r) => [["unknown/partial", r.status === "unknown" || r.status === "partial"], ["unknown not zero", r.result?.net_assets_minor === null]]],
  ["payouts.gross_to_net", { payout_id: "OUT-404" }, (r) => [["unknown", r.status === "unknown"], ["not reconciled", r.result?.reconciled === false]]],
  ["payouts.missing_bank_confirmation", {}, (r) => [["unknown", r.status === "unknown"], ["bank arrival unknown", r.result?.bank_arrival === "unknown"]]],
  ["providers.holds_and_releases", {}, (r) => [["unknown", r.status === "unknown"], ["held null", r.result?.held_minor === null]]],
  ["returns.lifecycle", {}, (r) => [["unknown/partial", r.status === "unknown" || r.status === "partial"], ["request is not receipt", r.result?.request_is_not_receipt !== false]]],
  ["credits.refund_gaps", {}, (r) => [["unknown", r.status === "unknown"], ["refund due null", r.result?.refund_due_minor === null]]],
  ["cancellations.outstanding_steps", { order_id: "#M" }, (r) => [["not cancelled (no cancellation observed, nothing invented)", r.status === "complete" && r.result?.cancelled === false], ["no steps claimed", Array.isArray(r.result?.remaining_steps) && r.result.remaining_steps.length === 0], ["do not mark complete", r.result?.do_not_mark_complete === true]]],
  ["refunds.chargeback_overlap", {}, (r) => [["unknown", r.status === "unknown"], ["duplicate not proven", r.result?.duplicate_repayment_proven === false]]],
];
const GROUP_OF = (intent) => ({ inventory: "order", orders: "order", shipments: "delivery", customer: "delivery", invoices: "invoice", receivables: "collection", payments: "collection", providers: "settlement", payouts: "settlement", returns: "reversal", credits: "reversal", cancellations: "reversal", refunds: "reversal" })[intent.split(".")[0]];
// question ids by contract order
const contracts = JSON.parse(readFileSync(path.join(repo, "specs/question-data-contracts.json"), "utf8")).questions;
const QID = Object.fromEntries(contracts.map((q) => [q.intent, q.id]));

// normalized comparison (drop timing/trace/readiness noise)
function norm(j) {
  if (!j) return null;
  const c = JSON.parse(JSON.stringify(j));
  delete c.readiness;
  delete c.trace_id;
  if (c.consistency) c.consistency = { status: c.consistency.status, mode: c.consistency.mode, reducer_version: c.consistency.reducer_version };
  return c;
}
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const sanitize = (s) => s.replace(/bb[ka]_[A-Za-z0-9_-]{20,}/g, "[REDACTED]");

async function runSet(label, set, apiCall, mcp, consistency) {
  const results = [];
  for (const [intent, params, expect] of set) {
    const a = await apiCall(intent, params, consistency);
    const m = mcp ? await mcp.answer(intent, params, consistency) : null;
    const checks = a.json ? expect(a.json) : [["response", false]];
    const ok = a.status === 200 && checks.every((c) => c[1]);
    const parity = m ? m.status === 200 && same(a.json, m.json) : null;
    results.push({ intent, question_id: QID[intent], group: GROUP_OF(intent), params, api_status: a.status, status: a.json?.status ?? null, missing_inputs: a.json?.missing_inputs ?? null, checks: checks.map(([name, pass]) => ({ name, pass })), passed: ok, mcp_status: m?.status ?? null, api_mcp_parity: parity, consistency: a.json?.consistency ?? null, entry_ids: (a.json?.entry_ids ?? []).length, evidence_refs: (a.json?.evidence_refs ?? []).length });
    writeFileSync(path.join(OUT, `${label}-${intent}.json`), sanitize(JSON.stringify({ intent, params, api: a, mcp: m }, null, 2)) + "\n");
  }
  return results;
}

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const started = new Date().toISOString();
if (PHASE === "positive") {
  const o = await owner();
  // connections per fixture label (replay producer; the labels mirror the engine test's connections)
  const existing = await ownerJson(o, "GET", "/api/sources");
  const byName = {};
  for (const p of existing.catalogue ?? []) for (const c of p.connections ?? []) if (c.status !== "disconnected") byName[c.display_name] = c.connection_id;
  const conn = {};
  for (const label of ["stock", "shop", "generic", "policy", "carrier", "invoice", "payment", "bank_csv"]) {
    const name = `coverage:${label}`;
    if (!byName[name]) {
      const r = await ownerJson(o, "POST", "/api/sources/connections", { provider: "replay", display_name: name, config: { synthetic: true, purpose: "QUERY-01 coverage scenario" } });
      byName[name] = r.connection?.connection_id ?? r.connection_id;
    }
    conn[label] = byName[name];
  }
  const ingest = { accepted: 0, duplicate: 0, conflict: 0, rejected: 0, outcomes: [], committed_cursor: null };
  for (const label of Object.keys(conn)) {
    const events = EVENTS.filter((e) => e.connection === label).map(({ connection, ...e }) => e);
    if (!events.length) continue;
    const r = await ownerJson(o, "POST", "/api/ingest/replay", { connection_id: conn[label], events });
    ingest.accepted += r.accepted;
    ingest.duplicate += r.duplicate;
    ingest.conflict += r.conflict;
    ingest.rejected += r.rejected;
    ingest.committed_cursor = Math.max(ingest.committed_cursor ?? 0, r.committed_cursor ?? 0);
    for (const oc of r.outcomes ?? []) if (oc.status !== "accepted" && oc.status !== "duplicate") ingest.outcomes.push({ label, ...oc });
  }
  // wait until applied
  const barrier = await fetch(API + `/api/entities/order/${encodeURIComponent(Q("#I"))}/state?mode=at_least_cursor&cursor=${ingest.committed_cursor}`, { headers: o.headers });
  const cutoff = new Date().toISOString();
  // agent principal of the owner workspace for the MCP path
  const agent = await ownerJson(o, "POST", "/api/agents", { name: `question-coverage-${Date.now().toString(36)}` });
  const agentKeyFile = path.join(path.dirname(OWNER_KEY_FILE), "coverage-agent.key");
  writeFileSync(agentKeyFile, agent.key + "\n", { mode: 0o600 });
  const agentKey = agent.key;
  const mcpOwnerWs = await bridge(agentKeyFile);
  const apiAgent = (intent, params, consistency) => agentPost(agentKey, `/api/questions/${encodeURIComponent(intent)}`, { params, ...(consistency ? { consistency } : {}) });
  const positive = await runSet("positive", POSITIVE, apiAgent, mcpOwnerWs);
  const asOf = await runSet("asof", POSITIVE, apiAgent, mcpOwnerWs, { mode: "as_of", as_of_recorded: cutoff });
  await mcpOwnerWs.close();
  let missingRes = null;
  if (SPARSE_KEY_FILE) {
    const sparseKey = readFileSync(SPARSE_KEY_FILE, "utf8").trim();
    const mcpSparse = await bridge(SPARSE_KEY_FILE);
    missingRes = await runSet("missing", MISSING, (intent, params, c) => agentPost(sparseKey, `/api/questions/${encodeURIComponent(intent)}`, { params, ...(c ? { consistency: c } : {}) }), mcpSparse);
    await mcpSparse.close();
  }
  const newState = { started_at: started, finished_at: new Date().toISOString(), api: API, tenant_id: o.tenant_id, connections: conn, ingest: { ...ingest, barrier_status: barrier.status }, cutoff, agent_credential_id: agent.credential_id, positive, as_of: asOf.map((r) => ({ intent: r.intent, status: r.status, passed: r.passed, api_mcp_parity: r.api_mcp_parity, snapshot: norm(JSON.parse(readFileSync(path.join(OUT, `asof-${r.intent}.json`), "utf8")).api.json) })), missing: missingRes };
  writeFileSync(STATE_FILE, sanitize(JSON.stringify(newState, null, 2)) + "\n");
  const summary = { positive_passed: positive.filter((r) => r.passed).length, positive_total: positive.length, parity_ok: positive.filter((r) => r.api_mcp_parity).length, asof_passed: asOf.filter((r) => r.passed).length, missing_passed: missingRes ? missingRes.filter((r) => r.passed).length : null, missing_total: missingRes?.length ?? null, missing_parity_ok: missingRes ? missingRes.filter((r) => r.api_mcp_parity).length : null, ingest: { accepted: ingest.accepted, duplicate: ingest.duplicate, rejected: ingest.rejected, conflict: ingest.conflict, committed_cursor: ingest.committed_cursor, problems: ingest.outcomes.slice(0, 10) } };
  console.log(JSON.stringify(summary, null, 2));
  for (const r of [...positive, ...(missingRes ?? [])]) if (!r.passed) console.log("FAILED", r.intent, r.api_status, r.status, JSON.stringify(r.checks.filter((c) => !c.pass)), JSON.stringify(r.missing_inputs));
} else if (PHASE === "restart") {
  // after `./blackbox down && ./blackbox up`: one as_of query per group must reproduce the pre-restart snapshot
  if (!state.cutoff) throw new Error("no state.json from the positive phase");
  const key = readFileSync(path.join(path.dirname(OWNER_KEY_FILE), "coverage-agent.key"), "utf8").trim();
  const groups = {};
  for (const r of state.as_of) if (!groups[GROUP_OF(r.intent)]) groups[GROUP_OF(r.intent)] = r;
  const out = [];
  for (const [group, prev] of Object.entries(groups)) {
    const [, params] = POSITIVE.find((p) => p[0] === prev.intent);
    const a = await agentPost(key, `/api/questions/${encodeURIComponent(prev.intent)}`, { params, consistency: { mode: "as_of", as_of_recorded: state.cutoff } });
    const identical = JSON.stringify(norm(a.json)) === JSON.stringify(prev.snapshot);
    out.push({ group, intent: prev.intent, api_status: a.status, status: a.json?.status, identical_to_pre_restart: identical, consistency: a.json?.consistency ?? null });
    writeFileSync(path.join(OUT, `restart-${group}-${prev.intent}.json`), sanitize(JSON.stringify({ pre_restart: prev.snapshot, post_restart: a.json }, null, 2)) + "\n");
  }
  state.restart = { at: new Date().toISOString(), results: out };
  writeFileSync(STATE_FILE, sanitize(JSON.stringify(state, null, 2)) + "\n");
  console.log(JSON.stringify(out, null, 2));
}
process.exit(0);
