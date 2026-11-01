//! End-to-end: PostgreSQL append boundary -> engine tail -> HTTP contract.
//! Requires the throwaway PostgreSQL container (docs/engine.md "Running the tests").

use anyhow::Result;
use blackbox_domain::fixture::{append_json, compare_expected, expected_checkpoints, mutate, payload_hash, GoldenEvent, GoldenScenario, ScenarioParams};
use blackbox_engine_tests::*;
use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

fn golden() -> GoldenScenario {
    GoldenScenario::load_from_repo().unwrap()
}

async fn run_checkpoints(db: &TestDb, engine: &Engine, tenant: Uuid, events: &[GoldenEvent], params: &ScenarioParams, derived: bool) -> Result<()> {
    let mut app = Appender::new(db, tenant, derived).await?;
    let expected = expected_checkpoints(params);
    let order = format!("#1001{}", params.suffix);
    for ev in events {
        let (_, _, last) = app.observe(ev).await?;
        if let Some((_, exp)) = expected.iter().find(|(a, _)| *a == ev.id) {
            let v = engine.order_state(tenant, &order).await?;
            assert!(v["consistency"]["applied_cursor"].as_i64().unwrap() >= last, "latest_committed waited for the append");
            assert_eq!(v["consistency"]["status"], "current");
            let diffs = compare_expected(&v["state"], exp);
            assert!(diffs.is_empty(), "checkpoint {} derived={derived}: {diffs:?}\n{}", ev.id, v["state"]);
        }
    }
    Ok(())
}

#[tokio::test]
async fn golden_checkpoints_over_http_both_shapes_and_tenant_isolation() -> Result<()> {
    let db = TestDb::create("golden").await?;
    let a = db.create_tenant("Studio Nord").await?;
    let b = db.create_tenant("Separate test merchant").await?;
    let mut engine = Engine::spawn(&db, &[]).await?;
    let g = golden();
    // Tenant A: source entries only. Tenant B: same external ids, amount 50000 cents, derived entries.
    run_checkpoints(&db, &engine, a, &g.events, &ScenarioParams::golden(), false).await?;
    let mut pb = ScenarioParams::golden();
    pb.unit_gross_minor = 5000;
    let b_events = mutate(&g, &pb);
    run_checkpoints(&db, &engine, b, &b_events, &pb, true).await?;

    // Final state and invariants for A.
    let v = engine.order_state(a, "#1001").await?;
    let s = &v["state"];
    assert_eq!(s.as_object().unwrap().len(), 23);
    let n = |k: &str| s[k].as_i64().unwrap();
    assert_eq!(n("captured_minor") - n("fees_minor") - n("refunded_minor"), n("provider_balance_minor") + n("in_transit_minor") + n("bank_confirmed_minor"));
    assert_eq!(n("customer_net_paid_minor"), 9520);
    assert_eq!(s["currency"], "EUR");
    assert_eq!(s["unit"], "piece");
    assert_eq!(v["status"], "complete");
    // Five track summaries present, source track has the 19 observations.
    assert_eq!(v["tracks"]["source"]["total"], 19);
    assert_eq!(v["tracks"]["movement"]["total"], 0, "source-only tenant has no derived movement entries");
    assert_eq!(v["entry_ids"].as_array().unwrap().len(), 19);
    assert!(v["coverage"]["datasets_present"].as_array().unwrap().iter().any(|d| d == "bank"));

    // Tenant B: identical external ids, different money; derived tracks populated.
    let vb = engine.order_state(b, "#1001").await?;
    assert_eq!(vb["state"]["captured_minor"], 50000);
    assert_eq!(vb["state"]["bank_confirmed_minor"], 50000 - 350 - 10000);
    assert!(vb["tracks"]["movement"]["total"].as_i64().unwrap() > 0);
    assert_eq!(v["state"]["captured_minor"], 11900, "tenant A unchanged by tenant B");
    // Entry ids never cross tenants.
    let ids_a: Vec<String> = v["entry_ids"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
    for id in vb["entry_ids"].as_array().unwrap() {
        assert!(!ids_a.contains(&id.as_str().unwrap().to_string()));
    }
    // Querying B's data with A's tenant id never discloses it: transaction TX-1001 in A has A's amounts.
    let (st, tx) = engine.state(a, "transaction", "TX-1001", json!({"mode": "latest_committed"})).await?;
    assert_eq!(st, 200);
    assert_eq!(tx["state"]["captured_minor"], 11900);
    // Health shows both tenants ready with zero lag.
    let h = engine.health().await?;
    assert_eq!(h["status"], "healthy");
    assert_eq!(h["tenants"][a.to_string()]["lag_entries"], 0);
    assert!(h["rss_bytes"].as_u64().unwrap() > 0);
    engine.kill();
    Ok(())
}

#[tokio::test]
async fn adversarial_variants_over_http() -> Result<()> {
    let db = TestDb::create("adversarial").await?;
    let g = golden();
    let engine = Engine::spawn(&db, &[]).await?;

    // duplicate_concurrent: deliver G06, G08, G16, G19 five times each, in parallel.
    let t = db.create_tenant("dup").await?;
    let mut app = Appender::new(&db, t, true).await?;
    let mut sources = Vec::new();
    for ev in &g.events {
        let src = app.source(ev).await?;
        sources.push(src.clone());
        app.observe_entry(src).await?;
    }
    let reference = engine.order_state(t, "#1001").await?["state"].clone();
    let mut handles = Vec::new();
    for id in ["fixture-06", "fixture-08", "fixture-16", "fixture-19"] {
        let src = sources.iter().find(|e| e.provider_event_id.as_deref() == Some(id)).unwrap().clone();
        for _ in 0..5 {
            let api = db.api.clone();
            let src = src.clone();
            handles.push(tokio::spawn(async move {
                let mut tx = api.begin().await.unwrap();
                sqlx::query("SELECT set_config('app.tenant_id', $1, true)").bind(t.to_string()).execute(&mut *tx).await.unwrap();
                sqlx::query("SELECT append_journal_entries($1::jsonb)").bind(Value::Array(vec![append_json(&src)])).execute(&mut *tx).await.unwrap();
                tx.commit().await.unwrap();
            }));
        }
    }
    for h in handles {
        h.await?;
    }
    let after = engine.order_state(t, "#1001").await?;
    assert_eq!(after["state"], reference, "duplicate concurrent deliveries do not change state");
    assert_eq!(after["tracks"]["source"]["total"], 19 + 20);
    let dedup = after["tracks"]["source"]["entries"].as_array().unwrap().iter().filter(|e| e["effect"] == "deduplicated").count();
    assert_eq!(dedup, 20);
    assert!(after["conflicts"].as_array().unwrap().is_empty());

    // late_payment_failure: after G08 deliver an earlier failed attempt for TX-1001.
    let t2 = db.create_tenant("latefail").await?;
    let mut app2 = Appender::new(&db, t2, false).await?;
    for ev in g.events.iter().take(8) {
        app2.observe(ev).await?;
    }
    let failed = event("fail", "payment", "payment.failed", g.events[4].occurred_at - ChronoDuration::seconds(30), &[("order", "#1001"), ("customer", "C-1"), ("item", "CUP-OLV")], json!({"transaction": "TX-1001", "attempt": "ATT-0", "amount_minor": 11900, "currency": "EUR", "reason": "card_declined"}));
    app2.observe(&failed).await?;
    for ev in g.events.iter().skip(8) {
        app2.observe(ev).await?;
    }
    let v = engine.order_state(t2, "#1001").await?;
    assert_eq!(v["state"]["captured_minor"], 11900);
    assert_eq!(v["state"]["bank_confirmed_minor"], 9170);
    let (st, tx) = engine.state(t2, "transaction", "TX-1001", json!({"mode": "latest_committed"})).await?;
    assert_eq!(st, 200);
    assert_eq!(tx["state"]["status"], "captured");
    assert_eq!(tx["state"]["failed_attempts"], 1);
    assert!(tx["tracks"]["source"]["entries"].as_array().unwrap().iter().any(|e| e["event_type"] == "payment.failed"));
    let q = engine.query_ok(t2, "orders.payment_state", json!({"order_id": "#1001"})).await?;
    assert_eq!(q["result"]["state"], "paid");
    assert_eq!(q["result"]["orders"][0]["failed_attempts"], 1);

    // missing_bank: stop at G18.
    let t3 = db.create_tenant("missingbank").await?;
    let mut app3 = Appender::new(&db, t3, true).await?;
    for ev in g.events.iter().take(18) {
        app3.observe(ev).await?;
    }
    let v = engine.order_state(t3, "#1001").await?;
    assert_eq!(v["state"]["in_transit_minor"], 9170);
    assert_eq!(v["state"]["bank_confirmed_minor"], 0);
    assert!(v["coverage"]["datasets_missing"].as_array().unwrap().iter().any(|d| d == "bank"));
    let q = engine.query_ok(t3, "payouts.missing_bank_confirmation", json!({})).await?;
    assert_eq!(q["status"], "unknown");
    assert_eq!(q["result"]["bank_arrival"], "unknown");
    assert!(q["missing_inputs"].as_array().unwrap().iter().any(|m| m == "bank"));
    let q = engine.query_ok(t3, "providers.money_positions", json!({})).await?;
    assert_eq!(q["result"]["in_transit_minor"], 9170);
    assert!(q["result"]["unknown_components"].as_array().unwrap().iter().any(|u| u == "bank_confirmed"));

    // missing_credit_source: no G14, provider refund evidence only.
    let t4 = db.create_tenant("missingcredit").await?;
    let mut app4 = Appender::new(&db, t4, false).await?;
    for ev in g.events.iter().filter(|e| e.id != "G14") {
        app4.observe(ev).await?;
    }
    let v = engine.order_state(t4, "#1001").await?;
    assert_eq!(v["state"]["refunded_minor"], 2380, "refund movement known");
    assert_eq!(v["state"]["invoice_credit_minor"], 0, "no credit note fabricated");
    let q = engine.query_ok(t4, "credits.refund_gaps", json!({"order_id": "#1001"})).await?;
    assert_eq!(q["status"], "unknown");
    assert_eq!(q["result"]["refund_due_minor"], Value::Null);
    assert!(q["result"]["credits_without_entitlement"].as_array().unwrap().is_empty());
    let q = engine.query_ok(t4, "returns.lifecycle", json!({"order_id": "#1001"})).await?;
    assert_eq!(q["result"]["returns"][0]["refund_state"], "completed");
    assert_eq!(q["result"]["returns"][0]["cash_refund_confirmed"], true);

    // reorder_independent: G08 delayed until after G10; snapshot duplicated.
    let t5 = db.create_tenant("reorder").await?;
    let mut app5 = Appender::new(&db, t5, true).await?;
    let mut events = g.events.clone();
    let g08 = events.remove(7);
    events.insert(9, g08);
    events.push(events[0].clone());
    for ev in &events {
        app5.observe(ev).await?;
    }
    let v = engine.order_state(t5, "#1001").await?;
    assert_eq!(v["state"], reference, "reordered independent entries give the same state");
    let (st, h) = engine.post("/v1/history", json!({"tenant_id": t5, "entity_type": "order", "entity_id": "#1001", "page": {"limit": 100}, "consistency": {"mode": "latest_committed"}})).await?;
    assert_eq!(st, 200);
    let entries = h["entries"].as_array().unwrap();
    let marker = entries.iter().find(|e| e["event_type"] == "invoice.payment_marked" && e["track"] == "source").unwrap();
    let delivered = entries.iter().find(|e| e["event_type"] == "shipment.delivered" && e["track"] == "source").unwrap();
    assert!(marker["journal_sequence"].as_i64() > delivered["journal_sequence"].as_i64(), "recorded chronology explicit");
    assert!(marker["occurred_at"].as_str() < delivered["occurred_at"].as_str(), "effective time retained");
    Ok(())
}

#[tokio::test]
async fn late_correction_supersedes_with_as_of_and_history_pages() -> Result<()> {
    let db = TestDb::create("correction").await?;
    let t = db.create_tenant("corr").await?;
    let engine = Engine::spawn(&db, &[]).await?;
    let g = golden();
    let mut app = Appender::new(&db, t, false).await?;
    let mut fee_id = None;
    let mut fee_seq = 0;
    for ev in &g.events {
        let (id, seq, _) = app.observe(ev).await?;
        if ev.id == "G07" {
            fee_id = Some(id);
            fee_seq = seq;
        }
    }
    let before = engine.order_state(t, "#1001").await?;
    assert_eq!(before["state"]["fees_minor"], 350);
    let cutoff_before = Utc::now();
    tokio::time::sleep(Duration::from_millis(20)).await;
    // Owner review decision corrects the fee (fact track, supersedes the original assertion).
    let mut corr = app.source(&g.events[6]).await?;
    corr.track = blackbox_domain::Track::Fact;
    corr.event_type = "payment.fee_booked".into();
    corr.provider_event_id = None;
    corr.correlation_id = Some("review:fee-correction-1".into());
    corr.supersedes_entry_id = fee_id;
    corr.payload = json!({"transaction": "TX-1001", "fee_minor": 400, "currency": "EUR", "reason": "provider statement correction"});
    corr.payload_hash = payload_hash(&corr.payload);
    corr.derivation_rule = Some("review.decision".into());
    let (_, corr_seq, _) = app.observe_entry(corr).await?;
    let after = engine.order_state(t, "#1001").await?;
    assert_eq!(after["state"]["fees_minor"], 400);
    assert_eq!(after["state"]["provider_balance_minor"], -50);
    let src_entries = after["tracks"]["source"]["entries"].as_array().unwrap();
    let orig = src_entries.iter().find(|e| e["journal_sequence"] == fee_seq).unwrap();
    assert_eq!(orig["effect"], "superseded");
    assert!(orig["superseded_by"].is_string());
    let fact_entries = after["tracks"]["fact"]["entries"].as_array().unwrap();
    assert!(fact_entries.iter().any(|e| e["journal_sequence"] == corr_seq && e["effect"] == "applied"));

    // as_of (recorded cutoff before the correction): historical answer keeps the prior state.
    let (st, hist) = engine.state(t, "order", "#1001", json!({"mode": "as_of", "as_of_recorded": cutoff_before.to_rfc3339()})).await?;
    assert_eq!(st, 200, "{hist}");
    assert_eq!(hist["consistency"]["status"], "historical");
    assert_eq!(hist["state"]["fees_minor"], 350);
    assert_eq!(hist["state"]["bank_confirmed_minor"], 9170);
    assert!(hist["consistency"]["recorded_cutoff"].as_str().unwrap().starts_with(&cutoff_before.format("%Y-%m-%dT%H:%M").to_string()));
    // Effective-time cutoff: before the shipment, stock is still reserved.
    let (st, eff) = engine.state(t, "order", "#1001", json!({"mode": "as_of", "as_of_recorded": Utc::now().to_rfc3339(), "as_of_effective": g.events[7].occurred_at.to_rfc3339()})).await?;
    assert_eq!(st, 200);
    assert_eq!(eff["state"]["reserved_stock"], "10");
    assert_eq!(eff["state"]["captured_minor"], 11900);
    assert_eq!(eff["state"]["bank_confirmed_minor"], 0);
    assert!(eff["consistency"]["effective_cutoff"].is_string());
    // as_of query intents through the same reducers.
    let (st, q) = engine.post("/v1/query", json!({"tenant_id": t, "intent": "orders.payment_state", "params": {"order_id": "#1001"}, "consistency": {"mode": "as_of", "as_of_recorded": Utc::now().to_rfc3339(), "as_of_effective": g.events[4].occurred_at.to_rfc3339()}})).await?;
    assert_eq!(st, 200, "{q}");
    assert_eq!(q["result"]["state"], "authorized_only");
    assert_eq!(q["consistency"]["status"], "historical");

    // History pagination with a stable snapshot while new entries commit.
    let (st, p1) = engine.post("/v1/history", json!({"tenant_id": t, "entity_type": "order", "entity_id": "#1001", "page": {"limit": 7}, "consistency": {"mode": "latest_committed"}})).await?;
    assert_eq!(st, 200);
    assert_eq!(p1["page"]["truncated"], true);
    let snapshot = p1["page"]["snapshot_cursor"].as_i64().unwrap();
    // Concurrent append (a later snapshot) must not appear inside the paged snapshot.
    app.observe(&g.events[0]).await?;
    let mut all: Vec<i64> = p1["entries"].as_array().unwrap().iter().map(|e| e["journal_sequence"].as_i64().unwrap()).collect();
    let mut cursor = p1["page"]["next_cursor"].as_str().map(|s| s.to_string());
    while let Some(c) = cursor.clone() {
        let (st, p) = engine.post("/v1/history", json!({"tenant_id": t, "entity_type": "order", "entity_id": "#1001", "page": {"limit": 7, "cursor": c}, "consistency": {"mode": "latest_committed"}})).await?;
        assert_eq!(st, 200, "{p}");
        assert_eq!(p["page"]["snapshot_cursor"], snapshot);
        all.extend(p["entries"].as_array().unwrap().iter().map(|e| e["journal_sequence"].as_i64().unwrap()));
        cursor = p["page"]["next_cursor"].as_str().map(|s| s.to_string());
        if cursor.is_none() {
            assert_eq!(p["page"]["newer_available"], true, "continuation for newer records is exposed");
        }
    }
    let mut sorted = all.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), all.len(), "no duplicates");
    assert_eq!(all.len(), 20, "19 observations + 1 correction inside the snapshot; the later append is excluded");
    assert!(all.iter().all(|s| *s <= snapshot));
    // A cursor from another tenant is rejected without leaking data.
    let other = db.create_tenant("other").await?;
    let (st, err) = engine.post("/v1/history", json!({"tenant_id": other, "entity_type": "order", "entity_id": "#1001", "page": {"limit": 7, "cursor": p1["page"]["next_cursor"]}, "consistency": {"mode": "latest_committed"}})).await?;
    assert_eq!(st, 400);
    assert_eq!(err["error"]["code"], "invalid_params");
    Ok(())
}

#[tokio::test]
async fn mutated_scenario_over_http_with_other_currency() -> Result<()> {
    let db = TestDb::create("mutated").await?;
    let t = db.create_tenant("mut").await?;
    let engine = Engine::spawn(&db, &[]).await?;
    let g = golden();
    let p = ScenarioParams {
        quantity: 7,
        unit_gross_minor: 2599,
        fee_minor: 611,
        return_quantity: 3,
        physical_stock: 42,
        currency: "CHF".into(),
        suffix: "-chf".into(),
    };
    let events = mutate(&g, &p);
    run_checkpoints(&db, &engine, t, &events, &p, true).await?;
    let v = engine.order_state(t, "#1001-chf").await?;
    assert_eq!(v["state"]["currency"], "CHF");
    assert_eq!(v["state"]["bank_confirmed_minor"], p.payout());
    // Summary per currency over the scenario day.
    let (st, s) = engine.post("/v1/summary", json!({"tenant_id": t, "kind": "thirty_day_summary", "from": (events[0].occurred_at - ChronoDuration::days(1)).to_rfc3339(), "to": (events[0].occurred_at + ChronoDuration::days(1)).to_rfc3339(), "consistency": {"mode": "latest_committed"}})).await?;
    assert_eq!(st, 200, "{s}");
    assert_eq!(s["totals"]["CHF"]["captured_minor"], p.gross());
    assert_eq!(s["totals"]["CHF"]["refunded_minor"], p.credit());
    assert_eq!(s["totals"]["CHF"]["payouts_sent_minor"], p.payout());
    assert_eq!(s["counts"]["orders_accepted"], 1);
    assert!(s["totals"].get("EUR").is_none());
    Ok(())
}
