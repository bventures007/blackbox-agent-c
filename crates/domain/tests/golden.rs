//! DOMAIN-01..07 at the reducer level: golden checkpoints, mutation, adversarial variants.

use blackbox_domain::fixture::*;
use blackbox_domain::reducer::Outcome;
use blackbox_domain::state::fields::*;
use blackbox_domain::views::{order_view, record_view};
use blackbox_domain::{apply, Entry, Kind, TenantState};
use chrono::{Duration, Utc};
use proptest::prelude::*;
use serde_json::Value;
use uuid::Uuid;

fn tenant_a() -> Uuid {
    Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap()
}

fn tenant_b() -> Uuid {
    Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap()
}

/// Builds journal entries for events; `derived` adds the derived track entries per observation.
fn build(tenant: Uuid, events: &[GoldenEvent], derived: bool) -> Vec<Entry> {
    let mut seq = 0i64;
    let mut out = Vec::new();
    let base = Utc::now();
    for (i, ev) in events.iter().enumerate() {
        seq += 1;
        let conn = connection_uuid(tenant, &ev.connection);
        let src = source_entry(tenant, seq, ev, conn, base + Duration::seconds(i as i64));
        if derived {
            let d = derived_entries(&src, seq + 1);
            seq += d.len() as i64;
            out.push(src);
            out.extend(d);
        } else {
            out.push(src);
        }
    }
    out
}

fn order_json(st: &TenantState, order: &str) -> Value {
    let sym = st.interner.get(order).expect("order interned");
    let v = order_view(st, sym).expect("order view");
    assert!(!v.currency_conflict, "unexpected currency conflict");
    serde_json::to_value(v.state).unwrap()
}

fn check_scenario(events: &[GoldenEvent], params: &ScenarioParams, derived: bool) -> TenantState {
    let tenant = tenant_a();
    let entries = build(tenant, events, derived);
    let mut st = TenantState::new(tenant);
    let order = format!("#1001{}", params.suffix);
    let expected = expected_checkpoints(params);
    for e in &entries {
        let out = apply(&mut st, e);
        assert!(
            matches!(out, Outcome::Applied | Outcome::Deduplicated | Outcome::Recorded),
            "{} {:?} -> {:?}",
            e.event_type,
            e.track,
            out
        );
        // Checkpoint after the last entry of an observation.
        let is_last_of_obs = !derived
            || !entries
                .iter()
                .any(|x| x.input_entry_ids.contains(&e.entry_id) && x.journal_sequence > e.journal_sequence)
                && (e.track != blackbox_domain::Track::Source || derived_tracks(&e.event_type).is_empty());
        if is_last_of_obs {
            let obs_id = events
                .iter()
                .find(|ev| ev.provider_event_id == e.correlation_id.clone().unwrap().split(':').nth(1).unwrap())
                .map(|ev| ev.id.clone());
            if let Some(id) = obs_id {
                if let Some((_, exp)) = expected.iter().find(|(a, _)| *a == id) {
                    let actual = order_json(&st, &order);
                    let diffs = compare_expected(&actual, exp);
                    assert!(diffs.is_empty(), "checkpoint {id} (derived={derived}): {diffs:?}\n{actual}");
                }
            }
        }
    }
    st
}

#[test]
fn expectation_model_matches_golden_file() {
    let g = GoldenScenario::load_from_repo().unwrap();
    let model = expected_checkpoints(&ScenarioParams::golden());
    assert_eq!(g.checkpoints.len(), model.len());
    for (cp, (after, exp)) in g.checkpoints.iter().zip(model.iter()) {
        assert_eq!(&cp.after, after);
        assert_eq!(&cp.expected, exp, "checkpoint {after}");
    }
}

#[test]
fn golden_checkpoints_source_only() {
    let g = GoldenScenario::load_from_repo().unwrap();
    let st = check_scenario(&g.events, &ScenarioParams::golden(), false);
    let v = order_json(&st, "#1001");
    // Invariant: captured - fees - refunded = balance + in_transit + bank_confirmed.
    let n = |k: &str| v[k].as_i64().unwrap();
    assert_eq!(
        n("captured_minor") - n("fees_minor") - n("refunded_minor"),
        n("provider_balance_minor") + n("in_transit_minor") + n("bank_confirmed_minor")
    );
    assert_eq!(n("customer_net_paid_minor"), 9520);
    assert_eq!(v["currency"], "EUR");
    assert_eq!(v["unit"], "piece");
    assert_eq!(v.as_object().unwrap().len(), 23, "exact key set of the state contract");
}

#[test]
fn golden_checkpoints_with_derived_entries() {
    let g = GoldenScenario::load_from_repo().unwrap();
    let st = check_scenario(&g.events, &ScenarioParams::golden(), true);
    // Derived entries are recorded but never double counted.
    let dedup = st.entries.values().filter(|m| m.effect == blackbox_domain::state::EFFECT_DEDUPLICATED).count();
    assert!(dedup > 0);
}

#[test]
fn derived_before_source_gives_same_state() {
    let g = GoldenScenario::load_from_repo().unwrap();
    let tenant = tenant_a();
    let entries = build(tenant, &g.events, true);
    let mut a = TenantState::new(tenant);
    for e in &entries {
        apply(&mut a, e);
    }
    // Swap within each observation group: derived first, source last (same sequence set).
    let mut swapped: Vec<Entry> = Vec::new();
    let mut i = 0;
    while i < entries.len() {
        let src = &entries[i];
        let n = derived_tracks(&src.event_type).len();
        for d in &entries[i + 1..i + 1 + n] {
            swapped.push(d.clone());
        }
        swapped.push(src.clone());
        i += 1 + n;
    }
    let mut b = TenantState::new(tenant);
    for e in &swapped {
        apply(&mut b, e);
    }
    assert_eq!(order_json(&a, "#1001"), order_json(&b, "#1001"));
}

#[test]
fn duplicate_concurrent_deliveries_do_not_change_state() {
    let g = GoldenScenario::load_from_repo().unwrap();
    let tenant = tenant_a();
    let base = build(tenant, &g.events, true);
    let reference = {
        let mut st = TenantState::new(tenant);
        for e in &base {
            apply(&mut st, e);
        }
        order_json(&st, "#1001")
    };
    // Deliver G06, G08, G16 and G19 five times each (new entry ids, same provider identity).
    let mut entries = base.clone();
    let mut seq = entries.last().unwrap().journal_sequence;
    for id in ["fixture-06", "fixture-08", "fixture-16", "fixture-19"] {
        let src = base
            .iter()
            .find(|e| e.provider_event_id.as_deref() == Some(id))
            .unwrap()
            .clone();
        for _ in 0..5 {
            let mut dup = src.clone();
            dup.entry_id = Uuid::new_v4();
            seq += 1;
            dup.journal_sequence = seq;
            let derived = derived_entries(&dup, seq + 1);
            seq += derived.len() as i64;
            entries.push(dup);
            entries.extend(derived);
        }
    }
    let mut st = TenantState::new(tenant);
    let mut dedup = 0;
    for e in &entries {
        if apply(&mut st, e) == Outcome::Deduplicated {
            dedup += 1;
        }
    }
    assert!(dedup >= 20);
    assert_eq!(order_json(&st, "#1001"), reference);
    assert!(st.conflicts.is_empty(), "identical repeats are not conflicts");
    // Idempotent per entry id as well.
    let before = st.state_hash;
    for e in &entries {
        assert_eq!(apply(&mut st, e), Outcome::AlreadyApplied);
    }
    assert_eq!(before, st.state_hash);
}

#[test]
fn late_payment_failure_does_not_change_capture() {
    let g = GoldenScenario::load_from_repo().unwrap();
    let tenant = tenant_a();
    let mut entries = build(tenant, &g.events, false);
    // After G08: an earlier failed attempt for TX-1001 with earlier occurred_at and distinct attempt id.
    let g08_pos = entries.iter().position(|e| e.provider_event_id.as_deref() == Some("fixture-08")).unwrap();
    let mut failed = entries[g08_pos].clone();
    failed.entry_id = Uuid::new_v4();
    failed.event_type = "payment.failed".into();
    failed.record_id = "transaction:TX-1001".into();
    failed.provider_event_id = Some("fixture-05b".into());
    failed.correlation_id = Some("payment:fixture-05b".into());
    failed.occurred_at = entries[0].occurred_at + Duration::minutes(4) + Duration::seconds(30);
    failed.payload = serde_json::json!({"transaction": "TX-1001", "attempt": "ATT-0", "amount_minor": 11900, "currency": "EUR", "reason": "card_declined"});
    failed.payload_hash = payload_hash(&failed.payload);
    let mut rest = entries.split_off(g08_pos + 1);
    entries.push(failed);
    for e in rest.iter_mut() {
        e.journal_sequence += 1;
    }
    entries.extend(rest);
    for (i, e) in entries.iter_mut().enumerate() {
        e.journal_sequence = i as i64 + 1;
    }
    let mut st = TenantState::new(tenant);
    for e in &entries {
        apply(&mut st, e);
    }
    let v = order_json(&st, "#1001");
    assert_eq!(v["captured_minor"], 11900);
    assert_eq!(v["bank_confirmed_minor"], 9170);
    let tx = st.rec_by_str(Kind::Transaction, "TX-1001").unwrap();
    assert_eq!(tx.status, TX_ST_CAPTURED);
    assert_eq!(tx.m[TX_M_FAILED_ATTEMPTS], 1);
    let att = st.rec_by_str(Kind::Attempt, "ATT-0").unwrap();
    assert_eq!(att.status, ATT_ST_FAILED);
    let hist = st.history_of(Kind::Transaction, st.interner.get("TX-1001").unwrap());
    assert!(hist.iter().any(|l| st.sym(l.event) == "payment.failed"), "failed attempt visible in history");
}

#[test]
fn missing_bank_keeps_in_transit_and_unknown_bank() {
    let g = GoldenScenario::load_from_repo().unwrap();
    let events: Vec<GoldenEvent> = g.events.iter().take(18).cloned().collect();
    let tenant = tenant_a();
    let mut st = TenantState::new(tenant);
    for e in build(tenant, &events, true) {
        apply(&mut st, &e);
    }
    let v = order_json(&st, "#1001");
    assert_eq!(v["in_transit_minor"], 9170);
    assert_eq!(v["bank_confirmed_minor"], 0);
    assert!(!st.dataset_present("bank"), "bank dataset absent -> bank arrival unknown");
}

#[test]
fn missing_credit_source_keeps_refund_known_and_credit_unknown() {
    let g = GoldenScenario::load_from_repo().unwrap();
    let events: Vec<GoldenEvent> = g.events.iter().filter(|e| e.id != "G14").cloned().collect();
    let tenant = tenant_a();
    let mut st = TenantState::new(tenant);
    for e in build(tenant, &events, false) {
        apply(&mut st, &e);
    }
    let v = order_json(&st, "#1001");
    assert_eq!(v["refunded_minor"], 2380, "refund movement is known");
    assert_eq!(v["invoice_credit_minor"], 0, "no credit note is fabricated");
    assert!(st.ids(Kind::Credit).is_empty());
    assert_eq!(v["customer_net_paid_minor"], 9520);
}

#[test]
fn reorder_independent_entries_same_state() {
    let g = GoldenScenario::load_from_repo().unwrap();
    let tenant = tenant_a();
    // Delay G08 until after G10 and duplicate every source snapshot.
    let mut events = g.events.clone();
    let g08 = events.remove(7);
    events.insert(9, g08);
    let snapshot = events[0].clone();
    events.push(snapshot);
    let mut st = TenantState::new(tenant);
    for e in build(tenant, &events, true) {
        apply(&mut st, &e);
    }
    let reference = {
        let mut r = TenantState::new(tenant);
        for e in build(tenant, &g.events, true) {
            apply(&mut r, &e);
        }
        order_json(&r, "#1001")
    };
    assert_eq!(order_json(&st, "#1001"), reference);
    // Chronology stays explicit: history sequence order differs from occurred_at order.
    let hist = st.history_of(Kind::Order, st.interner.get("#1001").unwrap());
    let mut seqs: Vec<i64> = hist.iter().map(|l| l.seq).collect();
    seqs.dedup();
    assert!(hist.windows(2).any(|w| w[1].occurred_ms < w[0].occurred_ms), "late marker keeps effective time");
}

#[test]
fn tenant_collision_isolated() {
    let g = GoldenScenario::load_from_repo().unwrap();
    let mut a = TenantState::new(tenant_a());
    for e in build(tenant_a(), &g.events, true) {
        apply(&mut a, &e);
    }
    let mut p = ScenarioParams::golden();
    p.unit_gross_minor = 5000;
    let b_events = mutate(&g, &p);
    let mut b = TenantState::new(tenant_b());
    let b_entries = build(tenant_b(), &b_events, true);
    for e in &b_entries {
        apply(&mut b, e);
    }
    // Cross-tenant entries are rejected by the reducer.
    let mut a2 = a.clone();
    assert_eq!(apply(&mut a2, &b_entries[0]), Outcome::Conflict);
    assert_eq!(order_json(&a, "#1001")["captured_minor"], 11900);
    assert_eq!(order_json(&b, "#1001")["captured_minor"], 50000);
}

#[test]
fn supersedes_replaces_assertion_and_keeps_history() {
    let g = GoldenScenario::load_from_repo().unwrap();
    let tenant = tenant_a();
    let entries = build(tenant, &g.events, false);
    let mut st = TenantState::new(tenant);
    for e in &entries {
        apply(&mut st, e);
    }
    let fee = entries.iter().find(|e| e.event_type == "payment.fee_booked").unwrap();
    let mut corr = fee.clone();
    corr.entry_id = Uuid::new_v4();
    corr.journal_sequence = entries.len() as i64 + 1;
    corr.track = blackbox_domain::Track::Fact;
    corr.provider_event_id = None;
    corr.correlation_id = Some("review:fee-correction".into());
    corr.supersedes_entry_id = Some(fee.entry_id);
    corr.payload = serde_json::json!({"transaction": "TX-1001", "fee_minor": 400, "currency": "EUR"});
    corr.payload_hash = payload_hash(&corr.payload);
    corr.recorded_at = Utc::now();
    assert_eq!(apply(&mut st, &corr), Outcome::Applied);
    let v = order_json(&st, "#1001");
    assert_eq!(v["fees_minor"], 400);
    assert_eq!(v["provider_balance_minor"], -50, "balance reflects the corrected fee without double counting");
    let meta = st.entries.get(&fee.entry_id).unwrap();
    assert_eq!(meta.superseded_by, Some(corr.entry_id));
    let hist = st.history_of(Kind::Transaction, st.interner.get("TX-1001").unwrap());
    assert!(hist.iter().any(|l| l.entry_id == fee.entry_id), "history keeps the superseded entry");
    // Replaying the same correction is idempotent.
    assert_eq!(apply(&mut st, &corr), Outcome::AlreadyApplied);
    assert_eq!(order_json(&st, "#1001")["fees_minor"], 400);
}

#[test]
fn currency_mismatch_is_a_conflict_not_a_sum() {
    let g = GoldenScenario::load_from_repo().unwrap();
    let tenant = tenant_a();
    let mut entries = build(tenant, &g.events, false);
    let cap = entries.iter_mut().find(|e| e.event_type == "payment.captured").unwrap();
    cap.payload["currency"] = Value::String("USD".into());
    let mut st = TenantState::new(tenant);
    for e in &entries {
        apply(&mut st, e);
    }
    assert!(st.conflicts.iter().any(|c| c.reason == "currency_mismatch"));
    let v = order_json(&st, "#1001");
    assert_eq!(v["captured_minor"], 0, "USD capture is not added to EUR totals");
}

#[test]
fn item_view_reports_unknown_without_basis() {
    let tenant = tenant_a();
    let mut st = TenantState::new(tenant);
    let g = GoldenScenario::load_from_repo().unwrap();
    let events: Vec<GoldenEvent> = g.events.iter().filter(|e| e.id != "G01").take(3).cloned().collect();
    for e in build(tenant, &events, false) {
        apply(&mut st, &e);
    }
    let item = st.rec_by_str(Kind::Item, "CUP-OLV").unwrap();
    let v = record_view(&st, item);
    assert_eq!(v["available"], Value::Null);
    assert_eq!(v["stock_basis"], false);
    assert_eq!(v["reserved"], "10");
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]
    #[test]
    fn mutated_scenarios_hold_all_checkpoints(
        quantity in 1i64..=60,
        unit_gross in 1i64..=250_000,
        fee_frac in 0u32..=100,
        return_frac in 0u32..=100,
        extra_stock in 0i64..=500,
        cur_idx in 0usize..5,
        derived in any::<bool>(),
    ) {
        let g = GoldenScenario::load_from_repo().unwrap();
        let currencies = ["EUR", "USD", "CHF", "GBP", "JPY"];
        let gross = quantity * unit_gross;
        let p = ScenarioParams {
            quantity,
            unit_gross_minor: unit_gross,
            fee_minor: (gross * fee_frac as i64) / 1000,
            return_quantity: (quantity * return_frac as i64) / 100,
            physical_stock: quantity + extra_stock,
            currency: currencies[cur_idx].into(),
            suffix: format!("-m{quantity}-{unit_gross}"),
        };
        let events = mutate(&g, &p);
        check_scenario(&events, &p, derived);
    }
}
