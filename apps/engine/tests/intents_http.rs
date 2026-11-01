//! QUERY-01/02 at the engine boundary: every one of the 24 intents with a positive (sufficient)
//! case derived from specs/question-data-contracts.json and an explicit missing-data case.

use anyhow::Result;
use blackbox_engine_tests::*;
use blackbox_query::intents::INTENTS;
use chrono::{DateTime, TimeZone, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

fn t(h: u32, m: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 31, h, m, 0).unwrap()
}

const NOW: &str = "2026-10-31T10:00:00Z";

/// Full-coverage tenant: all 26 datasets with the contract's sufficient cases.
fn coverage_events() -> Vec<blackbox_domain::fixture::GoldenEvent> {
    let mut v = Vec::new();
    let mut n = 0;
    let mut ev = |conn: &str, kind: &str, at: DateTime<Utc>, entity: &[(&str, &str)], payload: Value| {
        n += 1;
        v.push(event(&format!("C{n:03}"), conn, kind, at, entity, payload));
    };
    // Stock + supply (order-01, order-04)
    // The provider snapshot is the latest basis (reservations before it are covered by `committed`).
    ev("stock", "inventory.snapshot", t(8, 30), &[("item", "CUP-OLV")], json!({"sku": "CUP-OLV", "physical": 120, "committed": 34, "reserved": 0, "damaged": 0, "safety_stock": 0, "quality_control": 0, "available": 86, "incoming": 80, "unit": "piece"}));
    ev("stock", "inventory.snapshot", t(8, 0), &[("item", "MUG-BLK")], json!({"sku": "MUG-BLK", "physical": 10, "quarantined": 0, "reserved": 0, "unit": "piece"}));
    ev("generic", "supply.commitment_recorded", t(8, 1), &[("item", "CUP-OLV")], json!({"promise": "P-S1", "supplier": "SUP-1", "quantity": 50, "unit": "piece", "promised_at": "2026-11-03", "allocation_links": ["#D"]}));
    ev("generic", "supply.commitment_revised", t(8, 2), &[("item", "CUP-OLV")], json!({"promise": "P-S1", "promised_at": "2026-11-05"}));
    ev("shop", "order.accepted", t(8, 3), &[("order", "#D"), ("customer", "C-D"), ("item", "CUP-OLV")], json!({"order": "#D", "quantity": 5, "unit_gross_minor": 1190, "gross_minor": 5950, "currency": "EUR", "unit": "piece"}));
    ev("generic", "customer.commitment_recorded", t(8, 4), &[("order", "#D"), ("customer", "C-D")], json!({"promise": "P-D", "promised_at": "2026-11-04T17:00:00Z", "timezone": "Europe/Berlin", "promise_kind": "delivery_date"}));
    // Fulfillable (order-02): two MUG orders of 6, free 10, priority by accepted_at.
    ev("shop", "order.accepted", t(8, 5), &[("order", "#A2"), ("customer", "C-A"), ("item", "MUG-BLK")], json!({"order": "#A2", "quantity": 6, "unit_gross_minor": 900, "gross_minor": 5400, "currency": "EUR", "unit": "piece"}));
    ev("shop", "order.accepted", t(8, 6), &[("order", "#B2"), ("customer", "C-B"), ("item", "MUG-BLK")], json!({"order": "#B2", "quantity": 6, "unit_gross_minor": 900, "gross_minor": 5400, "currency": "EUR", "unit": "piece"}));
    ev("policy", "business.rule_recorded", t(8, 7), &[], json!({"rule": "RULE-1", "rule_kind": "operations", "version": 1, "effective_from": "2026-10-01", "priority_method": "accepted_at", "invoicing_trigger": "after_confirmed_dispatch", "reminder_policy": "review_overdue", "attention_rule": "exceptions_require_attention", "stale_scan_seconds": 86400, "risk_hours": 24, "timezone": "Europe/Berlin", "currency": "EUR"}));
    // Reservation variance (order-03): #V 10, cancel 2, dispatch 3, reserved 4.
    ev("shop", "order.accepted", t(8, 8), &[("order", "#V"), ("customer", "C-V"), ("item", "CUP-OLV")], json!({"order": "#V", "quantity": 10, "unit_gross_minor": 1190, "gross_minor": 11900, "currency": "EUR", "unit": "piece"}));
    ev("shop", "inventory.reserved", t(8, 9), &[("order", "#V"), ("customer", "C-V"), ("item", "CUP-OLV")], json!({"reservation": "R-V", "quantity": 4}));
    ev("shop", "order.cancelled", t(8, 10), &[("order", "#V"), ("customer", "C-V")], json!({"order": "#V", "quantity": 2}));
    ev("shop", "shipment.dispatched", t(8, 11), &[("order", "#V"), ("customer", "C-V"), ("item", "CUP-OLV")], json!({"shipment": "SV1", "quantity": 3, "carrier": "dhl", "tracking_number": "TRK-V1"}));
    // Attention (delivery-01) + reply (delivery-04) + missing invoice (invoice-02): order #S.
    ev("shop", "order.accepted", t(7, 0), &[("order", "#S"), ("customer", "C-S"), ("item", "CUP-OLV")], json!({"order": "#S", "quantity": 1, "unit_gross_minor": 1190, "gross_minor": 1190, "currency": "EUR", "unit": "piece"}));
    ev("shop", "shipment.dispatched", t(8, 0), &[("order", "#S"), ("customer", "C-S"), ("item", "CUP-OLV")], json!({"shipment": "S1", "quantity": 1, "carrier": "dhl", "tracking_number": "TRK-S1"}));
    ev("carrier", "carrier.scan_observed", t(9, 0), &[("order", "#S"), ("shipment", "S1")], json!({"shipment": "S1", "tracking_number": "TRK-S1", "status_code": "exception", "effective_time": "2026-10-31T09:00:00Z", "scan_identity": "scan-1"}));
    ev("generic", "coverage.observed", t(9, 1), &[], json!({"connection": "carrier", "capability": "tracking", "backfill_complete": true, "history_start": "2026-10-01", "complete_through": "2026-10-31T10:00:00Z"}));
    // Promise risk (delivery-02) + reply: order #P promised 2026-10-30T17:00+01:00, in transit.
    ev("shop", "order.accepted", t(6, 0), &[("order", "#P"), ("customer", "C-P"), ("item", "CUP-OLV")], json!({"order": "#P", "quantity": 1, "unit_gross_minor": 1190, "gross_minor": 1190, "currency": "EUR", "unit": "piece"}));
    ev("generic", "customer.commitment_recorded", t(6, 1), &[("order", "#P"), ("customer", "C-P")], json!({"promise": "P-P", "promised_at": "2026-10-30T17:00:00+01:00", "timezone": "Europe/Berlin", "promise_kind": "delivery_date"}));
    ev("shop", "shipment.dispatched", t(6, 2), &[("order", "#P"), ("customer", "C-P"), ("item", "CUP-OLV")], json!({"shipment": "S-P", "quantity": 1, "carrier": "dhl", "tracking_number": "TRK-P"}));
    ev("carrier", "carrier.scan_observed", t(7, 0), &[("order", "#P"), ("shipment", "S-P")], json!({"shipment": "S-P", "status_code": "in_transit", "effective_time": "2026-10-31T07:00:00Z"}));
    ev("generic", "communication.observed", t(7, 30), &[("order", "#P"), ("customer", "C-P")], json!({"message": "M-P", "sent_at": "2026-10-31T07:30:00Z", "actor": "support", "summary": "We will update you after the next scan."}));
    // Partial delivery gaps (delivery-03): #G 10, cancel 2, handed over 5, delivered 3.
    ev("shop", "order.accepted", t(5, 0), &[("order", "#G"), ("customer", "C-G"), ("item", "CUP-OLV")], json!({"order": "#G", "quantity": 10, "unit_gross_minor": 1190, "gross_minor": 11900, "currency": "EUR", "unit": "piece"}));
    ev("shop", "order.cancelled", t(5, 1), &[("order", "#G"), ("customer", "C-G")], json!({"order": "#G", "quantity": 2}));
    ev("shop", "shipment.dispatched", t(5, 2), &[("order", "#G"), ("customer", "C-G"), ("item", "CUP-OLV")], json!({"shipment": "SG1", "quantity": 5, "carrier": "dhl", "tracking_number": "TRK-G1"}));
    ev("carrier", "shipment.delivered", t(5, 3), &[("order", "#G"), ("customer", "C-G"), ("shipment", "SG1")], json!({"shipment": "SG1", "carrier_status": "delivered", "quantity": 3}));
    // Invoices/payments (invoice-01/03/04, collection-01/03/04, reversal-02): order #I.
    ev("shop", "order.accepted", t(4, 0), &[("order", "#I"), ("customer", "C-I"), ("item", "CUP-OLV")], json!({"order": "#I", "quantity": 10, "unit_gross_minor": 1190, "gross_minor": 11900, "currency": "EUR", "unit": "piece"}));
    ev("invoice", "invoice.issued", t(4, 1), &[("order", "#I"), ("customer", "C-I")], json!({"invoice": "I-1", "gross_minor": 11900, "currency": "EUR", "due_date": "2026-10-30"}));
    ev("payment", "payment.authorized", t(4, 2), &[("order", "#I"), ("customer", "C-I")], json!({"transaction": "TX-I", "authorized_minor": 11900, "currency": "EUR"}));
    ev("payment", "payment.captured", t(4, 3), &[("order", "#I"), ("customer", "C-I")], json!({"transaction": "TX-I", "captured_minor": 5000, "currency": "EUR"}));
    ev("payment", "payment.fee_booked", t(4, 4), &[("order", "#I"), ("customer", "C-I")], json!({"transaction": "TX-I", "fee_minor": 350, "currency": "EUR"}));
    ev("invoice", "invoice.credit_issued", t(4, 5), &[("order", "#I"), ("customer", "C-I")], json!({"credit": "CN-1", "invoice": "I-1", "credit_minor": 2380, "currency": "EUR", "cash_refund_confirmed": false}));
    ev("invoice", "invoice.payment_marked", t(4, 6), &[("order", "#I"), ("customer", "C-I")], json!({"invoice": "I-1", "transaction": "TX-I", "paid_minor": 5000, "currency": "EUR", "is_new_cash_movement": false}));
    ev("generic", "payment.allocation_recorded", t(4, 7), &[("order", "#I"), ("customer", "C-I")], json!({"allocation": "AL-1", "invoice": "I-1", "transaction": "TX-I", "amount_minor": 5000, "currency": "EUR", "confidence": "exact"}));
    ev("invoice", "invoice.dispatch_observed", t(4, 8), &[("order", "#I"), ("customer", "C-I")], json!({"dispatch": "DSP-1", "invoice": "I-1", "channel": "email", "status": "OK", "processed_at": "2026-10-31T04:08:00Z"}));
    ev("generic", "refund.entitlement_recorded", t(4, 9), &[("order", "#I"), ("customer", "C-I")], json!({"entitlement": "EN-1", "invoice": "I-1", "credit": "CN-1", "original_transaction": "TX-I", "amount_minor": 2380, "currency": "EUR", "destination": "cash", "approved_at": "2026-10-31T04:09:00Z"}));
    ev("generic", "coverage.observed", t(4, 10), &[], json!({"connection": "invoice", "capability": "invoices", "backfill_complete": true, "history_start": "2026-10-01", "complete_through": "2026-10-31T10:00:00Z"}));
    ev("generic", "coverage.observed", t(4, 11), &[], json!({"connection": "invoice", "capability": "invoice_dispatch", "backfill_complete": true, "history_start": "2026-10-01", "complete_through": "2026-10-31T10:00:00Z"}));
    ev("generic", "coverage.observed", t(4, 12), &[], json!({"connection": "payment", "capability": "payments", "backfill_complete": true, "history_start": "2026-10-01", "complete_through": "2026-10-31T10:00:00Z"}));
    ev("generic", "coverage.observed", t(4, 13), &[], json!({"connection": "generic", "capability": "cases", "backfill_complete": true, "history_start": "2026-10-01", "complete_through": "2026-10-31T10:00:00Z"}));
    ev("generic", "business.case_recorded", t(4, 14), &[("customer", "C-X")], json!({"case": "CASE-X", "customer": "C-X", "invoice": "I-X", "status": "closed"}));
    // Amount variance (invoice-03): #X 11900 vs invoice I-X 12000; no dispatch evidence (invoice-04).
    ev("shop", "order.accepted", t(3, 0), &[("order", "#X"), ("customer", "C-X"), ("item", "CUP-OLV")], json!({"order": "#X", "quantity": 10, "unit_gross_minor": 1190, "gross_minor": 11900, "currency": "EUR", "unit": "piece"}));
    ev("invoice", "invoice.issued", t(3, 1), &[("order", "#X"), ("customer", "C-X")], json!({"invoice": "I-X", "gross_minor": 12000, "currency": "EUR", "due_date": "2026-11-30"}));
    // Recovered attempts (collection-02): #R failed T1 then captured T2.
    ev("shop", "order.accepted", t(2, 0), &[("order", "#R"), ("customer", "C-R"), ("item", "CUP-OLV")], json!({"order": "#R", "quantity": 10, "unit_gross_minor": 1190, "gross_minor": 11900, "currency": "EUR", "unit": "piece"}));
    ev("payment", "payment.failed", t(2, 1), &[("order", "#R"), ("customer", "C-R")], json!({"transaction": "T1", "attempt": "T1-a", "amount_minor": 11900, "currency": "EUR", "reason": "insufficient_funds"}));
    ev("payment", "payment.captured", t(2, 2), &[("order", "#R"), ("customer", "C-R")], json!({"transaction": "T2", "captured_minor": 11900, "currency": "EUR"}));
    // Payout and ledger (settlement-02), bank (settlement-03), holds (settlement-04), positions.
    ev("payment", "payout.announced", t(1, 0), &[], json!({"payout": "OUT-1", "amount_minor": 9170, "currency": "EUR", "account": "acct-main"}));
    ev("payment", "payout.sent", t(1, 1), &[], json!({"payout": "OUT-1", "amount_minor": 9170, "currency": "EUR", "account": "acct-main"}));
    ev("payment", "provider.ledger_posted", t(1, 2), &[], json!({"ledger_entry": "L-1", "account": "acct-main", "transaction": "TX-L", "payout": "OUT-1", "posting_type": "charge", "gross_minor": 11900, "fee_minor": 350, "net_minor": 11550, "currency": "EUR"}));
    ev("payment", "provider.ledger_posted", t(1, 3), &[], json!({"ledger_entry": "L-2", "account": "acct-main", "transaction": "TX-L", "payout": "OUT-1", "posting_type": "refund", "gross_minor": -2380, "fee_minor": 0, "net_minor": -2380, "currency": "EUR"}));
    ev("bank_csv", "bank.credit_booked", t(1, 4), &[], json!({"bank_entry": "BANK-1", "payout": "OUT-1", "amount_minor": 9170, "currency": "EUR", "status": "booked", "booked_at": "2026-10-31T01:04:00Z"}));
    ev("payment", "payout.sent", t(1, 5), &[], json!({"payout": "OUT-2", "amount_minor": 5000, "currency": "EUR", "account": "acct-main"}));
    ev("generic", "coverage.observed", t(1, 6), &[], json!({"connection": "bank_csv", "capability": "bank", "backfill_complete": true, "history_start": "2026-10-01", "complete_through": "2026-10-31T09:00:00Z"}));
    ev("generic", "provider.hold_recorded", t(1, 7), &[], json!({"hold": "H1", "account": "acct-main", "amount_minor": 9700, "currency": "EUR", "reason": "risk_review", "release_promised_at": "2026-11-05"}));
    ev("payment", "provider.balance_observed", t(1, 8), &[], json!({"account": "acct-main", "currency": "EUR", "observed_at": "2026-10-31T01:08:00Z", "total_minor": 10000, "processing_minor": 0, "available_minor": 300, "held_minor": 9700}));
    // Returns lifecycle (reversal-01): RET-L approved 2, received 2 into quarantine, refund pending.
    ev("shop", "order.accepted", t(0, 10), &[("order", "#L"), ("customer", "C-L"), ("item", "CUP-OLV")], json!({"order": "#L", "quantity": 2, "unit_gross_minor": 1190, "gross_minor": 2380, "currency": "EUR", "unit": "piece"}));
    ev("payment", "payment.captured", t(0, 11), &[("order", "#L"), ("customer", "C-L")], json!({"transaction": "TX-L2", "captured_minor": 2380, "currency": "EUR"}));
    ev("shop", "return.approved", t(0, 12), &[("order", "#L"), ("customer", "C-L"), ("item", "CUP-OLV")], json!({"return": "RET-L", "quantity": 2, "expected_credit_minor": 2380, "currency": "EUR", "unit": "piece"}));
    ev("stock", "return.received", t(0, 13), &[("order", "#L"), ("customer", "C-L"), ("item", "CUP-OLV")], json!({"return": "RET-L", "quantity": 2, "physical_stock_delta": 2, "quarantine_delta": 2}));
    ev("payment", "refund.pending", t(0, 14), &[("order", "#L"), ("customer", "C-L")], json!({"refund": "RF-L", "transaction": "TX-L2", "amount_minor": 2380, "held_minor": 2380, "currency": "EUR"}));
    // Cancellation steps (reversal-03): #C cancelled with reservation, invoice, capture, entitlement.
    ev("shop", "order.accepted", t(0, 20), &[("order", "#C"), ("customer", "C-C"), ("item", "CUP-OLV")], json!({"order": "#C", "quantity": 2, "unit_gross_minor": 1190, "gross_minor": 2380, "currency": "EUR", "unit": "piece"}));
    ev("shop", "inventory.reserved", t(0, 21), &[("order", "#C"), ("customer", "C-C"), ("item", "CUP-OLV")], json!({"reservation": "R-C", "quantity": 2}));
    ev("invoice", "invoice.issued", t(0, 22), &[("order", "#C"), ("customer", "C-C")], json!({"invoice": "I-C", "gross_minor": 2380, "currency": "EUR", "due_date": "2026-11-10"}));
    ev("payment", "payment.captured", t(0, 23), &[("order", "#C"), ("customer", "C-C")], json!({"transaction": "TX-C", "captured_minor": 2380, "currency": "EUR"}));
    ev("generic", "refund.entitlement_recorded", t(0, 24), &[("order", "#C"), ("customer", "C-C")], json!({"entitlement": "EN-C", "invoice": "I-C", "original_transaction": "TX-C", "amount_minor": 2380, "currency": "EUR", "destination": "cash"}));
    ev("shop", "order.cancelled", t(0, 25), &[("order", "#C"), ("customer", "C-C")], json!({"order": "#C"}));
    // Chargeback overlap (reversal-04): TX-O captured 10000, refunded 10000, chargeback 10000 + fee 1500.
    ev("shop", "order.accepted", t(0, 30), &[("order", "#O"), ("customer", "C-O"), ("item", "CUP-OLV")], json!({"order": "#O", "quantity": 1, "unit_gross_minor": 10000, "gross_minor": 10000, "currency": "EUR", "unit": "piece"}));
    ev("payment", "payment.captured", t(0, 31), &[("order", "#O"), ("customer", "C-O")], json!({"transaction": "TX-O", "captured_minor": 10000, "currency": "EUR"}));
    ev("payment", "refund.completed", t(0, 32), &[("order", "#O"), ("customer", "C-O")], json!({"refund": "RF-O", "transaction": "TX-O", "amount_minor": 10000, "currency": "EUR"}));
    ev("payment", "dispute.opened", t(0, 33), &[("order", "#O"), ("customer", "C-O")], json!({"dispute": "D-O", "transaction": "TX-O", "amount_minor": 10000, "currency": "EUR"}));
    ev("payment", "chargeback.debit_posted", t(0, 34), &[("order", "#O"), ("customer", "C-O")], json!({"dispute": "D-O", "transaction": "TX-O", "debit_minor": 10000, "fee_minor": 1500, "currency": "EUR"}));
    // Identity link.
    ev("generic", "entity.link_recorded", t(0, 40), &[], json!({"link": "LINK-1", "entity_type": "order", "entity_id": "#I", "external_id": "shopify:gid://Order/1", "target_id": "I-1", "relationship_type": "order_invoice", "confidence": "exact", "connection": "shop"}));
    v
}

/// Sparse tenant: a single accepted order that was then cancelled; no other dataset.
fn sparse_events() -> Vec<blackbox_domain::fixture::GoldenEvent> {
    vec![
        event("M01", "shop", "order.accepted", t(8, 0), &[("order", "#M"), ("customer", "C-M"), ("item", "CUP-OLV")], json!({"order": "#M", "quantity": 3, "unit_gross_minor": 1190, "gross_minor": 3570, "currency": "EUR", "unit": "piece"})),
        event("M02", "shop", "order.cancelled", t(8, 1), &[("order", "#M"), ("customer", "C-M")], json!({"order": "#M"})),
    ]
}

/// Third tenant: invoices/payments/returns without cases, holds, positions, receipts.
fn nocases_events() -> Vec<blackbox_domain::fixture::GoldenEvent> {
    vec![
        event("N01", "shop", "order.accepted", t(4, 0), &[("order", "#I"), ("customer", "C-I"), ("item", "CUP-OLV")], json!({"order": "#I", "quantity": 10, "unit_gross_minor": 1190, "gross_minor": 11900, "currency": "EUR", "unit": "piece"})),
        event("N02", "invoice", "invoice.issued", t(4, 1), &[("order", "#I"), ("customer", "C-I")], json!({"invoice": "I-1", "gross_minor": 11900, "currency": "EUR", "due_date": "2026-10-30"})),
        event("N03", "payment", "payment.captured", t(4, 3), &[("order", "#I"), ("customer", "C-I")], json!({"transaction": "TX-I", "captured_minor": 5000, "currency": "EUR"})),
        event("N04", "shop", "return.approved", t(4, 4), &[("order", "#I"), ("customer", "C-I"), ("item", "CUP-OLV")], json!({"return": "RET-N", "quantity": 1, "expected_credit_minor": 1190, "currency": "EUR"})),
        event("N05", "payment", "payout.sent", t(4, 5), &[], json!({"payout": "OUT-N", "amount_minor": 4650, "currency": "EUR"})),
    ]
}

fn has_missing(v: &Value, m: &str) -> bool {
    v["missing_inputs"].as_array().map(|a| a.iter().any(|x| x == m)).unwrap_or(false)
}

#[tokio::test]
async fn all_24_intents_positive_and_missing_data() -> Result<()> {
    let db = TestDb::create("intents").await?;
    let full = db.create_tenant("coverage").await?;
    let sparse = db.create_tenant("sparse").await?;
    let nocases = db.create_tenant("nocases").await?;
    let engine = Engine::spawn(&db, &[]).await?;
    let mut a = Appender::new(&db, full, true).await?;
    let last = a.observe_many(&coverage_events(), 10).await?;
    let mut b = Appender::new(&db, sparse, false).await?;
    let last_s = b.observe_many(&sparse_events(), 10).await?;
    let mut c = Appender::new(&db, nocases, false).await?;
    let last_n = c.observe_many(&nocases_events(), 10).await?;
    engine.wait_applied(full, last, std::time::Duration::from_secs(20)).await?;
    engine.wait_applied(sparse, last_s, std::time::Duration::from_secs(20)).await?;
    engine.wait_applied(nocases, last_n, std::time::Duration::from_secs(20)).await?;

    let q = |tenant: Uuid, intent: &'static str, params: Value| {
        let e = &engine;
        async move { e.query_ok(tenant, intent, params).await }
    };
    let now = json!(NOW);

    // ---- positive paths (full tenant) ----
    let r = q(full, "inventory.available_to_sell", json!({"item_id": "CUP-OLV", "requested_quantity": 100})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["available"], "86");
    assert_eq!(r["result"]["shortfall"], "14");
    assert_eq!(r["result"]["incoming_counted_as_stock"], false);
    assert_eq!(r["result"]["incoming_supply"][0]["quantity"], "50");
    assert!(!r["entry_ids"].as_array().unwrap().is_empty());

    let r = q(full, "orders.fulfillable", json!({"item_id": "MUG-BLK"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    let orders = r["result"]["orders"].as_array().unwrap();
    assert_eq!(orders[0]["order_id"], "#A2");
    assert_eq!(orders[0]["classification"], "fully_fulfillable");
    assert_eq!(orders[1]["order_id"], "#B2");
    assert_eq!(orders[1]["classification"], "partial");
    assert_eq!(orders[1]["lines"][0]["allocated"], "4");
    assert_eq!(r["result"]["units_used"], "10");

    let r = q(full, "orders.reservation_variance", json!({"order_id": "#V"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    let l = &r["result"]["lines"][0];
    assert_eq!(l["remaining_obligation"], "5");
    assert_eq!(l["under_reserved"], "1");

    let r = q(full, "orders.inbound_delay_impact", json!({})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["confirmed_affected_orders"], json!(["#D"]));
    assert_eq!(r["result"]["commitments"][0]["affected"][0]["risk"], "incoming_after_customer_deadline");

    let r = q(full, "shipments.attention", json!({"now": now, "order_id": "#S"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["attention"], json!(["S1"]));
    assert_eq!(r["result"]["shipments"][0]["latest_scan_age_seconds"], 3600);

    let r = q(full, "shipments.promise_risk", json!({"now": "2026-10-31T10:00:00+01:00", "order_id": "#P"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    let c0 = &r["result"]["commitments"][0];
    assert_eq!(c0["overdue"], true);
    assert_eq!(c0["arrival_date"], "unknown");
    assert_eq!(c0["last_state"], "in_transit");

    let r = q(full, "orders.partial_delivery_gaps", json!({"order_id": "#G"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    let l = &r["result"]["orders"][0]["lines"][0];
    assert_eq!(l["remaining_to_dispatch"], "3");
    assert_eq!(l["remaining_to_deliver"], "5");

    let r = q(full, "customer.delivery_reply", json!({"order_id": "#P"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["facts"], json!(["arrival_unknown", "in_transit"]));
    assert_eq!(r["result"]["send_action"], false);
    assert_eq!(r["result"]["prior_promises_checked"], true);
    assert_eq!(r["result"]["prior_communications"][0]["message_id"], "M-P");

    let r = q(full, "invoices.outstanding", json!({"customer_id": "C-I"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["invoices"][0]["reported_open_minor"], 4520);
    assert_eq!(r["result"]["invoices"][0]["new_cash_from_marker"], 0);

    let r = q(full, "orders.missing_invoice", json!({})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert!(r["result"]["missing_invoice"].as_array().unwrap().iter().any(|o| o == "#S"));
    assert!(!r["result"]["missing_invoice"].as_array().unwrap().iter().any(|o| o == "#I"));

    let r = q(full, "invoices.order_amount_variance", json!({"invoice_id": "I-X"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["invoices"][0]["difference_minor"], 100);

    let r = q(full, "invoices.dispatch_evidence", json!({})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert!(r["result"]["without_send_evidence"].as_array().unwrap().iter().any(|i| i == "I-X"));
    let i1 = r["result"]["invoices"].as_array().unwrap().iter().find(|i| i["invoice_id"] == "I-1").unwrap();
    assert_eq!(i1["evidence"], "provider_reported_sent");
    assert_eq!(i1["recipient_delivery_proven"], false);

    let r = q(full, "orders.payment_state", json!({"order_id": "#I"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["collected_minor"], 5000);
    assert_eq!(r["result"]["remaining_minor"], 6900);
    assert_eq!(r["result"]["state"], "partially_collected");

    let r = q(full, "payments.recovered_attempts", json!({"order_id": "#R"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["orders"][0]["recovered"], true);
    assert_eq!(r["result"]["orders"][0]["failed_history_retained"][0]["attempt_id"], "T1-a");

    let r = q(full, "invoices.payment_variance", json!({"invoice_id": "I-1"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["remaining_minor"], 4520);
    assert_eq!(r["result"]["fee_added_to_customer_debt"], 0);

    let r = q(full, "receivables.review_queue", json!({"now": now})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["review"], json!(["I-1"]));
    assert_eq!(r["result"]["send_reminder"], false);

    let r = q(full, "providers.money_positions", json!({"account_ref": "acct-main"})).await?;
    assert!(r["status"] == "complete" || r["status"] == "partial", "{r}");
    let acc = &r["result"]["accounts"][0];
    assert_eq!(acc["net_assets_minor"].as_i64().unwrap(), acc["provider_balance_minor"].as_i64().unwrap() + acc["in_transit_minor"].as_i64().unwrap() + acc["bank_confirmed_minor"].as_i64().unwrap());
    assert_eq!(acc["held_minor"], 9700);
    assert_eq!(acc["bank_confirmed_minor"], 9170);
    assert_eq!(acc["in_transit_minor"], 5000);
    assert_eq!(r["result"]["unknown_components_are_zero"], false);

    let r = q(full, "payouts.gross_to_net", json!({"payout_id": "OUT-1"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["computed_net_minor"], 9170);
    assert_eq!(r["result"]["unexplained_minor"], 0);

    let r = q(full, "payouts.missing_bank_confirmation", json!({})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["missing_confirmation"], json!(["OUT-2"]));
    assert_eq!(r["result"]["payouts"][0]["conclusion"], "no_evidence_in_imported_interval");

    let r = q(full, "providers.holds_and_releases", json!({"now": now})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["held_minor"], 9700);
    assert_eq!(r["result"]["released_minor"], 0);
    assert_eq!(r["result"]["release_is_only_promised"], true);

    let r = q(full, "returns.lifecycle", json!({"return_id": "RET-L"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    let ret = &r["result"]["returns"][0];
    assert_eq!(ret["physical_return_received"], true);
    assert_eq!(ret["sellable_added"], "0");
    assert_eq!(ret["cash_refund_confirmed"], false);
    assert_eq!(ret["refund_state"], "pending");

    let r = q(full, "credits.refund_gaps", json!({"order_id": "#I"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["cash_refund_due_minor"], 2380);

    let r = q(full, "cancellations.outstanding_steps", json!({"order_id": "#C"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["remaining_steps"], json!(["release_reservation", "correct_invoice", "refund_payment"]));
    assert_eq!(r["result"]["stock_receipt_required"], false);

    let r = q(full, "refunds.chargeback_overlap", json!({"transaction_id": "TX-O"})).await?;
    assert_eq!(r["status"], "complete", "{r}");
    assert_eq!(r["result"]["net_customer_repayments_minor"], 20000);
    assert_eq!(r["result"]["excess_minor"], 10000);
    assert_eq!(r["result"]["transactions"][0]["review_required"], true);
    assert_eq!(r["result"]["duplicate_repayment_proven"], true);

    // ---- missing-data paths ----
    let r = q(sparse, "inventory.available_to_sell", json!({"item_id": "CUP-OLV", "requested_quantity": 100})).await?;
    assert_eq!(r["status"], "unknown");
    assert!(has_missing(&r, "stock.basis"));
    assert_eq!(r["result"]["available"], Value::Null);
    let r = q(sparse, "orders.fulfillable", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert!(has_missing(&r, "policy.priority_method"));
    assert_eq!(r["result"]["joint_plan"], Value::Null);
    let r = q(sparse, "orders.reservation_variance", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert!(has_missing(&r, "allocations.order_line_ownership"));
    let r = q(sparse, "orders.inbound_delay_impact", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert_eq!(r["result"]["confirmed_affected_orders"], Value::Null);
    let r = q(sparse, "shipments.attention", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert!(has_missing(&r, "tracking.coverage"));
    assert_eq!(r["result"]["delivery_status"], "unknown");
    let r = q(sparse, "shipments.promise_risk", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert!(has_missing(&r, "promises.promised_at"));
    assert_eq!(r["result"]["promise_breached"], Value::Null);
    let r = q(sparse, "orders.partial_delivery_gaps", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert!(has_missing(&r, "fulfillments.line_quantity_links"));
    let r = q(sparse, "customer.delivery_reply", json!({"order_id": "#M"})).await?;
    assert_eq!(r["status"], "partial");
    assert!(has_missing(&r, "communications"));
    assert_eq!(r["result"]["prior_promises_checked"], false);
    let r = q(sparse, "invoices.outstanding", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert!(has_missing(&r, "invoices.correction_chain_coverage"));
    assert_eq!(r["result"]["open_minor"], Value::Null);
    let r = q(sparse, "orders.missing_invoice", json!({"rule": "after_confirmed_dispatch"})).await?;
    assert_eq!(r["status"], "unknown");
    assert_eq!(r["result"]["missing_invoice"], Value::Null);
    let r = q(sparse, "invoices.order_amount_variance", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert!(has_missing(&r, "invoices.line_links"));
    let r = q(sparse, "invoices.dispatch_evidence", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert_eq!(r["result"]["without_send_evidence_population_complete"], false);
    let r = q(sparse, "orders.payment_state", json!({"order_id": "#M"})).await?;
    assert_eq!(r["status"], "unknown");
    assert!(has_missing(&r, "payments.status"));
    assert_eq!(r["result"]["collected_minor"], Value::Null);
    let r = q(sparse, "payments.recovered_attempts", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert_eq!(r["result"]["recovered_population_complete"], false);
    let r = q(sparse, "invoices.payment_variance", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert!(has_missing(&r, "payment_allocations"));
    assert_eq!(r["result"]["unallocated_payments_separate"], true);
    let r = q(nocases, "receivables.review_queue", json!({"now": now})).await?;
    assert_eq!(r["status"], "partial", "{r}");
    assert!(has_missing(&r, "cases.coverage"));
    assert_eq!(r["result"]["queue_label"], "amounts_due_case_context_unknown");
    assert_eq!(r["result"]["automatic_action"], false);
    assert_eq!(r["result"]["review"], json!(["I-1"]), "amounts due are still listed");
    let r = q(nocases, "providers.money_positions", json!({})).await?;
    assert_eq!(r["status"], "partial", "{r}");
    let u = r["result"]["unknown_components"].as_array().unwrap();
    assert!(u.iter().any(|x| x == "held") && u.iter().any(|x| x == "processing"));
    assert_eq!(r["result"]["unknown_components_are_zero"], false);
    let r = q(sparse, "payouts.gross_to_net", json!({"payout_id": "OUT-404"})).await?;
    assert_eq!(r["status"], "unknown");
    assert_eq!(r["result"]["reconciled"], false);
    let r = q(nocases, "payouts.gross_to_net", json!({"payout_id": "OUT-N"})).await?;
    assert_eq!(r["status"], "unknown");
    assert!(has_missing(&r, "provider_ledger.payout_membership_coverage"));
    let r = q(sparse, "payouts.missing_bank_confirmation", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert_eq!(r["result"]["bank_arrival"], "unknown");
    let r = q(sparse, "providers.holds_and_releases", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert_eq!(r["result"]["held_minor"], Value::Null);
    let r = q(nocases, "returns.lifecycle", json!({})).await?;
    assert_eq!(r["status"], "partial", "{r}");
    assert_eq!(r["result"]["returns"][0]["receipt_state"], "unknown");
    assert_eq!(r["result"]["request_is_not_receipt"], true);
    let r = q(sparse, "credits.refund_gaps", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert_eq!(r["result"]["refund_due_minor"], Value::Null);
    let r = q(sparse, "cancellations.outstanding_steps", json!({"order_id": "#M"})).await?;
    assert_eq!(r["status"], "partial", "{r}");
    assert_eq!(r["result"]["reservation_step"], "unknown");
    assert_eq!(r["result"]["do_not_mark_complete"], true);
    let r = q(sparse, "refunds.chargeback_overlap", json!({})).await?;
    assert_eq!(r["status"], "unknown");
    assert_eq!(r["result"]["duplicate_repayment_proven"], false);

    // ---- contract hygiene: every intent reachable, unknown params rejected, envelope shape ----
    for intent in INTENTS {
        let params = match *intent {
            "inventory.available_to_sell" => json!({"item_id": "CUP-OLV"}),
            "payouts.gross_to_net" => json!({"payout_id": "OUT-1"}),
            "cancellations.outstanding_steps" => json!({"order_id": "#C"}),
            _ => json!({}),
        };
        let r = engine.query_ok(full, intent, params.clone()).await?;
        for k in ["status", "result", "calculation", "evidence_refs", "entry_ids", "missing_inputs", "conflicts", "coverage", "consistency", "page", "rule_version"] {
            assert!(r.get(k).is_some(), "{intent} envelope lacks {k}");
        }
        assert!(!r["calculation"].as_array().unwrap().is_empty(), "{intent} must explain its calculation");
        let mut bad = params.as_object().cloned().unwrap_or_default();
        bad.insert("unexpected_param".into(), json!(1));
        let (st, e) = engine.query(full, intent, Value::Object(bad)).await?;
        assert_eq!(st, 400, "{intent}: {e}");
        assert_eq!(e["error"]["code"], "invalid_params");
    }
    let (st, e) = engine.query(full, "orders.nonexistent", json!({})).await?;
    assert_eq!(st, 400);
    assert_eq!(e["error"]["code"], "unsupported_intent");
    // Pagination: bounded page with continuation.
    let (st, p) = engine.post("/v1/query", json!({"tenant_id": full, "intent": "orders.payment_state", "params": {}, "page": {"limit": 2}, "consistency": {"mode": "latest_committed"}})).await?;
    assert_eq!(st, 200);
    assert_eq!(p["page"]["returned"], 2);
    assert_eq!(p["page"]["truncated"], true);
    let (st, p2) = engine.post("/v1/query", json!({"tenant_id": full, "intent": "orders.payment_state", "params": {}, "page": {"limit": 2, "cursor": p["page"]["next_cursor"]}, "consistency": {"mode": "latest_committed"}})).await?;
    assert_eq!(st, 200);
    assert_ne!(p2["result"]["orders"][0]["order_id"], p["result"]["orders"][0]["order_id"]);
    let (st, e) = engine.post("/v1/query", json!({"tenant_id": full, "intent": "orders.payment_state", "params": {}, "page": {"limit": 501}})).await?;
    assert_eq!(st, 400, "{e}");
    // Schema endpoint.
    let r = engine.client.get(format!("{}/v1/schema", engine.base_url)).header("X-Engine-Token", ENGINE_TOKEN).send().await?;
    let schema: Value = r.json().await?;
    assert_eq!(schema["intents"].as_array().unwrap().len(), 24);
    assert_eq!(schema["record_types"].as_array().unwrap().len(), 28);
    // Auth.
    let r = engine.client.get(format!("{}/v1/schema", engine.base_url)).send().await?;
    assert_eq!(r.status().as_u16(), 401);
    Ok(())
}
