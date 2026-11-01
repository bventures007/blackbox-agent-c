//! `/v1/state` and `/v1/summary` builders.

use blackbox_domain::state::fields::*;
use blackbox_domain::state::{time_to_ms, RecKey};
use blackbox_domain::views::{conflicts_for, coverage_for, merged_history, order_view, record_view, track_views, ConflictView, Coverage, ORDER_DATASETS};
use blackbox_domain::{Kind, TenantState};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const TRACK_SUMMARIES_PER_TRACK: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateResponse {
    pub entity: Value,
    pub state: Value,
    pub tracks: Map<String, Value>,
    pub evidence_refs: Vec<String>,
    pub entry_ids: Vec<Uuid>,
    pub coverage: Coverage,
    pub conflicts: Vec<ConflictView>,
    pub status: String,
    pub missing_inputs: Vec<String>,
}

/// Datasets relevant to each entity kind (coverage reporting).
pub fn datasets_for_kind(kind: Kind) -> &'static [&'static str] {
    match kind {
        Kind::Order => ORDER_DATASETS,
        Kind::Item => &["stock", "allocations", "receipts", "supply"],
        Kind::Invoice => &["invoices", "payment_allocations", "invoice_dispatch"],
        Kind::Transaction => &["payments", "provider_ledger", "refunds", "disputes", "holds"],
        Kind::Shipment => &["fulfillments", "tracking"],
        Kind::Return => &["returns", "receipts", "refunds"],
        Kind::Refund => &["refunds", "entitlements"],
        Kind::Payout => &["payouts", "provider_ledger", "bank"],
        Kind::Customer => &["orders", "communications", "cases"],
        Kind::Reservation => &["allocations", "stock"],
        Kind::BankEntry => &["bank", "payouts"],
        Kind::Account => &["payments", "provider_ledger", "positions", "payouts", "holds", "bank"],
        _ => &[],
    }
}

/// Builds the state response for an entity; `None` when the entity is unknown in this state.
pub fn entity_state(st: &TenantState, kind: Kind, id: &str) -> Option<StateResponse> {
    let sym = st.interner.get(id)?;
    let rec = st.rec(kind, sym)?;
    let (state, entities, mut status, mut missing) = if kind == Kind::Order {
        let v = order_view(st, sym)?;
        let mut missing = Vec::new();
        let mut status = "complete".to_string();
        if v.state.available_stock.is_none() {
            missing.push("stock.basis".to_string());
            status = "partial".into();
        }
        if v.currency_conflict {
            status = "conflict".into();
        }
        (serde_json::to_value(v.state).unwrap_or(Value::Null), v.entities, status, missing)
    } else {
        (record_view(st, rec), vec![RecKey::new(kind, sym)], "complete".to_string(), Vec::new())
    };
    let tracks = track_views(st, &entities, TRACK_SUMMARIES_PER_TRACK);
    let hist = merged_history(st, &entities);
    let entry_ids: Vec<Uuid> = hist.iter().map(|l| l.entry_id).collect();
    let evidence_refs: Vec<String> = entry_ids.iter().map(|e| format!("journal:{e}")).collect();
    let conflicts = conflicts_for(st, &entities);
    if !conflicts.is_empty() && status == "complete" {
        status = "conflict".into();
    }
    if entities.iter().any(|k| st.cold_history.contains(k)) {
        missing.push("history.evicted_use_cold_read".into());
    }
    Some(StateResponse {
        entity: json!({"type": kind.as_str(), "id": id}),
        state,
        tracks,
        evidence_refs,
        entry_ids,
        coverage: coverage_for(st, datasets_for_kind(kind)),
        conflicts,
        status,
        missing_inputs: missing,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub kind: String,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub totals: BTreeMap<String, Map<String, Value>>,
    pub counts: Map<String, Value>,
    pub time_semantics: String,
}

/// Thirty-day (or any bounded interval) totals per currency over record timestamps.
pub fn summary(st: &TenantState, from: DateTime<Utc>, to: DateTime<Utc>, currency: Option<&str>) -> Summary {
    let f = time_to_ms(from);
    let t = time_to_ms(to);
    let in_range = |ms: i64| ms != 0 && ms >= f && ms <= t;
    let cur_filter = currency.map(|c| c.to_uppercase());
    let mut totals: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let mut add = |cur: &str, key: &str, v: i64| {
        if let Some(cf) = &cur_filter {
            if cf != cur {
                return;
            }
        }
        if cur.is_empty() {
            return;
        }
        let m = totals.entry(cur.to_string()).or_default();
        let prev = m.get(key).and_then(|x| x.as_i64()).unwrap_or(0);
        m.insert(key.to_string(), json!(prev + v));
    };
    let mut counts: BTreeMap<&str, i64> = BTreeMap::new();
    let mut bump = |k: &'static str| *counts.entry(k).or_insert(0) += 1;
    for o in st.ids(Kind::Order).iter().filter_map(|i| st.rec(Kind::Order, *i)) {
        if in_range(o.t[ORDER_T_ACCEPTED_AT]) {
            add(st.sym(o.s[ORDER_S_CURRENCY]), "orders_accepted_gross_minor", o.m[ORDER_M_GROSS]);
            bump("orders_accepted");
        }
        if in_range(o.t[ORDER_T_CANCELLED_AT]) {
            bump("orders_cancelled");
        }
    }
    for tx in st.ids(Kind::Transaction).iter().filter_map(|i| st.rec(Kind::Transaction, *i)) {
        if in_range(tx.t[TX_T_CAPTURED_AT]) {
            let c = st.sym(tx.s[TX_S_CURRENCY]);
            add(c, "captured_minor", tx.m[TX_M_CAPTURED]);
            add(c, "fees_minor", tx.m[TX_M_FEES]);
            bump("captures");
        }
    }
    for rf in st.ids(Kind::Refund).iter().filter_map(|i| st.rec(Kind::Refund, *i)) {
        if rf.status == RF_ST_COMPLETED && in_range(rf.t[RF_T_OCCURRED_AT]) {
            add(st.sym(rf.s[RF_S_CURRENCY]), "refunded_minor", rf.m[RF_M_AMOUNT]);
            bump("refunds_completed");
        }
    }
    for inv in st.ids(Kind::Invoice).iter().filter_map(|i| st.rec(Kind::Invoice, *i)) {
        if inv.status == INV_ST_ISSUED && in_range(inv.t[INV_T_ISSUED_AT]) {
            add(st.sym(inv.s[INV_S_CURRENCY]), "invoices_issued_gross_minor", inv.m[INV_M_GROSS]);
            bump("invoices_issued");
        }
    }
    for cr in st.ids(Kind::Credit).iter().filter_map(|i| st.rec(Kind::Credit, *i)) {
        if in_range(cr.t[CREDIT_T_ISSUED_AT]) {
            add(st.sym(cr.s[CREDIT_S_CURRENCY]), "credits_issued_minor", cr.m[CREDIT_M_AMOUNT]);
            bump("credits_issued");
        }
    }
    for po in st.ids(Kind::Payout).iter().filter_map(|i| st.rec(Kind::Payout, *i)) {
        if po.status == PO_ST_SENT && in_range(po.t[PO_T_SENT_AT]) {
            add(st.sym(po.s[PO_S_CURRENCY]), "payouts_sent_minor", po.m[PO_M_AMOUNT]);
            bump("payouts_sent");
        }
    }
    for b in st.ids(Kind::BankEntry).iter().filter_map(|i| st.rec(Kind::BankEntry, *i)) {
        if (b.status == BANK_ST_CREDIT_BOOKED || b.status == BANK_ST_CREDIT_MATCHED) && in_range(b.t[BANK_T_BOOKED_AT]) {
            add(st.sym(b.s[BANK_S_CURRENCY]), "bank_credits_booked_minor", b.m[BANK_M_AMOUNT]);
            bump("bank_credits_booked");
        }
    }
    for s in st.ids(Kind::Shipment).iter().filter_map(|i| st.rec(Kind::Shipment, *i)) {
        if in_range(s.t[SHIP_T_HANDOVER_AT]) {
            bump("shipments_dispatched");
        }
        if in_range(s.t[SHIP_T_DELIVERED_AT]) {
            bump("shipments_delivered");
        }
    }
    for r in st.ids(Kind::Return).iter().filter_map(|i| st.rec(Kind::Return, *i)) {
        if in_range(r.t[RET_T_APPROVED_AT]) {
            bump("returns_approved");
        }
        if in_range(r.t[RET_T_RECEIVED_AT]) {
            bump("returns_received");
        }
    }
    let mut counts_map = Map::new();
    for (k, v) in counts {
        counts_map.insert(k.to_string(), json!(v));
    }
    Summary {
        kind: "thirty_day_summary".into(),
        from,
        to,
        totals,
        counts: counts_map,
        time_semantics: "effective business time (occurred_at of the recording event); integer minor units per ISO currency; currencies are never summed together".into(),
    }
}
