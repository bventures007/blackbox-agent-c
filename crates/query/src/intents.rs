//! The 24 question intents (specs/question-data-contracts.json). Each returns an `Answer` with
//! explicit status, typed result, calculation steps, touched entities (for evidence) and
//! missing inputs. Unknown is a valid answer; nothing is fabricated.

use crate::{Answer, ParamSpec, ParamType, Params, QueryError, Status};
use blackbox_domain::reducer::RES_ST_ACTIVE_COVERED;
use blackbox_domain::state::fields::*;
use blackbox_domain::state::{ms_to_time, time_to_ms, Rec, RecKey, Sym, NONE};
use blackbox_domain::views::{item_available, item_reserved, record_view, ship_status_str};
use blackbox_domain::{Kind, TenantState};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const INTENTS: &[&str] = &[
    "inventory.available_to_sell",
    "orders.fulfillable",
    "orders.reservation_variance",
    "orders.inbound_delay_impact",
    "shipments.attention",
    "shipments.promise_risk",
    "orders.partial_delivery_gaps",
    "customer.delivery_reply",
    "invoices.outstanding",
    "orders.missing_invoice",
    "invoices.order_amount_variance",
    "invoices.dispatch_evidence",
    "orders.payment_state",
    "payments.recovered_attempts",
    "invoices.payment_variance",
    "receivables.review_queue",
    "providers.money_positions",
    "payouts.gross_to_net",
    "payouts.missing_bank_confirmation",
    "providers.holds_and_releases",
    "returns.lifecycle",
    "credits.refund_gaps",
    "cancellations.outstanding_steps",
    "refunds.chargeback_overlap",
];

const fn p(name: &'static str, ty: ParamType, required: bool, description: &'static str) -> ParamSpec {
    ParamSpec {
        name,
        ty,
        required,
        description,
    }
}

const NOW: ParamSpec = p("now", ParamType::Time, false, "Evaluation time (RFC3339); defaults to request time");
const ORDER_FILTER: ParamSpec = p("order_id", ParamType::Str, false, "Restrict to one order");
const CUSTOMER_FILTER: ParamSpec = p("customer_id", ParamType::Str, false, "Restrict to one customer");
const CURRENCY_FILTER: ParamSpec = p("currency", ParamType::Str, false, "Restrict to one ISO currency");

const SPEC_00: &[ParamSpec] = &[p("item_id", ParamType::Str, true, "Item (SKU) identifier"),
            p("requested_quantity", ParamType::Decimal, false, "Requested quantity in the item's unit"),
            p("location_id", ParamType::Str, false, "Location filter"),
            NOW];
const SPEC_01: &[ParamSpec] = &[p("item_id", ParamType::Str, false, "Only orders containing this item"),
            p("priority", ParamType::StrList, false, "Explicit order priority list (declared merchant priority)"),
            NOW];
const SPEC_02: &[ParamSpec] = &[ORDER_FILTER, NOW];
const SPEC_03: &[ParamSpec] = &[p("promise_id", ParamType::Str, false, "Only this supply commitment"),
            p("include_undelayed", ParamType::Bool, false, "Also evaluate commitments without a recorded delay"),
            NOW];
const SPEC_04: &[ParamSpec] = &[ORDER_FILTER,
            p("stale_after_seconds", ParamType::Int, false, "Override for the stale-scan threshold"),
            NOW];
const SPEC_05: &[ParamSpec] = &[ORDER_FILTER, p("risk_hours", ParamType::Int, false, "Override for the at-risk window"), NOW];
const SPEC_06: &[ParamSpec] = &[ORDER_FILTER, NOW];
const SPEC_07: &[ParamSpec] = &[p("order_id", ParamType::Str, false, "Order to answer about"),
            CUSTOMER_FILTER,
            NOW];
const SPEC_08: &[ParamSpec] = &[CUSTOMER_FILTER, CURRENCY_FILTER, p("due_before", ParamType::Time, false, "Only invoices due before this time"), NOW];
const SPEC_09: &[ParamSpec] = &[ORDER_FILTER, p("rule", ParamType::Str, false, "Override invoicing trigger: on_acceptance|after_confirmed_dispatch|after_delivery"), NOW];
const SPEC_10: &[ParamSpec] = &[ORDER_FILTER, p("invoice_id", ParamType::Str, false, "Restrict to one invoice"), NOW];
const SPEC_11: &[ParamSpec] = &[p("invoice_id", ParamType::Str, false, "Restrict to one invoice"), NOW];
const SPEC_12: &[ParamSpec] = &[ORDER_FILTER, CUSTOMER_FILTER, NOW];
const SPEC_13: &[ParamSpec] = &[ORDER_FILTER, NOW];
const SPEC_14: &[ParamSpec] = &[p("invoice_id", ParamType::Str, false, "Restrict to one invoice"), CUSTOMER_FILTER, NOW];
const SPEC_15: &[ParamSpec] = &[CURRENCY_FILTER, CUSTOMER_FILTER, NOW];
const SPEC_16: &[ParamSpec] = &[CURRENCY_FILTER, p("account_ref", ParamType::Str, false, "Restrict to one provider account"), NOW];
const SPEC_17: &[ParamSpec] = &[p("payout_id", ParamType::Str, true, "Payout identifier"), NOW];
const SPEC_18: &[ParamSpec] = &[CURRENCY_FILTER, p("tolerance_minor", ParamType::Int, false, "Amount tolerance for candidate matching"), NOW];
const SPEC_19: &[ParamSpec] = &[CURRENCY_FILTER, p("account_ref", ParamType::Str, false, "Restrict to one provider account"), NOW];
const SPEC_20: &[ParamSpec] = &[ORDER_FILTER, p("return_id", ParamType::Str, false, "Restrict to one return"), NOW];
const SPEC_21: &[ParamSpec] = &[ORDER_FILTER, NOW];
const SPEC_22: &[ParamSpec] = &[p("order_id", ParamType::Str, true, "Cancelled order"), NOW];
const SPEC_23: &[ParamSpec] = &[ORDER_FILTER, p("transaction_id", ParamType::Str, false, "Restrict to one original transaction"), NOW];

pub fn param_specs(intent: &str) -> Option<&'static [ParamSpec]> {
    Some(match intent {
        "inventory.available_to_sell" => SPEC_00,
        "orders.fulfillable" => SPEC_01,
        "orders.reservation_variance" => SPEC_02,
        "orders.inbound_delay_impact" => SPEC_03,
        "shipments.attention" => SPEC_04,
        "shipments.promise_risk" => SPEC_05,
        "orders.partial_delivery_gaps" => SPEC_06,
        "customer.delivery_reply" => SPEC_07,
        "invoices.outstanding" => SPEC_08,
        "orders.missing_invoice" => SPEC_09,
        "invoices.order_amount_variance" => SPEC_10,
        "invoices.dispatch_evidence" => SPEC_11,
        "orders.payment_state" => SPEC_12,
        "payments.recovered_attempts" => SPEC_13,
        "invoices.payment_variance" => SPEC_14,
        "receivables.review_queue" => SPEC_15,
        "providers.money_positions" => SPEC_16,
        "payouts.gross_to_net" => SPEC_17,
        "payouts.missing_bank_confirmation" => SPEC_18,
        "providers.holds_and_releases" => SPEC_19,
        "returns.lifecycle" => SPEC_20,
        "credits.refund_gaps" => SPEC_21,
        "cancellations.outstanding_steps" => SPEC_22,
        "refunds.chargeback_overlap" => SPEC_23,
        _ => return None,
    })
}

pub fn dispatch<'a>(st: &'a TenantState, intent: &str, params: &Params, now: DateTime<Utc>) -> Result<Answer<'a>, QueryError> {
    Ok(match intent {
        "inventory.available_to_sell" => available_to_sell(st, params),
        "orders.fulfillable" => fulfillable(st, params),
        "orders.reservation_variance" => reservation_variance(st, params),
        "orders.inbound_delay_impact" => inbound_delay_impact(st, params),
        "shipments.attention" => shipments_attention(st, params, now),
        "shipments.promise_risk" => promise_risk(st, params, now),
        "orders.partial_delivery_gaps" => partial_delivery_gaps(st, params),
        "customer.delivery_reply" => delivery_reply(st, params, now),
        "invoices.outstanding" => invoices_outstanding(st, params),
        "orders.missing_invoice" => missing_invoice(st, params),
        "invoices.order_amount_variance" => order_amount_variance(st, params),
        "invoices.dispatch_evidence" => dispatch_evidence(st, params),
        "orders.payment_state" => payment_state(st, params),
        "payments.recovered_attempts" => recovered_attempts(st, params),
        "invoices.payment_variance" => payment_variance(st, params),
        "receivables.review_queue" => review_queue(st, params, now),
        "providers.money_positions" => money_positions(st, params),
        "payouts.gross_to_net" => gross_to_net(st, params),
        "payouts.missing_bank_confirmation" => missing_bank_confirmation(st, params),
        "providers.holds_and_releases" => holds_and_releases(st, params, now),
        "returns.lifecycle" => returns_lifecycle(st, params),
        "credits.refund_gaps" => refund_gaps(st, params),
        "cancellations.outstanding_steps" => cancellation_steps(st, params),
        "refunds.chargeback_overlap" => chargeback_overlap(st, params),
        other => return Err(QueryError::UnsupportedIntent(other.to_string())),
    })
}

// ------------------------------------------------------------------ helpers

fn dec(d: Decimal) -> Value {
    Value::String(d.normalize().to_string())
}

fn time_json(ms: i64) -> Value {
    match ms_to_time(ms) {
        Some(t) => Value::String(t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        None => Value::Null,
    }
}

fn sym_str(st: &TenantState, s: Sym) -> Value {
    match st.sym_opt(s) {
        Some(v) => Value::String(v.to_string()),
        None => Value::Null,
    }
}

fn recs<'a>(st: &'a TenantState, kind: Kind) -> impl Iterator<Item = &'a Rec> + 'a {
    st.ids(kind).iter().filter_map(move |id| st.rec(kind, *id))
}

fn lookup<'a>(st: &'a TenantState, kind: Kind, id: Option<&str>) -> Option<&'a Rec> {
    st.rec_by_str(kind, id?)
}

/// The policy record whose slot `slot` is set, latest effective_from first.
fn policy_with(st: &TenantState, slot: usize) -> Option<&Rec> {
    recs(st, Kind::Policy)
        .filter(|r| r.status == POL_ST_ACTIVE && r.s[slot] != NONE)
        .max_by_key(|r| (r.t[POL_T_EFFECTIVE_FROM], r.last_seq))
}

fn policy_with_m(st: &TenantState, slot: usize) -> Option<&Rec> {
    recs(st, Kind::Policy)
        .filter(|r| r.status == POL_ST_ACTIVE && r.m[slot] != 0)
        .max_by_key(|r| (r.t[POL_T_EFFECTIVE_FROM], r.last_seq))
}

/// Coverage assertion for a capability (e.g. "invoices"): Some(true) complete, Some(false)
/// incomplete/gap, None when no coverage assertion exists.
fn coverage_complete(st: &TenantState, capability: &str) -> Option<bool> {
    let mut found = None;
    for r in recs(st, Kind::Coverage) {
        if st.sym(r.s[COV_S_CAPABILITY]) == capability {
            let ok = r.status == COV_ST_COMPLETE;
            found = Some(found.unwrap_or(true) && ok);
        }
    }
    found
}

fn order_lines<'a>(st: &'a TenantState, o: &Rec) -> Vec<&'a Rec> {
    o.linked(Kind::Line).filter_map(|l| st.rec(Kind::Line, l)).collect()
}

fn line_remaining(l: &Rec) -> Decimal {
    (l.q[LINE_Q_QUANTITY] - l.q[LINE_Q_CANCELLED] - l.q[LINE_Q_DISPATCHED]).max(Decimal::ZERO)
}

fn order_open(o: &Rec) -> bool {
    o.status == ORDER_ST_ACCEPTED || o.status == ORDER_ST_PARTIALLY_CANCELLED
}

/// Active reservation quantity owned by a line (or by the order when line-less).
fn active_reserved_for(st: &TenantState, order: &Rec, line: Option<&Rec>) -> (Decimal, Vec<RecKey>) {
    let mut total = Decimal::ZERO;
    let mut keys = Vec::new();
    let line_sym = line.map(|l| l.id).unwrap_or(NONE);
    for rid in order.linked(Kind::Reservation) {
        if let Some(r) = st.rec(Kind::Reservation, rid) {
            if r.status != RES_ST_ACTIVE && r.status != RES_ST_ACTIVE_COVERED {
                continue;
            }
            let owned = if line_sym != NONE {
                r.s[RES_S_LINE] == line_sym || (r.s[RES_S_LINE] == NONE && order.linked(Kind::Line).count() == 1)
            } else {
                true
            };
            if owned {
                total += r.q[RES_Q_QUANTITY] - r.q[RES_Q_RELEASED];
                keys.push(RecKey::new(Kind::Reservation, rid));
            }
        }
    }
    (total, keys)
}

fn order_shipments<'a>(st: &'a TenantState, o: &Rec) -> Vec<&'a Rec> {
    o.linked(Kind::Shipment).filter_map(|s| st.rec(Kind::Shipment, s)).collect()
}

fn order_transactions<'a>(st: &'a TenantState, o: &Rec) -> Vec<&'a Rec> {
    o.linked(Kind::Transaction).filter_map(|t| st.rec(Kind::Transaction, t)).collect()
}

fn order_invoices<'a>(st: &'a TenantState, o: &Rec) -> Vec<&'a Rec> {
    o.linked(Kind::Invoice).filter_map(|i| st.rec(Kind::Invoice, i)).collect()
}

fn invoice_open(inv: &Rec) -> i64 {
    inv.m[INV_M_GROSS] - inv.m[INV_M_CREDIT] - inv.m[INV_M_REPORTED_PAID]
}

fn filter_order<'a>(st: &'a TenantState, params: &Params) -> Option<Vec<&'a Rec>> {
    match params.str("order_id") {
        Some(id) => st.rec_by_str(Kind::Order, id).map(|o| vec![o]),
        None => Some(recs(st, Kind::Order).collect()),
    }
}

// ------------------------------------------------------------------ order-01

fn available_to_sell<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "inventory.available_to_sell", &["stock", "allocations", "supply", "coverage", "identity"]);
    let item_id = params.str("item_id").unwrap_or("");
    let requested = params.decimal("requested_quantity");
    a.set("item_id", json!(item_id));
    a.set("requested_quantity", requested.map(dec).unwrap_or(Value::Null));
    a.set("incoming_counted_as_stock", json!(false));
    let Some(item) = st.rec_by_str(Kind::Item, item_id) else {
        a.set("available", Value::Null);
        a.missing("stock.basis");
        a.downgrade(Status::Unknown);
        a.step("basis", "no stock observation for this item", json!({"item_id": item_id}));
        return a;
    };
    a.touch(RecKey::new(Kind::Item, item.id));
    if let Some(loc) = params.str("location_id") {
        if st.sym_opt(item.s[ITEM_S_LOCATION]).map(|l| l != loc).unwrap_or(true) {
            a.set("available", Value::Null);
            a.missing("stock.location_scope");
            a.downgrade(Status::Unknown);
            return a;
        }
    }
    // Incoming supply is reported separately and never fills current stock.
    let supply: Vec<Value> = recs(st, Kind::Supply)
        .filter(|s| s.s[SUP_S_ITEM] == item.id && s.status == SUP_ST_ACTIVE)
        .map(|s| {
            a.touch(RecKey::new(Kind::Supply, s.id));
            json!({"promise_id": st.sym(s.id), "quantity": dec(s.q[SUP_Q_QUANTITY]), "promised_at": time_json(s.t[SUP_T_PROMISED_AT])})
        })
        .collect();
    let Some(available) = item_available(item) else {
        a.set("available", Value::Null);
        a.set("incoming_supply", Value::Array(supply));
        a.missing("stock.basis");
        a.downgrade(Status::Unknown);
        a.step("basis", "reservations are known but no physical/available basis was observed", json!({"reserved": dec(item_reserved(item))}));
        return a;
    };
    let provider_basis = item.status == ITEM_ST_BASIS_WITH_PROVIDER_AVAILABLE;
    a.set("unit", sym_str(st, item.s[ITEM_S_UNIT]));
    a.set("basis_at", time_json(item.t[ITEM_T_BASIS_AT]));
    a.set("basis", json!(if provider_basis { "provider_available" } else { "derived_from_disjoint_states" }));
    a.set("physical", dec(item.q[ITEM_Q_PHYSICAL]));
    a.set("quarantined", dec(item.q[ITEM_Q_QUARANTINED]));
    a.set("reserved", dec(item_reserved(item)));
    a.set("committed", dec(item.q[ITEM_Q_COMMITTED]));
    a.set("available", dec(available));
    a.set("incoming_supply", Value::Array(supply));
    if !st.dataset_present("supply") {
        a.coverage_extra.insert("incoming_supply_known".into(), json!(false));
    }
    if provider_basis {
        a.step(
            "available",
            "available = provider_available − active reservations recorded after the snapshot basis",
            json!({"provider_available": dec(item.q[ITEM_Q_PROVIDER_AVAILABLE]), "reservations_after_basis": dec(item.q[ITEM_Q_RESERVED_ACTIVE]), "available": dec(available), "committed_not_subtracted_again": dec(item.q[ITEM_Q_COMMITTED])}),
        );
    } else {
        a.step(
            "available",
            "available = physical − quarantined − committed − damaged − safety_stock − quality_control − snapshot_reserved − active reservations after basis",
            json!({"physical": dec(item.q[ITEM_Q_PHYSICAL]), "quarantined": dec(item.q[ITEM_Q_QUARANTINED]), "committed": dec(item.q[ITEM_Q_COMMITTED]), "damaged": dec(item.q[ITEM_Q_DAMAGED]), "safety_stock": dec(item.q[ITEM_Q_SAFETY]), "quality_control": dec(item.q[ITEM_Q_QUALITY_CONTROL]), "snapshot_reserved": dec(item.q[ITEM_Q_SNAPSHOT_RESERVED]), "reservations_after_basis": dec(item.q[ITEM_Q_RESERVED_ACTIVE]), "available": dec(available)}),
        );
    }
    if let Some(req) = requested {
        let shortfall = (req - available).max(Decimal::ZERO);
        a.set("shortfall", dec(shortfall));
        a.set("can_fulfill", json!(shortfall.is_zero()));
        a.step("shortfall", "shortfall = max(0, requested − available)", json!({"requested": dec(req), "available": dec(available), "shortfall": dec(shortfall)}));
    }
    a
}

// ------------------------------------------------------------------ order-02

fn fulfillable<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "orders.fulfillable", &["orders", "stock", "allocations", "policy", "coverage", "identity"]);
    a.items_key = "orders";
    let explicit = params.list("priority");
    let method: Option<String> = if !explicit.is_empty() {
        Some("explicit_list".into())
    } else {
        policy_with(st, POL_S_PRIORITY_METHOD).map(|p| st.sym(p.s[POL_S_PRIORITY_METHOD]).to_string())
    };
    let Some(method) = method else {
        a.set("joint_plan", Value::Null);
        a.missing("policy.priority_method");
        a.downgrade(Status::Unknown);
        a.step("priority", "no declared merchant priority policy; no plan can be built", json!({}));
        return a;
    };
    if let Some(p) = policy_with(st, POL_S_PRIORITY_METHOD) {
        a.touch(RecKey::new(Kind::Policy, p.id));
    }
    a.set("priority_method", json!(method));
    let item_filter = params.str("item_id").and_then(|i| st.interner.get(i));
    let mut orders: Vec<&Rec> = recs(st, Kind::Order)
        .filter(|o| order_open(o))
        .filter(|o| order_lines(st, o).iter().any(|l| line_remaining(l) > Decimal::ZERO))
        .filter(|o| item_filter.map(|i| o.has_link(Kind::Item, i)).unwrap_or(true))
        .collect();
    match method.as_str() {
        "explicit_list" => {
            let rank: HashMap<&str, usize> = explicit.iter().enumerate().map(|(i, s)| (s.as_str(), i)).collect();
            orders.retain(|o| rank.contains_key(st.sym(o.id)));
            orders.sort_by_key(|o| rank[st.sym(o.id)]);
        }
        "promise_date" | "promised_at" => {
            orders.sort_by_key(|o| {
                let due = o
                    .linked(Kind::Promise)
                    .filter_map(|p| st.rec(Kind::Promise, p))
                    .filter(|p| p.status == PROM_ST_ACTIVE)
                    .map(|p| p.t[PROM_T_PROMISED_AT])
                    .min()
                    .unwrap_or(i64::MAX);
                (due, o.t[ORDER_T_ACCEPTED_AT], o.id)
            });
        }
        _ => orders.sort_by_key(|o| (o.t[ORDER_T_ACCEPTED_AT], o.created_seq, o.id)),
    }
    // Free stock per item at the fixed snapshot.
    let mut free: HashMap<Sym, Decimal> = HashMap::new();
    let mut no_basis: HashSet<Sym> = HashSet::new();
    let mut units_used = Decimal::ZERO;
    for o in &orders {
        a.touch(RecKey::new(Kind::Order, o.id));
        let mut classification = "fully_fulfillable";
        let mut reasons: Vec<String> = Vec::new();
        let mut lines_out = Vec::new();
        let mut any_alloc = false;
        for l in order_lines(st, o) {
            let remaining = line_remaining(l);
            if remaining.is_zero() {
                continue;
            }
            let item = l.s[LINE_S_ITEM];
            let (own_reserved, res_keys) = active_reserved_for(st, o, Some(l));
            for k in res_keys {
                a.touch(k);
            }
            let need = (remaining - own_reserved).max(Decimal::ZERO);
            let item_rec = st.rec(Kind::Item, item);
            if item_rec.is_none() || item_available(item_rec.unwrap()).is_none() {
                no_basis.insert(item);
                classification = "blocked";
                reasons.push(format!("stock_basis_missing:{}", st.sym(item)));
                lines_out.push(json!({"line_id": st.sym(l.id), "item_id": st.sym(item), "remaining": dec(remaining), "own_reservation": dec(own_reserved), "allocated": Value::Null}));
                continue;
            }
            a.touch(RecKey::new(Kind::Item, item));
            let f = free.entry(item).or_insert_with(|| item_available(item_rec.unwrap()).unwrap().max(Decimal::ZERO));
            let alloc = need.min(*f);
            *f -= alloc;
            units_used += alloc;
            if alloc > Decimal::ZERO {
                any_alloc = true;
            }
            if alloc < need {
                classification = if alloc.is_zero() && own_reserved.is_zero() { "blocked" } else { "partial" };
                reasons.push(format!("insufficient_free_stock:{}", st.sym(item)));
            }
            lines_out.push(json!({"line_id": st.sym(l.id), "item_id": st.sym(item), "remaining": dec(remaining), "own_reservation": dec(own_reserved), "need": dec(need), "allocated": dec(alloc), "covered": dec(own_reserved + alloc)}));
        }
        let _ = any_alloc;
        a.items.push(json!({"order_id": st.sym(o.id), "classification": classification, "reasons": reasons, "lines": lines_out, "tentative": true}));
    }
    if !no_basis.is_empty() {
        a.missing("stock.basis");
        a.downgrade(Status::Partial);
    }
    a.set("units_used", dec(units_used));
    a.set("plan_is_tentative", json!(true));
    a.step("plan", "allocate free stock once across orders in declared priority; own reservations are not unavailable to their own order", json!({"orders_considered": orders.len(), "units_used": dec(units_used)}));
    a
}

// ------------------------------------------------------------------ order-03

fn reservation_variance<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "orders.reservation_variance", &["orders", "allocations", "fulfillments", "coverage", "identity"]);
    a.items_key = "lines";
    if !a.require_dataset("allocations", "allocations.order_line_ownership") {
        a.set("variance", Value::Null);
        return a;
    }
    let Some(orders) = filter_order(st, params) else {
        a.set("variance", Value::Null);
        a.missing("orders.order_id");
        a.downgrade(Status::Unknown);
        return a;
    };
    let mut mismatched = 0;
    for o in orders.iter().filter(|o| order_open(o)) {
        for l in order_lines(st, o) {
            let remaining = (l.q[LINE_Q_QUANTITY] - l.q[LINE_Q_CANCELLED] - l.q[LINE_Q_DISPATCHED]).max(Decimal::ZERO);
            let (reserved, keys) = active_reserved_for(st, o, Some(l));
            let variance = reserved - remaining;
            if variance.is_zero() {
                continue;
            }
            a.touch(RecKey::new(Kind::Order, o.id));
            a.touch(RecKey::new(Kind::Line, l.id));
            for k in keys {
                a.touch(k);
            }
            mismatched += 1;
            a.items.push(json!({
                "order_id": st.sym(o.id), "line_id": st.sym(l.id), "item_id": sym_str(st, l.s[LINE_S_ITEM]),
                "original_quantity": dec(l.q[LINE_Q_QUANTITY]), "cancelled_quantity": dec(l.q[LINE_Q_CANCELLED]), "dispatched_quantity": dec(l.q[LINE_Q_DISPATCHED]),
                "remaining_obligation": dec(remaining), "active_reserved": dec(reserved),
                "under_reserved": dec((-variance).max(Decimal::ZERO)), "over_reserved": dec(variance.max(Decimal::ZERO)),
            }));
        }
    }
    a.set("mismatched_lines", json!(mismatched));
    a.step("variance", "remaining_obligation = quantity − cancelled − dispatched; variance = active_reserved − remaining_obligation", json!({"mismatched_lines": mismatched}));
    a
}

// ------------------------------------------------------------------ order-04

fn inbound_delay_impact<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "orders.inbound_delay_impact", &["orders", "supply", "allocations", "promises", "coverage", "identity"]);
    a.items_key = "commitments";
    if !a.require_dataset("supply", "supply") {
        a.set("confirmed_affected_orders", Value::Null);
        return a;
    }
    let include_all = params.bool("include_undelayed").unwrap_or(false);
    let filter = params.str("promise_id").and_then(|p| st.interner.get(p));
    let mut affected_all: Vec<String> = Vec::new();
    let mut unresolved = 0;
    for s in recs(st, Kind::Supply) {
        if filter.map(|f| f != s.id).unwrap_or(false) {
            continue;
        }
        if s.status != SUP_ST_ACTIVE {
            continue;
        }
        let delayed = s.t[SUP_T_PREVIOUS_PROMISED_AT] != 0 && s.t[SUP_T_PROMISED_AT] > s.t[SUP_T_PREVIOUS_PROMISED_AT];
        if !delayed && !include_all {
            continue;
        }
        a.touch(RecKey::new(Kind::Supply, s.id));
        let allocated: Vec<Sym> = s.linked(Kind::Order).collect();
        let mut affected = Vec::new();
        if allocated.is_empty() {
            unresolved += 1;
            a.missing("allocations.supply_to_order");
            a.downgrade(Status::Partial);
        }
        for o in &allocated {
            let Some(order) = st.rec(Kind::Order, *o) else { continue };
            a.touch(RecKey::new(Kind::Order, *o));
            let due = order
                .linked(Kind::Promise)
                .filter_map(|p| st.rec(Kind::Promise, p))
                .filter(|p| p.status == PROM_ST_ACTIVE)
                .map(|p| p.t[PROM_T_PROMISED_AT])
                .min();
            let risk = match due {
                Some(d) if s.t[SUP_T_PROMISED_AT] > d => "incoming_after_customer_deadline",
                Some(_) => "within_customer_deadline",
                None => "customer_deadline_unknown",
            };
            if due.is_none() {
                a.missing("promises.promised_at");
                a.downgrade(Status::Partial);
            }
            affected.push(json!({"order_id": st.sym(*o), "customer_due": due.map(time_json).unwrap_or(Value::Null), "risk": risk}));
            affected_all.push(st.sym(*o).to_string());
        }
        // Potential exposure: open orders of the same item without an allocation link.
        let exposure: Vec<Value> = recs(st, Kind::Order)
            .filter(|o| order_open(o) && o.has_link(Kind::Item, s.s[SUP_S_ITEM]) && !allocated.contains(&o.id))
            .map(|o| json!({"order_id": st.sym(o.id), "relationship": "potential_exposure_shared_item"}))
            .collect();
        a.items.push(json!({
            "promise_id": st.sym(s.id), "item_id": sym_str(st, s.s[SUP_S_ITEM]), "quantity": dec(s.q[SUP_Q_QUANTITY]),
            "previous_promised_at": time_json(s.t[SUP_T_PREVIOUS_PROMISED_AT]), "promised_at": time_json(s.t[SUP_T_PROMISED_AT]),
            "delayed": delayed, "affected": affected, "potential_exposure": exposure,
        }));
    }
    affected_all.sort();
    affected_all.dedup();
    a.set("confirmed_affected_orders", if unresolved > 0 && affected_all.is_empty() { Value::Null } else { json!(affected_all) });
    a.set("unresolved_commitments", json!(unresolved));
    a.step("impact", "follow revised supply promise through explicit allocation links to orders; compare with customer deadline", json!({"commitments": a.items.len(), "unresolved": unresolved}));
    a
}

// ------------------------------------------------------------------ delivery-01

fn shipments_attention<'a>(st: &'a TenantState, params: &Params, now: DateTime<Utc>) -> Answer<'a> {
    let mut a = Answer::new(st, "shipments.attention", &["fulfillments", "tracking", "policy", "coverage", "identity"]);
    a.items_key = "shipments";
    a.effective_at = Some(now);
    if !a.require_dataset("tracking", "tracking.coverage") {
        a.set("delivery_status", json!("unknown"));
        a.set("attention", Value::Null);
        return a;
    }
    let stale_secs = params
        .int("stale_after_seconds")
        .or_else(|| policy_with_m(st, POL_M_STALE_SCAN_SECONDS).map(|p| p.m[POL_M_STALE_SCAN_SECONDS]));
    let rule = policy_with(st, POL_S_ATTENTION_RULE).map(|p| st.sym(p.s[POL_S_ATTENTION_RULE]).to_string());
    if let Some(p) = policy_with(st, POL_S_ATTENTION_RULE).or_else(|| policy_with_m(st, POL_M_STALE_SCAN_SECONDS)) {
        a.touch(RecKey::new(Kind::Policy, p.id));
    }
    if rule.is_none() && stale_secs.is_none() {
        a.missing("policy.attention_rule");
        a.downgrade(Status::Partial);
    }
    let order_filter = params.str("order_id").and_then(|o| st.interner.get(o));
    let now_ms = time_to_ms(now);
    let mut attention = Vec::new();
    for s in recs(st, Kind::Shipment) {
        if order_filter.map(|o| s.s[SHIP_S_ORDER] != o).unwrap_or(false) {
            continue;
        }
        if s.status == SHIP_ST_DELIVERED || s.status == SHIP_ST_CANCELLED {
            continue;
        }
        a.touch(RecKey::new(Kind::Shipment, s.id));
        let last = if s.t[SHIP_T_LAST_SCAN_AT] != 0 { s.t[SHIP_T_LAST_SCAN_AT] } else { s.t[SHIP_T_HANDOVER_AT] };
        let age = if last != 0 { Some((now_ms - last) / 1000) } else { None };
        let mut reasons = Vec::new();
        if s.status == SHIP_ST_EXCEPTION {
            reasons.push("carrier_exception");
        }
        if let (Some(th), Some(ag)) = (stale_secs, age) {
            if ag > th {
                reasons.push("stale_scan");
            }
        }
        if s.t[SHIP_T_FORECAST_AT] != 0 && s.t[SHIP_T_FORECAST_AT] < now_ms {
            reasons.push("forecast_passed");
        }
        if s.status == SHIP_ST_OBSERVED {
            reasons.push("label_only_no_handover");
        }
        let needs = !reasons.is_empty();
        if needs {
            attention.push(st.sym(s.id).to_string());
        }
        a.items.push(json!({
            "shipment_id": st.sym(s.id), "order_id": sym_str(st, s.s[SHIP_S_ORDER]), "status": ship_status_str(s.status),
            "carrier": sym_str(st, s.s[SHIP_S_CARRIER]), "tracking_number": sym_str(st, s.s[SHIP_S_TRACKING]),
            "last_scan_code": sym_str(st, s.s[SHIP_S_LAST_SCAN_CODE]), "last_scan_at": time_json(s.t[SHIP_T_LAST_SCAN_AT]),
            "latest_scan_age_seconds": age, "forecast_at": time_json(s.t[SHIP_T_FORECAST_AT]), "forecast_is_promise": false,
            "needs_attention": needs, "reasons": reasons,
        }));
    }
    a.set("attention", json!(attention));
    a.set("stale_after_seconds", json!(stale_secs));
    a.set("attention_rule", json!(rule));
    a.step("attention", "attention = carrier exception OR scan age > stale threshold OR forecast passed OR label without handover", json!({"shipments": a.items.len(), "attention": attention.len()}));
    a
}

// ------------------------------------------------------------------ delivery-02

fn promise_risk<'a>(st: &'a TenantState, params: &Params, now: DateTime<Utc>) -> Answer<'a> {
    let mut a = Answer::new(st, "shipments.promise_risk", &["orders", "promises", "fulfillments", "tracking", "policy", "coverage", "identity"]);
    a.items_key = "commitments";
    a.effective_at = Some(now);
    if !a.require_dataset("promises", "promises.promised_at") {
        a.set("promise_breached", Value::Null);
        return a;
    }
    let risk_hours = params.int("risk_hours").or_else(|| policy_with_m(st, POL_M_RISK_HOURS).map(|p| p.m[POL_M_RISK_HOURS]));
    if risk_hours.is_none() {
        a.missing("policy.risk_rule");
        a.downgrade(Status::Partial);
    }
    if coverage_complete(st, "tracking") == Some(false) {
        a.missing("tracking.coverage_complete");
        a.downgrade(Status::Partial);
    }
    let order_filter = params.str("order_id").and_then(|o| st.interner.get(o));
    let now_ms = time_to_ms(now);
    let mut overdue = 0;
    let mut at_risk = 0;
    for p in recs(st, Kind::Promise) {
        if p.status != PROM_ST_ACTIVE || p.t[PROM_T_PROMISED_AT] == 0 {
            continue;
        }
        if order_filter.map(|o| p.s[PROM_S_ORDER] != o).unwrap_or(false) {
            continue;
        }
        a.touch(RecKey::new(Kind::Promise, p.id));
        let order = st.rec(Kind::Order, p.s[PROM_S_ORDER]);
        let ships: Vec<&Rec> = order.map(|o| order_shipments(st, o)).unwrap_or_default();
        for s in &ships {
            a.touch(RecKey::new(Kind::Shipment, s.id));
        }
        if let Some(o) = order {
            a.touch(RecKey::new(Kind::Order, o.id));
        }
        let delivered = ships.iter().any(|s| s.status == SHIP_ST_DELIVERED);
        let delivered_at = ships.iter().map(|s| s.t[SHIP_T_DELIVERED_AT]).max().unwrap_or(0);
        let last_state = ships.iter().max_by_key(|s| s.last_seq).map(|s| ship_status_str(s.status)).unwrap_or("no_shipment");
        let forecast = ships.iter().map(|s| s.t[SHIP_T_FORECAST_AT]).max().unwrap_or(0);
        let promised = p.t[PROM_T_PROMISED_AT];
        let is_overdue = !delivered && promised < now_ms;
        let met_late = delivered && delivered_at > promised;
        let mut risk = if is_overdue {
            "overdue"
        } else if delivered {
            if met_late { "delivered_late" } else { "met" }
        } else {
            "on_track"
        };
        if !delivered && !is_overdue {
            if forecast != 0 && forecast > promised {
                risk = "at_risk_forecast_after_promise";
            } else if let Some(h) = risk_hours {
                if promised - now_ms < h * 3_600_000 && last_state != "in_transit" {
                    risk = "at_risk_window";
                }
            }
        }
        if is_overdue {
            overdue += 1;
        } else if risk.starts_with("at_risk") {
            at_risk += 1;
        }
        a.items.push(json!({
            "promise_id": st.sym(p.id), "order_id": sym_str(st, p.s[PROM_S_ORDER]), "promised_at": time_json(promised), "timezone": sym_str(st, p.s[PROM_S_TIMEZONE]),
            "last_state": last_state, "delivered": delivered, "delivered_at": time_json(delivered_at),
            "arrival_date": if delivered { time_json(delivered_at) } else if forecast != 0 { time_json(forecast) } else { json!("unknown") },
            "forecast_is_promise": false, "overdue": is_overdue, "risk": risk,
        }));
    }
    a.set("overdue_count", json!(overdue));
    a.set("at_risk_count", json!(at_risk));
    a.step("risk", "overdue = not delivered AND promised_at < now; at risk = forecast after promise or inside the configured window", json!({"overdue": overdue, "at_risk": at_risk, "risk_hours": risk_hours}));
    a
}

// ------------------------------------------------------------------ delivery-03

fn partial_delivery_gaps<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "orders.partial_delivery_gaps", &["orders", "fulfillments", "tracking", "coverage", "identity"]);
    a.items_key = "orders";
    if !a.require_dataset("fulfillments", "fulfillments.line_quantity_links") {
        a.set("remaining_quantities", Value::Null);
        return a;
    }
    let Some(orders) = filter_order(st, params) else {
        a.set("remaining_quantities", Value::Null);
        a.missing("orders.order_id");
        a.downgrade(Status::Unknown);
        return a;
    };
    for o in orders {
        let ships = order_shipments(st, o);
        if ships.is_empty() {
            continue;
        }
        let mut lines_out = Vec::new();
        let mut gap = false;
        for l in order_lines(st, o) {
            let net = l.q[LINE_Q_QUANTITY] - l.q[LINE_Q_CANCELLED];
            let to_dispatch = (net - l.q[LINE_Q_DISPATCHED]).max(Decimal::ZERO);
            let to_deliver = (net - l.q[LINE_Q_DELIVERED]).max(Decimal::ZERO);
            if to_dispatch > Decimal::ZERO || to_deliver > Decimal::ZERO {
                gap = true;
            }
            lines_out.push(json!({"line_id": st.sym(l.id), "item_id": sym_str(st, l.s[LINE_S_ITEM]), "ordered": dec(l.q[LINE_Q_QUANTITY]), "cancelled": dec(l.q[LINE_Q_CANCELLED]), "handed_over": dec(l.q[LINE_Q_DISPATCHED]), "delivered": dec(l.q[LINE_Q_DELIVERED]), "remaining_to_dispatch": dec(to_dispatch), "remaining_to_deliver": dec(to_deliver)}));
        }
        if !gap {
            continue;
        }
        a.touch(RecKey::new(Kind::Order, o.id));
        for s in &ships {
            a.touch(RecKey::new(Kind::Shipment, s.id));
        }
        let label_only = ships.iter().filter(|s| s.status == SHIP_ST_OBSERVED).count();
        a.items.push(json!({"order_id": st.sym(o.id), "shipments": ships.len(), "label_only_shipments": label_only, "lines": lines_out}));
    }
    a.step("gaps", "remaining_to_dispatch = ordered − cancelled − handed_over; remaining_to_deliver = ordered − cancelled − delivered (labels count as neither)", json!({"orders_with_gaps": a.items.len()}));
    a
}

// ------------------------------------------------------------------ delivery-04

fn delivery_reply<'a>(st: &'a TenantState, params: &Params, now: DateTime<Utc>) -> Answer<'a> {
    let mut a = Answer::new(st, "customer.delivery_reply", &["orders", "fulfillments", "tracking", "communications", "promises", "coverage", "identity"]);
    a.effective_at = Some(now);
    a.set("send_action", json!(false));
    let order = lookup(st, Kind::Order, params.str("order_id"));
    let customer = params.str("customer_id").and_then(|c| st.rec_by_str(Kind::Customer, c));
    let orders: Vec<&Rec> = match (order, customer) {
        (Some(o), _) => vec![o],
        (None, Some(c)) => c.linked(Kind::Order).filter_map(|o| st.rec(Kind::Order, o)).collect(),
        _ => Vec::new(),
    };
    if orders.is_empty() {
        a.set("facts", Value::Null);
        a.missing("orders.order_id");
        a.downgrade(Status::Unknown);
        return a;
    }
    if let (Some(o), Some(c)) = (order, customer) {
        if o.s[ORDER_S_CUSTOMER] != c.id {
            a.set("facts", Value::Null);
            a.missing("identity.customer_order_link");
            a.downgrade(Status::Unknown);
            a.step("authorization", "order does not belong to the given customer", json!({}));
            return a;
        }
    }
    let mut facts = Vec::new();
    let mut shipments_out = Vec::new();
    for o in &orders {
        a.touch(RecKey::new(Kind::Order, o.id));
        for s in order_shipments(st, o) {
            a.touch(RecKey::new(Kind::Shipment, s.id));
            let status = ship_status_str(s.status);
            facts.push(status.to_string());
            if s.status != SHIP_ST_DELIVERED {
                facts.push(if s.t[SHIP_T_FORECAST_AT] != 0 { "forecast_known".to_string() } else { "arrival_unknown".to_string() });
            }
            shipments_out.push(json!({"shipment_id": st.sym(s.id), "status": status, "carrier": sym_str(st, s.s[SHIP_S_CARRIER]), "tracking_number": sym_str(st, s.s[SHIP_S_TRACKING]), "last_scan_at": time_json(s.t[SHIP_T_LAST_SCAN_AT]), "forecast_at": time_json(s.t[SHIP_T_FORECAST_AT]), "delivered_at": time_json(s.t[SHIP_T_DELIVERED_AT])}));
        }
        if order_shipments(st, o).is_empty() {
            facts.push("not_yet_shipped".into());
        }
    }
    facts.sort();
    facts.dedup();
    let promises: Vec<Value> = orders
        .iter()
        .flat_map(|o| o.linked(Kind::Promise))
        .filter_map(|p| st.rec(Kind::Promise, p))
        .map(|p| {
            a.touch(RecKey::new(Kind::Promise, p.id));
            json!({"promise_id": st.sym(p.id), "promised_at": time_json(p.t[PROM_T_PROMISED_AT]), "kind": sym_str(st, p.s[PROM_S_KIND]), "active": p.status == PROM_ST_ACTIVE})
        })
        .collect();
    let comms: Vec<Value> = orders
        .iter()
        .flat_map(|o| o.linked(Kind::Communication))
        .filter_map(|m| st.rec(Kind::Communication, m))
        .map(|m| {
            a.touch(RecKey::new(Kind::Communication, m.id));
            json!({"message_id": st.sym(m.id), "sent_at": time_json(m.t[COM_T_SENT_AT]), "actor": sym_str(st, m.s[COM_S_ACTOR]), "reviewed": m.status == COM_ST_REVIEWED, "summary": sym_str(st, m.s[COM_S_SUMMARY])})
        })
        .collect();
    let comm_known = st.dataset_present("communications");
    a.set("facts", json!(facts));
    a.set("shipments", json!(shipments_out));
    a.set("known_promises", json!(promises));
    a.set("prior_communications", json!(comms));
    a.set("prior_promises_checked", json!(comm_known));
    a.set("omitted_context", json!(if comm_known { Vec::<&str>::new() } else { vec!["prior_communication"] }));
    if !comm_known {
        a.missing("communications");
        a.downgrade(Status::Partial);
    }
    if !st.dataset_present("tracking") {
        a.missing("tracking");
        a.downgrade(Status::Partial);
    }
    a.step("reply_facts", "structured evidenced facts only; no promise or apology is invented; sending is never automatic", json!({"facts": facts.len(), "communications_known": comm_known}));
    a
}

// ------------------------------------------------------------------ invoice-01

fn invoices_outstanding<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "invoices.outstanding", &["invoices", "payment_allocations", "coverage", "identity"]);
    a.items_key = "invoices";
    if !a.require_dataset("invoices", "invoices.correction_chain_coverage") {
        a.set("open_minor", Value::Null);
        return a;
    }
    if coverage_complete(st, "invoices") == Some(false) {
        a.missing("invoices.correction_chain_coverage");
        a.downgrade(Status::Partial);
    }
    let cust = params.str("customer_id").and_then(|c| st.interner.get(c));
    let cur = params.str("currency").map(|c| c.to_uppercase()).and_then(|c| st.interner.get(&c));
    let due_before = params.time("due_before").map(time_to_ms);
    let has_alloc = st.dataset_present("payment_allocations");
    let mut totals: BTreeMap<String, i64> = BTreeMap::new();
    let mut credit_totals: BTreeMap<String, i64> = BTreeMap::new();
    for inv in recs(st, Kind::Invoice) {
        if inv.status != INV_ST_ISSUED {
            continue;
        }
        if cust.map(|c| inv.s[INV_S_CUSTOMER] != c).unwrap_or(false) || cur.map(|c| inv.s[INV_S_CURRENCY] != c).unwrap_or(false) {
            continue;
        }
        if let Some(d) = due_before {
            if inv.t[INV_T_DUE_DATE] == 0 || inv.t[INV_T_DUE_DATE] >= d {
                continue;
            }
        }
        let open = invoice_open(inv);
        if open == 0 {
            continue;
        }
        a.touch(RecKey::new(Kind::Invoice, inv.id));
        let c = st.sym(inv.s[INV_S_CURRENCY]).to_string();
        if open > 0 {
            *totals.entry(c.clone()).or_insert(0) += open;
        } else {
            *credit_totals.entry(c.clone()).or_insert(0) += -open;
        }
        let reconciled = if has_alloc { json!(inv.m[INV_M_GROSS] - inv.m[INV_M_CREDIT] - inv.m[INV_M_ALLOCATED]) } else { Value::Null };
        a.items.push(json!({
            "invoice_id": st.sym(inv.id), "order_id": sym_str(st, inv.s[INV_S_ORDER]), "customer_id": sym_str(st, inv.s[INV_S_CUSTOMER]), "currency": c,
            "gross_minor": inv.m[INV_M_GROSS], "credits_minor": inv.m[INV_M_CREDIT], "reported_payments_minor": inv.m[INV_M_REPORTED_PAID],
            "reported_open_minor": open.max(0), "credit_balance_minor": (-open).max(0), "reconciled_open_minor": reconciled,
            "new_cash_from_marker": 0, "due_date": time_json(inv.t[INV_T_DUE_DATE]),
        }));
    }
    a.set("totals_open_by_currency", json!(totals));
    a.set("totals_credit_balance_by_currency", json!(credit_totals));
    a.step("open", "reported_open = gross − credits − reported payment markers (markers are not cash; negative = credit/overpayment, not negative debt)", json!({"invoices": a.items.len()}));
    a
}

// ------------------------------------------------------------------ invoice-02

fn missing_invoice<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "orders.missing_invoice", &["orders", "fulfillments", "invoices", "policy", "coverage", "identity"]);
    a.items_key = "orders";
    let rule = params
        .str("rule")
        .map(|s| s.to_string())
        .or_else(|| policy_with(st, POL_S_INVOICING_TRIGGER).map(|p| st.sym(p.s[POL_S_INVOICING_TRIGGER]).to_string()));
    let Some(rule) = rule else {
        a.set("missing_invoice", Value::Null);
        a.missing("policy.invoicing_trigger");
        a.downgrade(Status::Unknown);
        return a;
    };
    if let Some(p) = policy_with(st, POL_S_INVOICING_TRIGGER) {
        a.touch(RecKey::new(Kind::Policy, p.id));
    }
    let import_complete = coverage_complete(st, "invoices");
    if import_complete != Some(true) {
        a.set("missing_invoice", Value::Null);
        a.set("rule", json!(rule));
        a.missing("coverage.invoices_backfill_complete");
        a.downgrade(Status::Unknown);
        a.step("population", "absence means missing only when invoice import coverage is complete", json!({"invoice_import_complete": import_complete}));
        return a;
    }
    let Some(orders) = filter_order(st, params) else {
        a.set("missing_invoice", Value::Null);
        a.missing("orders.order_id");
        a.downgrade(Status::Unknown);
        return a;
    };
    let mut missing = Vec::new();
    for o in orders.iter().filter(|o| order_open(o)) {
        let eligible = match rule.as_str() {
            "on_acceptance" => o.status == ORDER_ST_ACCEPTED || o.status == ORDER_ST_PARTIALLY_CANCELLED,
            "after_delivery" => o.q[ORDER_Q_DELIVERED] > Decimal::ZERO,
            _ => o.q[ORDER_Q_DISPATCHED] > Decimal::ZERO || order_shipments(st, o).iter().any(|s| s.status >= SHIP_ST_DISPATCHED && s.status != SHIP_ST_CANCELLED),
        };
        if !eligible {
            continue;
        }
        let valid: Vec<&Rec> = order_invoices(st, o).into_iter().filter(|i| i.status == INV_ST_ISSUED).collect();
        let invoiced_gross: i64 = valid.iter().map(|i| i.m[INV_M_GROSS]).sum();
        let partial = !valid.is_empty() && invoiced_gross < o.m[ORDER_M_GROSS];
        if valid.is_empty() || partial {
            a.touch(RecKey::new(Kind::Order, o.id));
            for i in &valid {
                a.touch(RecKey::new(Kind::Invoice, i.id));
            }
            if valid.is_empty() {
                missing.push(st.sym(o.id).to_string());
            }
            a.items.push(json!({"order_id": st.sym(o.id), "state": if valid.is_empty() { "missing_invoice" } else { "partially_invoiced" }, "order_gross_minor": o.m[ORDER_M_GROSS], "invoiced_gross_minor": invoiced_gross, "currency": sym_str(st, o.s[ORDER_S_CURRENCY]), "valid_invoices": valid.iter().map(|i| st.sym(i.id)).collect::<Vec<_>>()}));
        }
    }
    let identity_conflicts = st.conflicts.iter().filter(|c| c.reason == "identity_link_conflict").count();
    if identity_conflicts > 0 {
        a.missing("identity.unresolved_links");
        a.downgrade(Status::Partial);
    }
    a.set("rule", json!(rule));
    a.set("missing_invoice", json!(missing));
    a.step("selection", "orders satisfying the invoicing trigger without a valid issued invoice (partial invoices listed separately)", json!({"rule": rule, "missing": missing.len()}));
    a
}

// ------------------------------------------------------------------ invoice-03

fn order_amount_variance<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "invoices.order_amount_variance", &["orders", "invoices", "coverage", "identity"]);
    a.items_key = "invoices";
    if !a.require_dataset("invoices", "invoices.line_links") {
        a.set("line_variance", Value::Null);
        return a;
    }
    let inv_filter = params.str("invoice_id").and_then(|i| st.interner.get(i));
    let order_filter = params.str("order_id").and_then(|o| st.interner.get(o));
    let mut unlinked = 0;
    for inv in recs(st, Kind::Invoice) {
        if inv.status != INV_ST_ISSUED {
            continue;
        }
        if inv_filter.map(|f| f != inv.id).unwrap_or(false) || order_filter.map(|o| inv.s[INV_S_ORDER] != o).unwrap_or(false) {
            continue;
        }
        let Some(order) = st.rec(Kind::Order, inv.s[INV_S_ORDER]) else {
            unlinked += 1;
            continue;
        };
        a.touch(RecKey::new(Kind::Invoice, inv.id));
        a.touch(RecKey::new(Kind::Order, order.id));
        if inv.s[INV_S_CURRENCY] != order.s[ORDER_S_CURRENCY] && order.s[ORDER_S_CURRENCY] != NONE {
            a.items.push(json!({"invoice_id": st.sym(inv.id), "order_id": st.sym(order.id), "comparison": "currency_mismatch_no_conversion", "invoice_currency": sym_str(st, inv.s[INV_S_CURRENCY]), "order_currency": sym_str(st, order.s[ORDER_S_CURRENCY]), "difference_minor": Value::Null}));
            a.downgrade(Status::Partial);
            a.missing("invoices.currency_rate");
            continue;
        }
        let covered_lines: Vec<&Rec> = inv.linked(Kind::Line).filter_map(|l| st.rec(Kind::Line, l)).collect();
        let (agreed, comparison) = if covered_lines.is_empty() {
            (order.m[ORDER_M_GROSS], "whole_order")
        } else {
            (covered_lines.iter().map(|l| l.m[LINE_M_GROSS]).sum(), "covered_lines_only")
        };
        let all_invoiced: i64 = order_invoices(st, order).iter().filter(|i| i.status == INV_ST_ISSUED).map(|i| i.m[INV_M_GROSS]).sum();
        let partial = covered_lines.is_empty() && all_invoiced < order.m[ORDER_M_GROSS] && order_invoices(st, order).len() > 1;
        let difference = inv.m[INV_M_GROSS] - agreed;
        a.items.push(json!({
            "invoice_id": st.sym(inv.id), "order_id": st.sym(order.id), "currency": sym_str(st, inv.s[INV_S_CURRENCY]), "comparison": comparison,
            "agreed_covered_gross_minor": agreed, "invoice_covered_gross_minor": inv.m[INV_M_GROSS], "difference_minor": difference,
            "partial_invoice": partial, "differs": difference != 0,
        }));
    }
    if unlinked > 0 {
        a.missing("invoices.order_links");
        a.downgrade(Status::Partial);
        a.set("invoices_without_order_link", json!(unlinked));
    }
    a.step("variance", "difference = invoice covered gross − agreed covered gross (same currency, no conversion)", json!({"invoices": a.items.len()}));
    a
}

// ------------------------------------------------------------------ invoice-04

fn dispatch_evidence<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "invoices.dispatch_evidence", &["invoices", "invoice_dispatch", "coverage", "identity"]);
    a.items_key = "invoices";
    let cov = coverage_complete(st, "invoice_dispatch");
    let dataset = st.dataset_present("invoice_dispatch");
    if !dataset && cov != Some(true) {
        a.set("without_send_evidence", Value::Null);
        a.set("without_send_evidence_population_complete", json!(false));
        a.missing("invoice_dispatch.coverage");
        a.downgrade(Status::Unknown);
        return a;
    }
    let complete = cov.unwrap_or(false);
    a.set("without_send_evidence_population_complete", json!(complete));
    if !complete {
        a.missing("invoice_dispatch.coverage_complete");
        a.downgrade(Status::Partial);
    }
    let filter = params.str("invoice_id").and_then(|i| st.interner.get(i));
    let mut without = Vec::new();
    for inv in recs(st, Kind::Invoice) {
        if inv.status != INV_ST_ISSUED || filter.map(|f| f != inv.id).unwrap_or(false) {
            continue;
        }
        a.touch(RecKey::new(Kind::Invoice, inv.id));
        let dispatches: Vec<&Rec> = inv.linked(Kind::Dispatch).filter_map(|d| st.rec(Kind::Dispatch, d)).collect();
        for d in &dispatches {
            a.touch(RecKey::new(Kind::Dispatch, d.id));
        }
        let evidence = if dispatches.iter().any(|d| d.status == DSP_ST_OK) {
            "provider_reported_sent"
        } else if dispatches.iter().any(|d| d.status == DSP_ST_PENDING) {
            "pending"
        } else if dispatches.iter().any(|d| d.status == DSP_ST_ERROR) {
            "error"
        } else {
            if complete { "no_evidence_in_scope" } else { "no_evidence_scope_incomplete" }
        };
        if !evidence.starts_with("provider_reported_sent") && !evidence.starts_with("pending") {
            without.push(st.sym(inv.id).to_string());
        }
        a.items.push(json!({"invoice_id": st.sym(inv.id), "evidence": evidence, "recipient_delivery_proven": false, "dispatches": dispatches.iter().map(|d| json!({"dispatch_id": st.sym(d.id), "channel": sym_str(st, d.s[DSP_S_CHANNEL]), "provider_status": sym_str(st, d.s[DSP_S_STATUS]), "processed_at": time_json(d.t[DSP_T_PROCESSED_AT])})).collect::<Vec<_>>()}));
    }
    a.set("without_send_evidence", json!(without));
    a.step("evidence", "provider-reported send evidence per finalized invoice; absence is not proof of unsent", json!({"invoices": a.items.len(), "without": without.len()}));
    a
}

// ------------------------------------------------------------------ collection-01

fn payment_state<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "orders.payment_state", &["orders", "payments", "coverage", "identity"]);
    a.items_key = "orders";
    if !a.require_dataset("payments", "payments.status") {
        a.set("collected_minor", Value::Null);
        return a;
    }
    let Some(orders) = filter_order(st, params) else {
        a.set("collected_minor", Value::Null);
        a.missing("orders.order_id");
        a.downgrade(Status::Unknown);
        return a;
    };
    let cust = params.str("customer_id").and_then(|c| st.interner.get(c));
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for o in orders {
        if cust.map(|c| o.s[ORDER_S_CUSTOMER] != c).unwrap_or(false) {
            continue;
        }
        let txs = order_transactions(st, o);
        let cur = o.s[ORDER_S_CURRENCY];
        let mut authorized = 0i64;
        let mut captured = 0i64;
        let mut voided = 0i64;
        let mut failed = 0i64;
        let mut mixed = false;
        let mut attempts = Vec::new();
        for t in &txs {
            a.touch(RecKey::new(Kind::Transaction, t.id));
            if t.s[TX_S_CURRENCY] != cur && cur != NONE && t.s[TX_S_CURRENCY] != NONE {
                mixed = true;
                continue;
            }
            authorized += t.m[TX_M_AUTHORIZED];
            captured += t.m[TX_M_CAPTURED];
            voided += t.m[TX_M_VOIDED];
            failed += t.m[TX_M_FAILED_ATTEMPTS];
            attempts.push(json!({"transaction_id": st.sym(t.id), "status": record_view(st, t)["status"].clone(), "authorized_minor": t.m[TX_M_AUTHORIZED], "captured_minor": t.m[TX_M_CAPTURED], "voided_minor": t.m[TX_M_VOIDED], "failed_attempts": t.m[TX_M_FAILED_ATTEMPTS]}));
        }
        let obligation = o.m[ORDER_M_GROSS];
        let remaining = (obligation - captured).max(0);
        let state = if mixed {
            "currency_conflict"
        } else if captured >= obligation && obligation > 0 {
            "paid"
        } else if captured > 0 {
            "partially_collected"
        } else if authorized - voided > 0 {
            "authorized_only"
        } else if failed > 0 {
            "failed_not_paid"
        } else {
            "awaiting_payment"
        };
        if mixed {
            a.downgrade(Status::Conflict);
        }
        *counts.entry(state).or_insert(0) += 1;
        if params.str("order_id").is_some() {
            a.set("collected_minor", json!(captured));
            a.set("remaining_minor", json!(remaining));
            a.set("state", json!(state));
        }
        a.touch(RecKey::new(Kind::Order, o.id));
        a.items.push(json!({"order_id": st.sym(o.id), "currency": sym_str(st, cur), "obligation_minor": obligation, "authorized_minor": authorized, "voided_minor": voided, "collected_minor": captured, "remaining_minor": remaining, "failed_attempts": failed, "state": state, "attempts": attempts}));
    }
    a.set("counts_by_state", json!(counts));
    a.step("state", "collected = confirmed captures; remaining = max(0, obligation − collected); authorizations and failures reported separately", json!({"orders": a.items.len()}));
    a
}

// ------------------------------------------------------------------ collection-02

fn recovered_attempts<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "payments.recovered_attempts", &["orders", "payments", "coverage", "identity"]);
    a.items_key = "orders";
    if !a.require_dataset("payments", "payments.attempt_history_coverage") {
        a.set("recovered_population_complete", json!(false));
        return a;
    }
    let complete = coverage_complete(st, "payments").unwrap_or(false);
    a.set("recovered_population_complete", json!(complete));
    if !complete {
        a.missing("payments.attempt_history_coverage");
        a.downgrade(Status::Partial);
    }
    let Some(orders) = filter_order(st, params) else {
        a.missing("orders.order_id");
        a.downgrade(Status::Unknown);
        return a;
    };
    for o in orders {
        let attempts: Vec<&Rec> = o.linked(Kind::Attempt).filter_map(|x| st.rec(Kind::Attempt, x)).filter(|x| x.status == ATT_ST_FAILED).collect();
        if attempts.is_empty() {
            continue;
        }
        let txs = order_transactions(st, o);
        let required = o.m[ORDER_M_GROSS];
        let captured: i64 = txs.iter().filter(|t| t.s[TX_S_CURRENCY] == o.s[ORDER_S_CURRENCY] || o.s[ORDER_S_CURRENCY] == NONE).map(|t| t.m[TX_M_CAPTURED]).sum();
        let last_fail = attempts.iter().map(|x| x.t[ATT_T_OCCURRED_AT]).max().unwrap_or(0);
        let later_capture = txs.iter().any(|t| t.m[TX_M_CAPTURED] > 0 && t.t[TX_T_CAPTURED_AT] >= last_fail);
        let recovered = captured >= required && required > 0 && later_capture;
        let state = if recovered { "recovered" } else if captured > 0 { "partially_recovered" } else { "open_deficit" };
        a.touch(RecKey::new(Kind::Order, o.id));
        for x in &attempts {
            a.touch(RecKey::new(Kind::Attempt, x.id));
        }
        for t in &txs {
            a.touch(RecKey::new(Kind::Transaction, t.id));
        }
        a.items.push(json!({"order_id": st.sym(o.id), "required_minor": required, "collected_minor": captured, "deficit_minor": (required - captured).max(0), "recovered": recovered, "state": state, "failed_history_retained": attempts.iter().map(|x| json!({"attempt_id": st.sym(x.id), "transaction_id": sym_str(st, x.s[ATT_S_TRANSACTION]), "amount_minor": x.m[ATT_M_AMOUNT], "occurred_at": time_json(x.t[ATT_T_OCCURRED_AT]), "reason": sym_str(st, x.s[ATT_S_REASON])})).collect::<Vec<_>>()}));
    }
    a.step("recovery", "recovered = later confirmed captures >= required amount; all attempts retained", json!({"orders_with_failures": a.items.len()}));
    a
}

// ------------------------------------------------------------------ collection-03

fn payment_variance<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "invoices.payment_variance", &["invoices", "payments", "payment_allocations", "coverage", "identity"]);
    a.items_key = "invoices";
    a.set("fee_added_to_customer_debt", json!(0));
    if !a.require_dataset("payment_allocations", "payment_allocations") {
        a.set("remaining_minor", Value::Null);
        a.set("unallocated_payments_separate", json!(true));
        return a;
    }
    let filter = params.str("invoice_id").and_then(|i| st.interner.get(i));
    let cust = params.str("customer_id").and_then(|c| st.interner.get(c));
    let mut unallocated_total: BTreeMap<String, i64> = BTreeMap::new();
    for inv in recs(st, Kind::Invoice) {
        if inv.status != INV_ST_ISSUED || filter.map(|f| f != inv.id).unwrap_or(false) || cust.map(|c| inv.s[INV_S_CUSTOMER] != c).unwrap_or(false) {
            continue;
        }
        let allocated = inv.m[INV_M_ALLOCATED];
        let remaining = inv.m[INV_M_GROSS] - inv.m[INV_M_CREDIT] - allocated;
        let txs: Vec<&Rec> = inv.linked(Kind::Transaction).filter_map(|t| st.rec(Kind::Transaction, t)).collect();
        let captured: i64 = txs.iter().filter(|t| t.s[TX_S_CURRENCY] == inv.s[INV_S_CURRENCY]).map(|t| t.m[TX_M_CAPTURED]).sum();
        let fees: i64 = txs.iter().map(|t| t.m[TX_M_FEES]).sum();
        let unallocated = (captured - allocated).max(0);
        let cur = st.sym(inv.s[INV_S_CURRENCY]).to_string();
        *unallocated_total.entry(cur.clone()).or_insert(0) += unallocated;
        let mismatch = remaining != invoice_open(inv);
        a.touch(RecKey::new(Kind::Invoice, inv.id));
        for t in &txs {
            a.touch(RecKey::new(Kind::Transaction, t.id));
        }
        for al in inv.linked(Kind::Allocation) {
            a.touch(RecKey::new(Kind::Allocation, al));
        }
        if params.str("invoice_id").is_some() {
            a.set("remaining_minor", json!(remaining));
        }
        a.items.push(json!({"invoice_id": st.sym(inv.id), "currency": cur, "invoice_minor": inv.m[INV_M_GROSS], "credit_minor": inv.m[INV_M_CREDIT], "allocated_capture_minor": allocated, "remaining_minor": remaining, "reported_open_minor": invoice_open(inv), "reported_vs_reconciled_mismatch": mismatch, "provider_fee_minor": fees, "fee_added_to_customer_debt": 0, "unallocated_payments_minor": unallocated, "overpayment_minor": (-remaining).max(0)}));
    }
    a.set("unallocated_payments_by_currency", json!(unallocated_total));
    a.set("unallocated_payments_separate", json!(true));
    a.step("remaining", "remaining = invoice − credits − allocated gross customer payments; provider fees never reduce the customer payment", json!({"invoices": a.items.len()}));
    a
}

// ------------------------------------------------------------------ collection-04

fn review_queue<'a>(st: &'a TenantState, params: &Params, now: DateTime<Utc>) -> Answer<'a> {
    let mut a = Answer::new(st, "receivables.review_queue", &["invoices", "payment_allocations", "payments", "policy", "cases", "coverage", "identity"]);
    a.items_key = "queue";
    a.effective_at = Some(now);
    a.set("send_reminder", json!(false));
    a.set("automatic_action", json!(false));
    if !a.require_dataset("invoices", "invoices") {
        a.set("review", Value::Null);
        return a;
    }
    let cases_known = st.dataset_present("cases") && coverage_complete(st, "cases").unwrap_or(true);
    let policy = policy_with(st, POL_S_REMINDER_POLICY);
    if let Some(p) = policy {
        a.touch(RecKey::new(Kind::Policy, p.id));
    }
    if !cases_known {
        a.missing("cases.coverage");
        a.downgrade(Status::Partial);
        a.set("queue_label", json!("amounts_due_case_context_unknown"));
    } else {
        a.set("queue_label", json!("due_receivables_for_review"));
    }
    if policy.is_none() {
        a.missing("policy.reminder_policy");
        a.downgrade(Status::Partial);
    }
    a.set("policy", json!(policy.map(|p| st.sym(p.s[POL_S_REMINDER_POLICY]))));
    let cur = params.str("currency").map(|c| c.to_uppercase()).and_then(|c| st.interner.get(&c));
    let cust = params.str("customer_id").and_then(|c| st.interner.get(c));
    let now_ms = time_to_ms(now);
    let mut review = Vec::new();
    for inv in recs(st, Kind::Invoice) {
        if inv.status != INV_ST_ISSUED || cur.map(|c| inv.s[INV_S_CURRENCY] != c).unwrap_or(false) || cust.map(|c| inv.s[INV_S_CUSTOMER] != c).unwrap_or(false) {
            continue;
        }
        let open = invoice_open(inv);
        if open <= 0 || inv.t[INV_T_DUE_DATE] == 0 || inv.t[INV_T_DUE_DATE] > now_ms {
            continue;
        }
        let cases: Vec<&Rec> = recs(st, Kind::Case)
            .filter(|c| c.status == CASE_ST_OPEN && (c.s[CASE_S_INVOICE] == inv.id || (c.s[CASE_S_INVOICE] == NONE && c.s[CASE_S_CUSTOMER] != NONE && c.s[CASE_S_CUSTOMER] == inv.s[INV_S_CUSTOMER])))
            .collect();
        let extension_active = cases.iter().any(|c| c.t[CASE_T_EXTENSION_UNTIL] > now_ms);
        let flags: Vec<String> = cases.iter().map(|c| format!("case:{}:{}", st.sym(c.id), st.sym(c.s[CASE_S_STATUS]))).collect();
        let uncertain = inv.m[INV_M_REPORTED_PAID] != inv.m[INV_M_ALLOCATED] && st.dataset_present("payment_allocations");
        a.touch(RecKey::new(Kind::Invoice, inv.id));
        for c in &cases {
            a.touch(RecKey::new(Kind::Case, c.id));
        }
        let priority = if extension_active { "hold_extension_active" } else if !cases.is_empty() { "review_with_case" } else { "review_overdue" };
        review.push(st.sym(inv.id).to_string());
        a.items.push(json!({"invoice_id": st.sym(inv.id), "customer_id": sym_str(st, inv.s[INV_S_CUSTOMER]), "currency": sym_str(st, inv.s[INV_S_CURRENCY]), "open_minor": open, "due_date": time_json(inv.t[INV_T_DUE_DATE]), "days_overdue": (now_ms - inv.t[INV_T_DUE_DATE]) / 86_400_000, "cases": flags, "extension_active": extension_active, "payment_uncertain": uncertain, "priority": priority, "case_context_known": cases_known}));
    }
    a.items.sort_by(|x, y| y["open_minor"].as_i64().cmp(&x["open_minor"].as_i64()));
    a.set("review", json!(review));
    a.step("queue", "due net receivables (open > 0, due_date <= now) with case/extension flags; a queue, never automatic dunning", json!({"queued": review.len()}));
    a
}

// ------------------------------------------------------------------ settlement-01

fn money_positions<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "providers.money_positions", &["provider_ledger", "positions", "payouts", "bank", "holds", "coverage", "identity"]);
    a.items_key = "accounts";
    if !st.dataset_present("payments") && !st.dataset_present("provider_ledger") && !st.dataset_present("payouts") {
        a.missing("provider_ledger");
        a.downgrade(Status::Unknown);
        a.set("net_assets_minor", Value::Null);
        return a;
    }
    let cur = params.str("currency").map(|c| c.to_uppercase()).and_then(|c| st.interner.get(&c));
    let acc_filter = params.str("account_ref").and_then(|c| st.interner.get(c));
    let holds_known = st.dataset_present("holds");
    let bank_known = st.dataset_present("bank");
    let mut unknown_components: Vec<&str> = Vec::new();
    for acc in recs(st, Kind::Account) {
        if cur.map(|c| acc.s[ACC_S_CURRENCY] != c).unwrap_or(false) || acc_filter.map(|f| acc.s[ACC_S_ACCOUNT_REF] != f).unwrap_or(false) {
            continue;
        }
        a.touch(RecKey::new(Kind::Account, acc.id));
        let observed = acc.status == ACC_ST_OBSERVED;
        let obs = |slot: usize| -> Option<i64> { if observed && acc.m[slot] != i64::MIN { Some(acc.m[slot]) } else { None } };
        let balance = blackbox_domain::views::account_balance(acc);
        let net_assets = balance + acc.m[ACC_M_IN_TRANSIT] + acc.m[ACC_M_BANK_CONFIRMED];
        let held = if holds_known || acc.m[ACC_M_HELD] != 0 { Some(acc.m[ACC_M_HELD]) } else { obs(ACC_M_OBS_HELD) };
        let processing = obs(ACC_M_OBS_PROCESSING);
        let available = match (held, processing) {
            (Some(h), Some(p)) => Some(balance - h - p - acc.m[ACC_M_ANNOUNCED]),
            _ => obs(ACC_M_OBS_AVAILABLE),
        };
        let residual = obs(ACC_M_OBS_TOTAL).map(|t| t - balance);
        let mut unknown: Vec<&str> = Vec::new();
        if held.is_none() {
            unknown.push("held");
        }
        if processing.is_none() {
            unknown.push("processing");
        }
        if available.is_none() {
            unknown.push("available");
        }
        if !bank_known {
            unknown.push("bank_confirmed");
        }
        let complete_partition = unknown.is_empty();
        for u in &unknown {
            if !unknown_components.contains(u) {
                unknown_components.push(u);
            }
        }
        a.items.push(json!({
            "account_ref": sym_str(st, acc.s[ACC_S_ACCOUNT_REF]), "currency": sym_str(st, acc.s[ACC_S_CURRENCY]),
            "captured_minor": acc.m[ACC_M_CAPTURED], "fees_minor": acc.m[ACC_M_FEES], "refunds_minor": acc.m[ACC_M_REFUNDED],
            "chargebacks_net_minor": acc.m[ACC_M_CB_DEBIT] - acc.m[ACC_M_CB_REVERSED], "other_adjustments_minor": acc.m[ACC_M_LEDGER_OTHER],
            "provider_balance_minor": balance, "held_minor": held, "processing_minor": processing, "available_minor": available,
            "payout_announced_minor": acc.m[ACC_M_ANNOUNCED], "in_transit_minor": acc.m[ACC_M_IN_TRANSIT],
            "bank_confirmed_minor": if bank_known { json!(acc.m[ACC_M_BANK_CONFIRMED]) } else { Value::Null },
            "net_assets_minor": net_assets, "observed_total_minor": obs(ACC_M_OBS_TOTAL), "reconciliation_residual_minor": residual,
            "observed_at": time_json(acc.t[ACC_T_OBSERVED_AT]), "complete_partition": complete_partition, "unknown_components": unknown,
        }));
    }
    if a.items.len() == 1 {
        let one = a.items[0].clone();
        for k in ["net_assets_minor", "in_transit_minor", "bank_confirmed_minor", "provider_balance_minor"] {
            a.set(k, one[k].clone());
        }
    }
    a.set("unknown_components", json!(unknown_components));
    a.set("unknown_components_are_zero", json!(false));
    if !unknown_components.is_empty() {
        for u in &unknown_components {
            a.missing(match *u { "held" => "holds", "processing" => "positions.processing_minor", "available" => "positions.available_minor", _ => "bank" });
        }
        a.downgrade(Status::Partial);
    }
    a.step("positions", "provider_balance = captured − fees − refunds − payouts sent − chargebacks + adjustments; net_assets = balance + in_transit + bank_confirmed; unknown components are reported, never zeroed", json!({"accounts": a.items.len()}));
    a
}

// ------------------------------------------------------------------ settlement-02

fn gross_to_net<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "payouts.gross_to_net", &["provider_ledger", "payouts", "coverage", "identity"]);
    a.items_key = "postings";
    let Some(po) = lookup(st, Kind::Payout, params.str("payout_id")) else {
        a.set("reconciled", json!(false));
        a.missing("payouts.payout_id");
        a.downgrade(Status::Unknown);
        return a;
    };
    a.touch(RecKey::new(Kind::Payout, po.id));
    let ledger: Vec<&Rec> = po.linked(Kind::Ledger).filter_map(|l| st.rec(Kind::Ledger, l)).collect();
    let txs: Vec<&Rec> = po.linked(Kind::Transaction).filter_map(|t| st.rec(Kind::Transaction, t)).collect();
    let (captures, fees, refunds, other, basis) = if !ledger.is_empty() {
        for l in &ledger {
            a.touch(RecKey::new(Kind::Ledger, l.id));
            a.items.push(record_view(st, l));
        }
        (po.m[PO_M_MEMBER_CAPTURES], po.m[PO_M_MEMBER_FEES], po.m[PO_M_MEMBER_REFUNDS], po.m[PO_M_MEMBER_OTHER], "ledger_postings")
    } else if !txs.is_empty() {
        let mut c = 0;
        let mut f = 0;
        let mut r = 0;
        for t in &txs {
            if t.s[TX_S_CURRENCY] != po.s[PO_S_CURRENCY] {
                a.downgrade(Status::Conflict);
                continue;
            }
            a.touch(RecKey::new(Kind::Transaction, t.id));
            c += t.m[TX_M_CAPTURED];
            f += t.m[TX_M_FEES];
            r += t.m[TX_M_REFUNDED];
            a.items.push(json!({"transaction_id": st.sym(t.id), "captured_minor": t.m[TX_M_CAPTURED], "fees_minor": t.m[TX_M_FEES], "refunded_minor": t.m[TX_M_REFUNDED]}));
        }
        (c, f, r, 0, "linked_transactions")
    } else {
        a.set("reconciled", json!(false));
        a.set("payout_minor", json!(po.m[PO_M_AMOUNT]));
        a.missing("provider_ledger.payout_membership_coverage");
        a.downgrade(Status::Unknown);
        a.step("membership", "no postings or transactions are assigned to this payout; a date window is not used", json!({}));
        return a;
    };
    let computed = captures - fees - refunds + other;
    let unexplained = po.m[PO_M_AMOUNT] - computed;
    a.set("payout_id", json!(st.sym(po.id)));
    a.set("currency", sym_str(st, po.s[PO_S_CURRENCY]));
    a.set("payout_minor", json!(po.m[PO_M_AMOUNT]));
    a.set("member_captures_minor", json!(captures));
    a.set("member_fees_minor", json!(fees));
    a.set("member_refunds_minor", json!(refunds));
    a.set("other_adjustments_minor", json!(other));
    a.set("computed_net_minor", json!(computed));
    a.set("unexplained_minor", json!(unexplained));
    a.set("reconciled", json!(unexplained == 0));
    a.set("membership_basis", json!(basis));
    if unexplained != 0 {
        a.downgrade(Status::Partial);
        a.missing("provider_ledger.payout_membership_coverage");
    }
    a.step("net", "computed_net = captures − fees − refunds + other adjustments (payout members only); unexplained = payout − computed_net", json!({"captures": captures, "fees": fees, "refunds": refunds, "other": other, "payout": po.m[PO_M_AMOUNT], "unexplained": unexplained}));
    a
}

// ------------------------------------------------------------------ settlement-03

fn missing_bank_confirmation<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "payouts.missing_bank_confirmation", &["payouts", "bank", "coverage", "identity"]);
    a.items_key = "payouts";
    if !a.require_dataset("bank", "bank") {
        a.set("bank_arrival", json!("unknown"));
        a.set("missing_confirmation", Value::Null);
        return a;
    }
    let cur = params.str("currency").map(|c| c.to_uppercase()).and_then(|c| st.interner.get(&c));
    let tol = params.int("tolerance_minor").unwrap_or(0);
    let import_through = recs(st, Kind::Coverage)
        .filter(|c| st.sym(c.s[COV_S_CAPABILITY]) == "bank")
        .map(|c| c.t[COV_T_COMPLETE_THROUGH])
        .max()
        .filter(|t| *t != 0)
        .or_else(|| recs(st, Kind::BankEntry).map(|b| b.t[BANK_T_BOOKED_AT]).max());
    a.set("bank_import_complete_through", import_through.map(time_json).unwrap_or(Value::Null));
    let mut missing = Vec::new();
    for po in recs(st, Kind::Payout) {
        if po.status != PO_ST_ANNOUNCED && po.status != PO_ST_SENT {
            continue;
        }
        if cur.map(|c| po.s[PO_S_CURRENCY] != c).unwrap_or(false) {
            continue;
        }
        let confirmed = po.m[PO_M_BANK_CONFIRMED];
        if po.status == PO_ST_SENT && confirmed >= po.m[PO_M_AMOUNT] {
            continue;
        }
        a.touch(RecKey::new(Kind::Payout, po.id));
        let candidates: Vec<Value> = recs(st, Kind::BankEntry)
            .filter(|b| b.status == BANK_ST_CREDIT_BOOKED && b.s[BANK_S_CURRENCY] == po.s[PO_S_CURRENCY] && (b.m[BANK_M_AMOUNT] - po.m[PO_M_AMOUNT]).abs() <= tol)
            .map(|b| {
                a.touch(RecKey::new(Kind::BankEntry, b.id));
                json!({"bank_entry_id": st.sym(b.id), "amount_minor": b.m[BANK_M_AMOUNT], "booked_at": time_json(b.t[BANK_T_BOOKED_AT]), "reference": sym_str(st, b.s[BANK_S_REFERENCE])})
            })
            .collect();
        let pending: Vec<Value> = recs(st, Kind::BankEntry)
            .filter(|b| b.status == BANK_ST_PENDING && b.s[BANK_S_PAYOUT] == po.id)
            .map(|b| json!({"bank_entry_id": st.sym(b.id), "status": "pending_not_booked"}))
            .collect();
        let conclusion = if po.status == PO_ST_ANNOUNCED {
            "announced_not_sent"
        } else if !candidates.is_empty() {
            "ambiguous_candidates_unmatched"
        } else if !pending.is_empty() {
            "bank_pending_not_booked"
        } else if import_through.map(|t| t >= po.t[PO_T_SENT_AT]).unwrap_or(false) {
            "no_evidence_in_imported_interval"
        } else {
            "sent_after_imported_interval"
        };
        missing.push(st.sym(po.id).to_string());
        a.items.push(json!({"payout_id": st.sym(po.id), "state": record_view(st, po)["status"].clone(), "amount_minor": po.m[PO_M_AMOUNT], "currency": sym_str(st, po.s[PO_S_CURRENCY]), "bank_confirmed_minor": confirmed, "sent_at": time_json(po.t[PO_T_SENT_AT]), "conclusion": conclusion, "matching_booked_entries": candidates, "pending_entries": pending}));
    }
    a.set("missing_confirmation", json!(missing));
    if a.items.len() == 1 {
        a.set("conclusion", a.items[0]["conclusion"].clone());
    }
    a.step("match", "a sent payout is confirmed only by a uniquely evidenced booked bank credit (reference/currency/amount); pending, ambiguous and out-of-interval cases are reported separately", json!({"missing": missing.len()}));
    a
}

// ------------------------------------------------------------------ settlement-04

fn holds_and_releases<'a>(st: &'a TenantState, params: &Params, now: DateTime<Utc>) -> Answer<'a> {
    let mut a = Answer::new(st, "providers.holds_and_releases", &["holds", "positions", "coverage", "identity"]);
    a.items_key = "holds";
    a.effective_at = Some(now);
    if !a.require_dataset("holds", "holds") {
        a.set("held_minor", Value::Null);
        return a;
    }
    let cur = params.str("currency").map(|c| c.to_uppercase()).and_then(|c| st.interner.get(&c));
    let acc_filter = params.str("account_ref").and_then(|c| st.interner.get(c));
    let mut held_total: BTreeMap<String, i64> = BTreeMap::new();
    let mut released_total: BTreeMap<String, i64> = BTreeMap::new();
    let mut promised_only = 0;
    for h in recs(st, Kind::Hold) {
        if cur.map(|c| h.s[HOLD_S_CURRENCY] != c).unwrap_or(false) {
            continue;
        }
        if let Some(f) = acc_filter {
            let acc_ref = st.rec(Kind::Account, h.s[HOLD_S_ACCOUNT]).map(|r| r.s[ACC_S_ACCOUNT_REF]).unwrap_or(NONE);
            if acc_ref != f {
                continue;
            }
        }
        a.touch(RecKey::new(Kind::Hold, h.id));
        let c = st.sym(h.s[HOLD_S_CURRENCY]).to_string();
        let held = h.m[HOLD_M_AMOUNT] - h.m[HOLD_M_RELEASED];
        let only_promised = h.status == HOLD_ST_ACTIVE && h.t[HOLD_T_RELEASE_PROMISED_AT] != 0;
        if only_promised {
            promised_only += 1;
        }
        *held_total.entry(c.clone()).or_insert(0) += held.max(0);
        *released_total.entry(c.clone()).or_insert(0) += h.m[HOLD_M_RELEASED];
        a.items.push(json!({"hold_id": st.sym(h.id), "currency": c, "state": if h.status == HOLD_ST_ACTIVE { "active" } else { "released" }, "amount_minor": h.m[HOLD_M_AMOUNT], "held_minor": held.max(0), "released_minor": h.m[HOLD_M_RELEASED], "reason": sym_str(st, h.s[HOLD_S_REASON]), "transaction_id": sym_str(st, h.s[HOLD_S_TRANSACTION]), "release_promised_at": time_json(h.t[HOLD_T_RELEASE_PROMISED_AT]), "released_at": time_json(h.t[HOLD_T_RELEASED_AT]), "release_is_only_promised": only_promised, "promise_overdue": only_promised && h.t[HOLD_T_RELEASE_PROMISED_AT] < time_to_ms(now)}));
    }
    if a.items.len() == 1 {
        a.set("held_minor", a.items[0]["held_minor"].clone());
        a.set("released_minor", a.items[0]["released_minor"].clone());
        a.set("release_is_only_promised", a.items[0]["release_is_only_promised"].clone());
    }
    a.set("held_by_currency", json!(held_total));
    a.set("released_by_currency", json!(released_total));
    a.set("releases_only_promised", json!(promised_only));
    let observed: Vec<Value> = recs(st, Kind::Account).filter(|acc| acc.status == ACC_ST_OBSERVED && acc.m[ACC_M_OBS_HELD] != i64::MIN).map(|acc| json!({"account_ref": sym_str(st, acc.s[ACC_S_ACCOUNT_REF]), "currency": sym_str(st, acc.s[ACC_S_CURRENCY]), "observed_held_minor": acc.m[ACC_M_OBS_HELD], "observed_at": time_json(acc.t[ACC_T_OBSERVED_AT])})).collect();
    a.set("observed_positions", json!(observed));
    a.step("holds", "held = current hold amount − released (current versions only); a promised release is not a release", json!({"holds": a.items.len()}));
    a
}

// ------------------------------------------------------------------ reversal-01

fn returns_lifecycle<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "returns.lifecycle", &["returns", "receipts", "refunds", "invoices", "tracking", "coverage", "identity"]);
    a.items_key = "returns";
    if !a.require_dataset("returns", "returns") {
        return a;
    }
    let receipts_known = st.dataset_present("receipts");
    if !receipts_known {
        a.missing("receipts");
        a.downgrade(Status::Partial);
        a.set("request_is_not_receipt", json!(true));
    }
    let order_filter = params.str("order_id").and_then(|o| st.interner.get(o));
    let ret_filter = params.str("return_id").and_then(|r| st.interner.get(r));
    for r in recs(st, Kind::Return) {
        if order_filter.map(|o| r.s[RET_S_ORDER] != o).unwrap_or(false) || ret_filter.map(|f| f != r.id).unwrap_or(false) {
            continue;
        }
        a.touch(RecKey::new(Kind::Return, r.id));
        let order = st.rec(Kind::Order, r.s[RET_S_ORDER]);
        let refunds: Vec<&Rec> = order.map(|o| o.linked(Kind::Refund).filter_map(|x| st.rec(Kind::Refund, x)).collect()).unwrap_or_default();
        for rf in &refunds {
            a.touch(RecKey::new(Kind::Refund, rf.id));
        }
        let completed: i64 = refunds.iter().filter(|x| x.status == RF_ST_COMPLETED).map(|x| x.m[RF_M_AMOUNT]).sum();
        let pending: i64 = refunds.iter().filter(|x| x.status == RF_ST_PENDING).map(|x| x.m[RF_M_AMOUNT]).sum();
        let refund_state = if completed > 0 { "completed" } else if pending > 0 { "pending" } else if refunds.iter().any(|x| x.status == RF_ST_FAILED) { "failed" } else { "none" };
        let received = receipts_known.then(|| r.q[RET_Q_RECEIVED]);
        a.items.push(json!({
            "return_id": st.sym(r.id), "order_id": sym_str(st, r.s[RET_S_ORDER]), "item_id": sym_str(st, r.s[RET_S_ITEM]), "unit": sym_str(st, r.s[RET_S_UNIT]),
            "state": record_view(st, r)["status"].clone(), "requested_quantity": dec(r.q[RET_Q_REQUESTED]),
            "received_quantity": received.map(dec).unwrap_or(Value::Null), "quarantined_quantity": received.map(|_| dec(r.q[RET_Q_QUARANTINED])).unwrap_or(Value::Null),
            "restocked_quantity": received.map(|_| dec(r.q[RET_Q_RESTOCKED])).unwrap_or(Value::Null),
            "receipt_state": if !receipts_known { json!("unknown") } else if r.q[RET_Q_RESTOCKED] > Decimal::ZERO { json!("restocked") } else if r.q[RET_Q_RECEIVED] > Decimal::ZERO { json!("received") } else { json!("not_received") },
            "physical_return_received": received.map(|q| json!(q > Decimal::ZERO)).unwrap_or(Value::Null),
            "sellable_added": received.map(|_| dec(r.q[RET_Q_RESTOCKED])).unwrap_or(Value::Null),
            "disposition": sym_str(st, r.s[RET_S_DISPOSITION]), "expected_credit_minor": r.m[RET_M_EXPECTED_CREDIT], "currency": sym_str(st, r.s[RET_S_CURRENCY]),
            "refund_state": refund_state, "refund_completed_minor": completed, "refund_pending_minor": pending, "cash_refund_confirmed": completed > 0,
        }));
    }
    a.step("lifecycle", "requested, received, quarantined and restocked quantities are independent; refund money/status is separate; a request is not a receipt", json!({"returns": a.items.len()}));
    a
}

// ------------------------------------------------------------------ reversal-02

fn refund_gaps<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "credits.refund_gaps", &["invoices", "payments", "entitlements", "refunds", "coverage", "identity"]);
    a.items_key = "entitlements";
    let order_filter = params.str("order_id").and_then(|o| st.interner.get(o));
    // Credits without an entitlement are informational only (a credit alone is not a refund).
    let credits_without: Vec<Value> = recs(st, Kind::Credit)
        .filter(|c| order_filter.map(|o| c.s[CREDIT_S_ORDER] == o).unwrap_or(true))
        .filter(|c| !recs(st, Kind::Entitlement).any(|e| e.s[ENT_S_CREDIT] == c.id))
        .map(|c| json!({"credit_id": st.sym(c.id), "invoice_id": sym_str(st, c.s[CREDIT_S_INVOICE]), "amount_minor": c.m[CREDIT_M_AMOUNT], "currency": sym_str(st, c.s[CREDIT_S_CURRENCY]), "cash_refund_entitlement": "none_recorded"}))
        .collect();
    a.set("credits_without_entitlement", json!(credits_without));
    if !a.require_dataset("entitlements", "entitlements") {
        a.set("refund_due_minor", Value::Null);
        return a;
    }
    let mut due_total: BTreeMap<String, i64> = BTreeMap::new();
    for e in recs(st, Kind::Entitlement) {
        if e.status != ENT_ST_APPROVED || order_filter.map(|o| e.s[ENT_S_ORDER] != o).unwrap_or(false) {
            continue;
        }
        let dest = st.sym(e.s[ENT_S_DESTINATION]);
        if dest == "store_credit" {
            a.touch(RecKey::new(Kind::Entitlement, e.id));
            a.items.push(json!({"entitlement_id": st.sym(e.id), "destination": dest, "cash_refund_due_minor": 0, "note": "store credit agreed; no cash repayment"}));
            continue;
        }
        a.touch(RecKey::new(Kind::Entitlement, e.id));
        let tx = st.rec(Kind::Transaction, e.s[ENT_S_TRANSACTION]);
        let Some(tx) = tx else {
            a.missing("entitlements.original_transaction_id");
            a.downgrade(Status::Partial);
            a.items.push(json!({"entitlement_id": st.sym(e.id), "approved_cash_refund_minor": e.m[ENT_M_AMOUNT], "cash_refund_due_minor": Value::Null, "note": "original payment not linked"}));
            continue;
        };
        a.touch(RecKey::new(Kind::Transaction, tx.id));
        if tx.s[TX_S_CURRENCY] != e.s[ENT_S_CURRENCY] && e.s[ENT_S_CURRENCY] != NONE {
            a.downgrade(Status::Conflict);
            continue;
        }
        let completed: i64 = tx.linked(Kind::Refund).filter_map(|r| st.rec(Kind::Refund, r)).filter(|r| r.status == RF_ST_COMPLETED).map(|r| r.m[RF_M_AMOUNT]).sum();
        let pending: i64 = tx.linked(Kind::Refund).filter_map(|r| st.rec(Kind::Refund, r)).filter(|r| r.status == RF_ST_PENDING).map(|r| r.m[RF_M_AMOUNT]).sum();
        let due = (e.m[ENT_M_AMOUNT] - completed).max(0);
        let cur = st.sym(tx.s[TX_S_CURRENCY]).to_string();
        *due_total.entry(cur.clone()).or_insert(0) += due;
        a.items.push(json!({"entitlement_id": st.sym(e.id), "order_id": sym_str(st, e.s[ENT_S_ORDER]), "credit_id": sym_str(st, e.s[ENT_S_CREDIT]), "original_transaction_id": st.sym(tx.id), "currency": cur, "original_capture_minor": tx.m[TX_M_CAPTURED], "approved_cash_refund_minor": e.m[ENT_M_AMOUNT], "completed_cash_refund_minor": completed, "pending_refund_minor": pending, "cash_refund_due_minor": due, "destination": dest}));
    }
    if a.items.len() == 1 {
        a.set("cash_refund_due_minor", a.items[0]["cash_refund_due_minor"].clone());
    }
    a.set("refund_due_by_currency", json!(due_total));
    a.step("gap", "cash_refund_due = approved cash entitlement − completed refunds on the same original payment; credit documents alone create no repayment", json!({"entitlements": a.items.len()}));
    a
}

// ------------------------------------------------------------------ reversal-03

fn cancellation_steps<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "cancellations.outstanding_steps", &["orders", "allocations", "invoices", "payments", "refunds", "entitlements", "receipts", "coverage", "identity"]);
    a.items_key = "checks";
    a.set("do_not_mark_complete", json!(true));
    let Some(o) = lookup(st, Kind::Order, params.str("order_id")) else {
        a.missing("orders.order_id");
        a.downgrade(Status::Unknown);
        a.set("remaining_steps", Value::Null);
        return a;
    };
    a.touch(RecKey::new(Kind::Order, o.id));
    let cancelled = o.status == ORDER_ST_CANCELLED || o.status == ORDER_ST_PARTIALLY_CANCELLED;
    a.set("cancelled", json!(cancelled));
    if !cancelled {
        a.set("remaining_steps", json!([]));
        a.step("branch", "order is not cancelled; nothing to correct", json!({}));
        return a;
    }
    let mut steps: Vec<&str> = Vec::new();
    let alloc_known = st.dataset_present("allocations");
    let (reserved, keys) = active_reserved_for(st, o, None);
    for k in keys {
        a.touch(k);
    }
    let reservation_step = if !alloc_known {
        a.missing("allocations");
        a.downgrade(Status::Partial);
        json!("unknown")
    } else if reserved > Decimal::ZERO {
        steps.push("release_reservation");
        json!("release_reservation")
    } else {
        json!("done")
    };
    let shipped = o.q[ORDER_Q_DISPATCHED];
    let branch = if shipped > Decimal::ZERO { "return_of_shipped_goods" } else { "unshipped_cancellation" };
    let stock_receipt_required = shipped > Decimal::ZERO;
    if stock_receipt_required {
        let returns: Vec<&Rec> = o.linked(Kind::Return).filter_map(|r| st.rec(Kind::Return, r)).collect();
        let received: Decimal = returns.iter().map(|r| r.q[RET_Q_RECEIVED]).sum();
        for r in &returns {
            a.touch(RecKey::new(Kind::Return, r.id));
        }
        if received < shipped.min(o.q[ORDER_Q_CANCELLED]) {
            steps.push("receive_return");
        }
    }
    // Invoice: cancelled share = cancelled quantity × unit gross (per line).
    let mut cancelled_share = 0i64;
    for l in order_lines(st, o) {
        let unit = if l.m[LINE_M_UNIT_GROSS] != 0 { l.m[LINE_M_UNIT_GROSS] } else if !l.q[LINE_Q_QUANTITY].is_zero() { (Decimal::from(l.m[LINE_M_GROSS]) / l.q[LINE_Q_QUANTITY]).round().to_string().parse::<i64>().unwrap_or(0) } else { 0 };
        cancelled_share += (l.q[LINE_Q_CANCELLED] * Decimal::from(unit)).round().to_string().parse::<i64>().unwrap_or(0);
    }
    let invoices = order_invoices(st, o);
    let inv_gross: i64 = invoices.iter().filter(|i| i.status == INV_ST_ISSUED).map(|i| i.m[INV_M_GROSS]).sum();
    let inv_credit: i64 = invoices.iter().filter(|i| i.status == INV_ST_ISSUED).map(|i| i.m[INV_M_CREDIT]).sum();
    for i in &invoices {
        a.touch(RecKey::new(Kind::Invoice, i.id));
    }
    let invoice_step = if inv_gross == 0 { "not_applicable" } else if inv_credit < cancelled_share.min(inv_gross) { steps.push("correct_invoice"); "correct_invoice" } else { "done" };
    // Payment: captured for the cancelled share must come back (refund) or an open authorization voided.
    let txs = order_transactions(st, o);
    for t in &txs {
        a.touch(RecKey::new(Kind::Transaction, t.id));
    }
    let captured: i64 = txs.iter().map(|t| t.m[TX_M_CAPTURED]).sum();
    let refunded: i64 = txs.iter().map(|t| t.m[TX_M_REFUNDED]).sum();
    let pending: i64 = txs.iter().map(|t| t.m[TX_M_REFUND_PENDING]).sum();
    let open_auth: i64 = txs.iter().filter(|t| t.status == TX_ST_AUTHORIZED).map(|t| t.m[TX_M_AUTHORIZED] - t.m[TX_M_VOIDED]).sum();
    let owed = cancelled_share.min(captured);
    let payment_step = if captured > 0 && refunded < owed {
        steps.push("refund_payment");
        if pending > 0 { "refund_pending" } else { "refund_payment" }
    } else if captured == 0 && open_auth > 0 {
        steps.push("void_authorization");
        "void_authorization"
    } else {
        "done"
    };
    let entitlements: Vec<&Rec> = o.linked(Kind::Entitlement).filter_map(|e| st.rec(Kind::Entitlement, e)).collect();
    for e in &entitlements {
        a.touch(RecKey::new(Kind::Entitlement, e.id));
    }
    a.items.push(json!({"check": "reservation", "state": reservation_step, "active_reserved": dec(reserved)}));
    a.items.push(json!({"check": "stock", "state": if stock_receipt_required { "receipt_required" } else { "not_applicable" }, "shipped_quantity": dec(shipped)}));
    a.items.push(json!({"check": "invoice", "state": invoice_step, "invoice_minor": inv_gross, "credit_minor": inv_credit, "cancelled_share_minor": cancelled_share}));
    a.items.push(json!({"check": "payment", "state": payment_step, "captured_minor": captured, "refunded_minor": refunded, "pending_refund_minor": pending, "open_authorization_minor": open_auth, "approved_refund_minor": entitlements.iter().filter(|e| e.status == ENT_ST_APPROVED).map(|e| e.m[ENT_M_AMOUNT]).sum::<i64>()}));
    a.set("branch", json!(branch));
    a.set("stock_receipt_required", json!(stock_receipt_required));
    a.set("reservation_step", reservation_step);
    a.set("remaining_steps", json!(steps));
    a.step("checks", "independent reservation/stock/invoice/payment checks at one cutoff; a cancellation never reverses a shipment or payment by itself", json!({"remaining": steps.len()}));
    a
}

// ------------------------------------------------------------------ reversal-04

fn chargeback_overlap<'a>(st: &'a TenantState, params: &Params) -> Answer<'a> {
    let mut a = Answer::new(st, "refunds.chargeback_overlap", &["payments", "refunds", "disputes", "coverage", "identity"]);
    a.items_key = "transactions";
    a.set("duplicate_repayment_proven", json!(false));
    if !a.require_dataset("disputes", "disputes.original_transaction_id") {
        return a;
    }
    let order_filter = params.str("order_id").and_then(|o| st.interner.get(o));
    let tx_filter = params.str("transaction_id").and_then(|t| st.interner.get(t));
    let unlinked = recs(st, Kind::Dispute).filter(|d| d.s[DISP_S_TRANSACTION] == NONE).count();
    if unlinked > 0 {
        a.missing("disputes.original_transaction_id");
        a.downgrade(Status::Partial);
        a.set("disputes_without_transaction_link", json!(unlinked));
    }
    let mut proven = false;
    let mut review = Vec::new();
    for t in recs(st, Kind::Transaction) {
        if t.m[TX_M_CAPTURED] == 0 || order_filter.map(|o| t.s[TX_S_ORDER] != o).unwrap_or(false) || tx_filter.map(|f| f != t.id).unwrap_or(false) {
            continue;
        }
        let disputes: Vec<&Rec> = t.linked(Kind::Dispute).filter_map(|d| st.rec(Kind::Dispute, d)).collect();
        let refunds: Vec<&Rec> = t.linked(Kind::Refund).filter_map(|r| st.rec(Kind::Refund, r)).collect();
        if disputes.is_empty() && refunds.is_empty() {
            continue;
        }
        a.touch(RecKey::new(Kind::Transaction, t.id));
        for d in &disputes {
            a.touch(RecKey::new(Kind::Dispute, d.id));
        }
        for r in &refunds {
            a.touch(RecKey::new(Kind::Refund, r.id));
        }
        let refunded = t.m[TX_M_REFUNDED];
        let pending: i64 = refunds.iter().filter(|r| r.status == RF_ST_PENDING).map(|r| r.m[RF_M_AMOUNT]).sum();
        let cb_net = t.m[TX_M_CB_DEBIT] - t.m[TX_M_CB_REVERSED];
        let net_repayments = refunded + cb_net;
        let excess = (net_repayments - t.m[TX_M_CAPTURED]).max(0);
        let open_dispute = disputes.iter().any(|d| d.status == DISP_ST_OPEN && d.m[DISP_M_DEBIT] == 0);
        let pending_overlap = open_dispute && (refunded > 0 || pending > 0);
        let needs_review = excess > 0 || pending_overlap;
        if excess > 0 {
            proven = true;
        }
        if needs_review {
            review.push(st.sym(t.id).to_string());
        }
        a.items.push(json!({"transaction_id": st.sym(t.id), "order_id": sym_str(st, t.s[TX_S_ORDER]), "currency": sym_str(st, t.s[TX_S_CURRENCY]), "capture_minor": t.m[TX_M_CAPTURED], "refund_completed_minor": refunded, "refund_pending_minor": pending, "chargeback_debit_minor": t.m[TX_M_CB_DEBIT], "chargeback_reversed_minor": t.m[TX_M_CB_REVERSED], "chargeback_fee_minor_excluded": t.m[TX_M_CB_FEE], "net_customer_repayments_minor": net_repayments, "excess_minor": excess, "open_dispute_without_debit": open_dispute, "pending_overlap_risk": pending_overlap, "review_required": needs_review}));
    }
    a.set("duplicate_repayment_proven", json!(proven));
    a.set("review_required", json!(review));
    if a.items.len() == 1 {
        a.set("net_customer_repayments_minor", a.items[0]["net_customer_repayments_minor"].clone());
        a.set("excess_minor", a.items[0]["excess_minor"].clone());
    }
    a.step("overlap", "net repayments = completed refunds + booked chargeback debits − reversals (fees excluded); excess = max(0, net − capture); open disputes and fees are not completed refunds", json!({"transactions": a.items.len(), "review": review.len()}));
    a
}
