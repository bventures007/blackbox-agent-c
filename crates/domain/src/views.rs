//! Typed read views over `TenantState`. The order view returns exactly the key set named in
//! packages/contracts/engine-rpc.json (matching the golden checkpoint keys).

use crate::entry::{EntrySummary, Track};
use crate::reducer::RES_ST_ACTIVE_COVERED;
use crate::state::fields::*;
use crate::state::*;
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

/// Golden-key order state. `None` values mean "unknown/not applicable" (never silently zero).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrderState {
    pub physical_stock: Option<Decimal>,
    pub reserved_stock: Option<Decimal>,
    pub quarantined_stock: Option<Decimal>,
    pub available_stock: Option<Decimal>,
    pub authorized_minor: i64,
    pub captured_minor: i64,
    pub fees_minor: i64,
    pub refunded_minor: i64,
    pub refund_payable_minor: i64,
    pub invoice_original_minor: i64,
    pub invoice_credit_minor: i64,
    pub invoice_net_minor: i64,
    pub open_receivable_minor: i64,
    pub customer_net_paid_minor: i64,
    pub provider_balance_minor: i64,
    pub provider_held_minor: i64,
    pub provider_available_minor: i64,
    pub payout_announced_minor: i64,
    pub in_transit_minor: i64,
    pub bank_confirmed_minor: i64,
    pub shipment_status: Option<String>,
    pub currency: Option<String>,
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Coverage {
    pub datasets_present: Vec<String>,
    pub datasets_missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictView {
    pub case_id: String,
    pub reason: String,
    pub entry_id: Uuid,
    pub related_entry_id: Option<Uuid>,
}

/// Datasets a complete order-to-cash view would draw from.
pub const ORDER_DATASETS: &[&str] = &[
    "orders",
    "stock",
    "allocations",
    "invoices",
    "payments",
    "provider_ledger",
    "fulfillments",
    "returns",
    "receipts",
    "refunds",
    "payouts",
    "bank",
];

pub fn ship_status_str(s: u8) -> &'static str {
    match s {
        SHIP_ST_OBSERVED => "observed",
        SHIP_ST_DISPATCHED => "dispatched",
        SHIP_ST_IN_TRANSIT => "in_transit",
        SHIP_ST_EXCEPTION => "exception",
        SHIP_ST_DELIVERED => "delivered",
        SHIP_ST_CANCELLED => "cancelled",
        _ => "unknown",
    }
}

/// Available quantity of an item under the documented rule:
/// authoritative provider available (if snapshotted) else physical − quarantined − committed −
/// damaged − safety − quality_control − snapshot reserved; then minus active reservations that
/// occurred after the snapshot basis. Returns None without a stock basis.
pub fn item_available(item: &Rec) -> Option<Decimal> {
    if item.status == ITEM_ST_NO_BASIS {
        return None;
    }
    let base = if item.status == ITEM_ST_BASIS_WITH_PROVIDER_AVAILABLE {
        item.q[ITEM_Q_PROVIDER_AVAILABLE]
    } else {
        item.q[ITEM_Q_PHYSICAL]
            - item.q[ITEM_Q_QUARANTINED]
            - item.q[ITEM_Q_COMMITTED]
            - item.q[ITEM_Q_DAMAGED]
            - item.q[ITEM_Q_SAFETY]
            - item.q[ITEM_Q_QUALITY_CONTROL]
            - item.q[ITEM_Q_SNAPSHOT_RESERVED]
    };
    Some(base - item.q[ITEM_Q_RESERVED_ACTIVE])
}

pub fn item_reserved(item: &Rec) -> Decimal {
    item.q[ITEM_Q_SNAPSHOT_RESERVED] + item.q[ITEM_Q_RESERVED_ACTIVE]
}

struct Money {
    currency: Sym,
    conflict: bool,
}

impl Money {
    fn take(&mut self, cur: Sym) -> bool {
        if cur == NONE {
            return true;
        }
        if self.currency == NONE {
            self.currency = cur;
            true
        } else if self.currency != cur {
            self.conflict = true;
            false
        } else {
            true
        }
    }
}

pub struct OrderView {
    pub state: OrderState,
    pub currency_conflict: bool,
    pub entities: Vec<RecKey>,
}

pub fn order_view(st: &TenantState, order: Sym) -> Option<OrderView> {
    let o = st.rec(Kind::Order, order)?;
    let mut money = Money {
        currency: o.s[ORDER_S_CURRENCY],
        conflict: false,
    };
    let mut entities = vec![RecKey::new(Kind::Order, order)];
    let mut s = OrderState {
        physical_stock: None,
        reserved_stock: None,
        quarantined_stock: None,
        available_stock: None,
        authorized_minor: 0,
        captured_minor: 0,
        fees_minor: 0,
        refunded_minor: 0,
        refund_payable_minor: 0,
        invoice_original_minor: 0,
        invoice_credit_minor: 0,
        invoice_net_minor: 0,
        open_receivable_minor: 0,
        customer_net_paid_minor: 0,
        provider_balance_minor: 0,
        provider_held_minor: 0,
        provider_available_minor: 0,
        payout_announced_minor: 0,
        in_transit_minor: 0,
        bank_confirmed_minor: 0,
        shipment_status: None,
        currency: None,
        unit: None,
    };

    // Stock: items linked to the order (single item, or same-unit aggregation).
    let items: Vec<Sym> = o.linked(Kind::Item).collect();
    let mut unit = o.s[ORDER_S_UNIT];
    let mut any_basis = false;
    let mut unit_conflict = false;
    let (mut phys, mut res, mut quar, mut avail) =
        (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO, Decimal::ZERO);
    for i in &items {
        if let Some(item) = st.rec(Kind::Item, *i) {
            entities.push(RecKey::new(Kind::Item, *i));
            if item.s[ITEM_S_UNIT] != NONE {
                if unit == NONE {
                    unit = item.s[ITEM_S_UNIT];
                } else if unit != item.s[ITEM_S_UNIT] {
                    unit_conflict = true;
                }
            }
            if let Some(a) = item_available(item) {
                any_basis = true;
                phys += item.q[ITEM_Q_PHYSICAL];
                quar += item.q[ITEM_Q_QUARANTINED];
                res += item_reserved(item);
                avail += a;
            }
        }
    }
    if any_basis && !unit_conflict {
        s.physical_stock = Some(phys);
        s.reserved_stock = Some(res);
        s.quarantined_stock = Some(quar);
        s.available_stock = Some(avail);
    }
    s.unit = st.sym_opt(unit).map(|u| u.to_string());

    // Payments.
    let mut held = 0i64;
    let mut cb_net = 0i64;
    for t in o.linked(Kind::Transaction) {
        if let Some(tx) = st.rec(Kind::Transaction, t) {
            entities.push(RecKey::new(Kind::Transaction, t));
            if !money.take(tx.s[TX_S_CURRENCY]) {
                continue;
            }
            if tx.status != TX_ST_VOIDED {
                s.authorized_minor += tx.m[TX_M_AUTHORIZED] - tx.m[TX_M_VOIDED];
            }
            s.captured_minor += tx.m[TX_M_CAPTURED];
            s.fees_minor += tx.m[TX_M_FEES];
            s.refunded_minor += tx.m[TX_M_REFUNDED];
            held += tx.m[TX_M_HELD];
            cb_net += tx.m[TX_M_CB_DEBIT] + tx.m[TX_M_CB_FEE] - tx.m[TX_M_CB_REVERSED];
        }
    }
    // Invoices.
    let mut reported_paid = 0i64;
    for i in o.linked(Kind::Invoice) {
        if let Some(inv) = st.rec(Kind::Invoice, i) {
            entities.push(RecKey::new(Kind::Invoice, i));
            if !money.take(inv.s[INV_S_CURRENCY]) {
                continue;
            }
            if inv.status == INV_ST_CANCELLED || inv.status == INV_ST_DRAFT {
                continue;
            }
            s.invoice_original_minor += inv.m[INV_M_GROSS];
            s.invoice_credit_minor += inv.m[INV_M_CREDIT];
            reported_paid += inv.m[INV_M_REPORTED_PAID];
        }
    }
    s.invoice_net_minor = s.invoice_original_minor - s.invoice_credit_minor;
    s.open_receivable_minor = (s.invoice_net_minor - reported_paid).max(0);
    let overpaid = (reported_paid - s.invoice_net_minor).max(0);
    s.refund_payable_minor = (overpaid - s.refunded_minor).max(0);
    s.customer_net_paid_minor = s.captured_minor - s.refunded_minor;

    // Payouts linked to this order.
    let mut payout_sent = 0i64;
    for p in o.linked(Kind::Payout) {
        if let Some(po) = st.rec(Kind::Payout, p) {
            entities.push(RecKey::new(Kind::Payout, p));
            if !money.take(po.s[PO_S_CURRENCY]) {
                continue;
            }
            match po.status {
                PO_ST_ANNOUNCED => s.payout_announced_minor += po.m[PO_M_AMOUNT],
                PO_ST_SENT => {
                    payout_sent += po.m[PO_M_AMOUNT];
                    s.bank_confirmed_minor += po.m[PO_M_BANK_CONFIRMED];
                    s.in_transit_minor += po.m[PO_M_AMOUNT] - po.m[PO_M_BANK_CONFIRMED];
                }
                _ => {}
            }
        }
    }
    for b in o.linked(Kind::BankEntry) {
        entities.push(RecKey::new(Kind::BankEntry, b));
    }
    s.provider_balance_minor =
        s.captured_minor - s.fees_minor - s.refunded_minor - payout_sent - cb_net;
    s.provider_held_minor = held;
    s.provider_available_minor = s.provider_balance_minor - held - s.payout_announced_minor;

    // Shipments: status of the most recently progressed shipment.
    let mut best: Option<(i64, u8)> = None;
    for sh in o.linked(Kind::Shipment) {
        if let Some(ship) = st.rec(Kind::Shipment, sh) {
            entities.push(RecKey::new(Kind::Shipment, sh));
            let t = ship.t[SHIP_T_DELIVERED_AT]
                .max(ship.t[SHIP_T_LAST_SCAN_AT])
                .max(ship.t[SHIP_T_HANDOVER_AT]);
            let key = (t, ship.status);
            if best.map(|b| key > b).unwrap_or(true) {
                best = Some(key);
            }
        }
    }
    s.shipment_status = best.map(|(_, st)| ship_status_str(st).to_string());
    for r in o.linked(Kind::Return) {
        entities.push(RecKey::new(Kind::Return, r));
    }
    for r in o.linked(Kind::Refund) {
        entities.push(RecKey::new(Kind::Refund, r));
    }
    for r in o.linked(Kind::Reservation) {
        entities.push(RecKey::new(Kind::Reservation, r));
    }
    for r in o.linked(Kind::Line) {
        entities.push(RecKey::new(Kind::Line, r));
    }
    for r in o.linked(Kind::Credit) {
        entities.push(RecKey::new(Kind::Credit, r));
    }
    for r in o.linked(Kind::Customer) {
        entities.push(RecKey::new(Kind::Customer, r));
    }
    s.currency = st.sym_opt(money.currency).map(|c| c.to_string());
    Some(OrderView {
        state: s,
        currency_conflict: money.conflict,
        entities,
    })
}

/// Coverage over the datasets relevant for a kind.
pub fn coverage_for(st: &TenantState, datasets: &[&str]) -> Coverage {
    let mut c = Coverage::default();
    for d in datasets {
        if st.dataset_present(d) {
            c.datasets_present.push((*d).to_string());
        } else {
            c.datasets_missing.push((*d).to_string());
        }
    }
    c
}

pub fn conflicts_for(st: &TenantState, entities: &[RecKey]) -> Vec<ConflictView> {
    // Membership through a set: conflicts × touched entities was quadratic for tenant-wide intents.
    let set: std::collections::HashSet<RecKey> = entities.iter().copied().collect();
    st.conflicts
        .iter()
        .filter(|c| c.entities.iter().any(|(k, i)| set.contains(&RecKey::new(*k, *i))))
        .map(|c| ConflictView {
            case_id: c.case_id.clone(),
            reason: c.reason.clone(),
            entry_id: c.entry_id,
            related_entry_id: c.related_entry_id,
        })
        .collect()
}

/// History locators of the given entities, merged, deduplicated and ordered by sequence.
pub fn merged_history(st: &TenantState, entities: &[RecKey]) -> Vec<EntryLoc> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for k in entities {
        for l in st.history_of(k.kind, k.id) {
            if seen.insert(l.entry_id) {
                out.push(*l);
            }
        }
    }
    out.sort_by_key(|l| l.seq);
    out
}

pub fn summary_of(st: &TenantState, loc: &EntryLoc) -> EntrySummary {
    let meta = st.entries.get(&loc.entry_id);
    EntrySummary {
        entry_id: loc.entry_id,
        journal_sequence: loc.seq,
        track: Track::from_index(loc.track),
        record_id: st.sym(loc.record_id).to_string(),
        event_type: st.sym(loc.event).to_string(),
        occurred_at: ms_to_time(loc.occurred_ms).unwrap_or(DateTime::<Utc>::UNIX_EPOCH),
        recorded_at: ms_to_time(loc.recorded_ms).unwrap_or(DateTime::<Utc>::UNIX_EPOCH),
        supersedes_entry_id: meta.and_then(|m| m.supersedes),
        superseded_by: meta.and_then(|m| m.superseded_by),
        effect: effect_str(meta.map(|m| m.effect).unwrap_or(loc.effect)).to_string(),
    }
}

/// Five track views (bounded to the latest `per_track` summaries per track).
pub fn track_views(st: &TenantState, entities: &[RecKey], per_track: usize) -> Map<String, Value> {
    let hist = merged_history(st, entities);
    let mut out = Map::new();
    for t in Track::ALL {
        let all: Vec<&EntryLoc> = hist.iter().filter(|l| l.track == t.index() as u8).collect();
        let truncated = all.len() > per_track;
        let slice: Vec<Value> = all
            .iter()
            .rev()
            .take(per_track)
            .rev()
            .map(|l| serde_json::to_value(summary_of(st, l)).unwrap_or(Value::Null))
            .collect();
        out.insert(
            t.as_str().to_string(),
            json!({"entries": slice, "total": all.len(), "truncated": truncated}),
        );
    }
    out
}

fn ms_json(ms: i64) -> Value {
    match ms_to_time(ms) {
        Some(t) => Value::String(t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        None => Value::Null,
    }
}

fn sym_json(st: &TenantState, s: Sym) -> Value {
    match st.sym_opt(s) {
        Some(v) => Value::String(v.to_string()),
        None => Value::Null,
    }
}

fn dec_json(d: Decimal) -> Value {
    Value::String(d.normalize().to_string())
}

/// Typed JSON view of any record kind.
pub fn record_view(st: &TenantState, r: &Rec) -> Value {
    let id = st.sym(r.id);
    let links: Vec<Value> = r
        .links
        .iter()
        .map(|(k, i)| json!({"type": k.as_str(), "id": st.sym(*i)}))
        .collect();
    let mut v = match r.kind {
        Kind::Order => json!({
            "order_id": id,
            "status": match r.status { ORDER_ST_ACCEPTED => "accepted", ORDER_ST_CANCELLED => "cancelled", ORDER_ST_PARTIALLY_CANCELLED => "partially_cancelled", _ => "unknown" },
            "customer_id": sym_json(st, r.s[ORDER_S_CUSTOMER]),
            "currency": sym_json(st, r.s[ORDER_S_CURRENCY]),
            "unit": sym_json(st, r.s[ORDER_S_UNIT]),
            "gross_minor": r.m[ORDER_M_GROSS],
            "quantity": dec_json(r.q[ORDER_Q_QUANTITY]),
            "cancelled_quantity": dec_json(r.q[ORDER_Q_CANCELLED]),
            "dispatched_quantity": dec_json(r.q[ORDER_Q_DISPATCHED]),
            "delivered_quantity": dec_json(r.q[ORDER_Q_DELIVERED]),
            "accepted_at": ms_json(r.t[ORDER_T_ACCEPTED_AT]),
            "cancelled_at": ms_json(r.t[ORDER_T_CANCELLED_AT]),
        }),
        Kind::Line => json!({
            "line_id": id,
            "order_id": sym_json(st, r.s[LINE_S_ORDER]),
            "item_id": sym_json(st, r.s[LINE_S_ITEM]),
            "unit": sym_json(st, r.s[LINE_S_UNIT]),
            "currency": sym_json(st, r.s[LINE_S_CURRENCY]),
            "quantity": dec_json(r.q[LINE_Q_QUANTITY]),
            "cancelled_quantity": dec_json(r.q[LINE_Q_CANCELLED]),
            "dispatched_quantity": dec_json(r.q[LINE_Q_DISPATCHED]),
            "delivered_quantity": dec_json(r.q[LINE_Q_DELIVERED]),
            "invoiced_quantity": dec_json(r.q[LINE_Q_INVOICED]),
            "gross_minor": r.m[LINE_M_GROSS],
            "unit_gross_minor": r.m[LINE_M_UNIT_GROSS],
        }),
        Kind::Item => {
            let avail = item_available(r);
            json!({
                "item_id": id,
                "unit": sym_json(st, r.s[ITEM_S_UNIT]),
                "location_id": sym_json(st, r.s[ITEM_S_LOCATION]),
                "stock_basis": r.status != ITEM_ST_NO_BASIS,
                "basis_at": ms_json(r.t[ITEM_T_BASIS_AT]),
                "physical": if r.status == ITEM_ST_NO_BASIS { Value::Null } else { dec_json(r.q[ITEM_Q_PHYSICAL]) },
                "quarantined": if r.status == ITEM_ST_NO_BASIS { Value::Null } else { dec_json(r.q[ITEM_Q_QUARANTINED]) },
                "reserved": dec_json(item_reserved(r)),
                "reserved_active_after_basis": dec_json(r.q[ITEM_Q_RESERVED_ACTIVE]),
                "committed": dec_json(r.q[ITEM_Q_COMMITTED]),
                "damaged": dec_json(r.q[ITEM_Q_DAMAGED]),
                "safety_stock": dec_json(r.q[ITEM_Q_SAFETY]),
                "quality_control": dec_json(r.q[ITEM_Q_QUALITY_CONTROL]),
                "incoming_reported": dec_json(r.q[ITEM_Q_INCOMING]),
                "provider_available": if r.status == ITEM_ST_BASIS_WITH_PROVIDER_AVAILABLE { dec_json(r.q[ITEM_Q_PROVIDER_AVAILABLE]) } else { Value::Null },
                "available": avail.map(dec_json).unwrap_or(Value::Null),
            })
        }
        Kind::Reservation => json!({
            "reservation_id": id,
            "status": match r.status { RES_ST_ACTIVE => "active", RES_ST_ACTIVE_COVERED => "active_covered_by_snapshot", RES_ST_RELEASED => "released", _ => "unknown" },
            "item_id": sym_json(st, r.s[RES_S_ITEM]),
            "order_id": sym_json(st, r.s[RES_S_ORDER]),
            "line_id": sym_json(st, r.s[RES_S_LINE]),
            "unit": sym_json(st, r.s[RES_S_UNIT]),
            "quantity": dec_json(r.q[RES_Q_QUANTITY]),
            "released_quantity": dec_json(r.q[RES_Q_RELEASED]),
            "occurred_at": ms_json(r.t[RES_T_OCCURRED_AT]),
        }),
        Kind::Invoice => json!({
            "invoice_id": id,
            "status": match r.status { INV_ST_ISSUED => "issued", INV_ST_CANCELLED => "cancelled", INV_ST_DRAFT => "draft", _ => "unknown" },
            "order_id": sym_json(st, r.s[INV_S_ORDER]),
            "customer_id": sym_json(st, r.s[INV_S_CUSTOMER]),
            "currency": sym_json(st, r.s[INV_S_CURRENCY]),
            "gross_minor": r.m[INV_M_GROSS],
            "credit_minor": r.m[INV_M_CREDIT],
            "net_minor": r.m[INV_M_GROSS] - r.m[INV_M_CREDIT],
            "reported_paid_minor": r.m[INV_M_REPORTED_PAID],
            "allocated_paid_minor": r.m[INV_M_ALLOCATED],
            "reported_open_minor": (r.m[INV_M_GROSS] - r.m[INV_M_CREDIT] - r.m[INV_M_REPORTED_PAID]).max(0),
            "credit_balance_minor": (r.m[INV_M_REPORTED_PAID] - (r.m[INV_M_GROSS] - r.m[INV_M_CREDIT])).max(0),
            "due_date": ms_json(r.t[INV_T_DUE_DATE]),
            "issued_at": ms_json(r.t[INV_T_ISSUED_AT]),
        }),
        Kind::Credit => json!({
            "credit_id": id,
            "status": match r.status { CREDIT_ST_ISSUED => "issued", CREDIT_ST_CASH_REFUND_CONFIRMED => "issued_cash_refund_confirmed", CREDIT_ST_CANCELLED => "cancelled", _ => "unknown" },
            "invoice_id": sym_json(st, r.s[CREDIT_S_INVOICE]),
            "order_id": sym_json(st, r.s[CREDIT_S_ORDER]),
            "currency": sym_json(st, r.s[CREDIT_S_CURRENCY]),
            "amount_minor": r.m[CREDIT_M_AMOUNT],
            "issued_at": ms_json(r.t[CREDIT_T_ISSUED_AT]),
        }),
        Kind::Transaction => json!({
            "transaction_id": id,
            "status": match r.status { TX_ST_AUTHORIZED => "authorized", TX_ST_CAPTURED => "captured", TX_ST_FAILED => "failed", TX_ST_VOIDED => "voided", _ => "unknown" },
            "order_id": sym_json(st, r.s[TX_S_ORDER]),
            "account_id": sym_json(st, r.s[TX_S_ACCOUNT]),
            "currency": sym_json(st, r.s[TX_S_CURRENCY]),
            "original_transaction_id": sym_json(st, r.s[TX_S_ORIGINAL]),
            "gateway": sym_json(st, r.s[TX_S_GATEWAY]),
            "authorized_minor": r.m[TX_M_AUTHORIZED],
            "captured_minor": r.m[TX_M_CAPTURED],
            "fees_minor": r.m[TX_M_FEES],
            "refunded_minor": r.m[TX_M_REFUNDED],
            "refund_pending_minor": r.m[TX_M_REFUND_PENDING],
            "held_minor": r.m[TX_M_HELD],
            "chargeback_debit_minor": r.m[TX_M_CB_DEBIT],
            "chargeback_fee_minor": r.m[TX_M_CB_FEE],
            "chargeback_reversed_minor": r.m[TX_M_CB_REVERSED],
            "voided_minor": r.m[TX_M_VOIDED],
            "failed_attempts": r.m[TX_M_FAILED_ATTEMPTS],
            "occurred_at": ms_json(r.t[TX_T_OCCURRED_AT]),
            "captured_at": ms_json(r.t[TX_T_CAPTURED_AT]),
        }),
        Kind::Attempt => json!({
            "attempt_id": id,
            "status": match r.status { ATT_ST_FAILED => "failed", ATT_ST_VOIDED => "voided", _ => "unknown" },
            "transaction_id": sym_json(st, r.s[ATT_S_TRANSACTION]),
            "order_id": sym_json(st, r.s[ATT_S_ORDER]),
            "currency": sym_json(st, r.s[ATT_S_CURRENCY]),
            "reason": sym_json(st, r.s[ATT_S_REASON]),
            "amount_minor": r.m[ATT_M_AMOUNT],
            "occurred_at": ms_json(r.t[ATT_T_OCCURRED_AT]),
        }),
        Kind::Refund => json!({
            "refund_id": id,
            "status": match r.status { RF_ST_PENDING => "pending", RF_ST_COMPLETED => "completed", RF_ST_FAILED => "failed", RF_ST_REVERSED => "reversed", _ => "unknown" },
            "transaction_id": sym_json(st, r.s[RF_S_TRANSACTION]),
            "order_id": sym_json(st, r.s[RF_S_ORDER]),
            "currency": sym_json(st, r.s[RF_S_CURRENCY]),
            "destination": sym_json(st, r.s[RF_S_DESTINATION]),
            "amount_minor": r.m[RF_M_AMOUNT],
            "held_minor": r.m[RF_M_HELD],
            "occurred_at": ms_json(r.t[RF_T_OCCURRED_AT]),
        }),
        Kind::Payout => json!({
            "payout_id": id,
            "status": match r.status { PO_ST_ANNOUNCED => "announced", PO_ST_SENT => "sent", PO_ST_FAILED => "failed", PO_ST_REVERSED => "reversed", _ => "unknown" },
            "account_id": sym_json(st, r.s[PO_S_ACCOUNT]),
            "currency": sym_json(st, r.s[PO_S_CURRENCY]),
            "trace_reference": sym_json(st, r.s[PO_S_TRACE]),
            "amount_minor": r.m[PO_M_AMOUNT],
            "bank_confirmed_minor": r.m[PO_M_BANK_CONFIRMED],
            "in_transit_minor": if r.status == PO_ST_SENT { r.m[PO_M_AMOUNT] - r.m[PO_M_BANK_CONFIRMED] } else { 0 },
            "member_captures_minor": r.m[PO_M_MEMBER_CAPTURES],
            "member_fees_minor": r.m[PO_M_MEMBER_FEES],
            "member_refunds_minor": r.m[PO_M_MEMBER_REFUNDS],
            "member_other_minor": r.m[PO_M_MEMBER_OTHER],
            "announced_at": ms_json(r.t[PO_T_ANNOUNCED_AT]),
            "sent_at": ms_json(r.t[PO_T_SENT_AT]),
        }),
        Kind::BankEntry => json!({
            "bank_entry_id": id,
            "status": match r.status { BANK_ST_CREDIT_BOOKED => "credit_booked_unmatched", BANK_ST_CREDIT_MATCHED => "credit_booked_matched", BANK_ST_DEBIT_BOOKED => "debit_booked", BANK_ST_PENDING => "pending", _ => "unknown" },
            "payout_id": sym_json(st, r.s[BANK_S_PAYOUT]),
            "bank_account": sym_json(st, r.s[BANK_S_ACCOUNT]),
            "currency": sym_json(st, r.s[BANK_S_CURRENCY]),
            "reference": sym_json(st, r.s[BANK_S_REFERENCE]),
            "amount_minor": r.m[BANK_M_AMOUNT],
            "booked_at": ms_json(r.t[BANK_T_BOOKED_AT]),
        }),
        Kind::Shipment => json!({
            "shipment_id": id,
            "status": ship_status_str(r.status),
            "order_id": sym_json(st, r.s[SHIP_S_ORDER]),
            "line_id": sym_json(st, r.s[SHIP_S_LINE]),
            "item_id": sym_json(st, r.s[SHIP_S_ITEM]),
            "carrier": sym_json(st, r.s[SHIP_S_CARRIER]),
            "tracking_number": sym_json(st, r.s[SHIP_S_TRACKING]),
            "last_scan_code": sym_json(st, r.s[SHIP_S_LAST_SCAN_CODE]),
            "quantity": dec_json(r.q[SHIP_Q_QUANTITY]),
            "delivered_quantity": dec_json(r.q[SHIP_Q_DELIVERED]),
            "handover_at": ms_json(r.t[SHIP_T_HANDOVER_AT]),
            "delivered_at": ms_json(r.t[SHIP_T_DELIVERED_AT]),
            "last_scan_at": ms_json(r.t[SHIP_T_LAST_SCAN_AT]),
            "forecast_at": ms_json(r.t[SHIP_T_FORECAST_AT]),
        }),
        Kind::Return => json!({
            "return_id": id,
            "status": match r.status { RET_ST_APPROVED => "approved", RET_ST_CANCELLED => "cancelled", RET_ST_RECEIVED => "received", RET_ST_RESTOCKED => "restocked", _ => "unknown" },
            "order_id": sym_json(st, r.s[RET_S_ORDER]),
            "line_id": sym_json(st, r.s[RET_S_LINE]),
            "item_id": sym_json(st, r.s[RET_S_ITEM]),
            "currency": sym_json(st, r.s[RET_S_CURRENCY]),
            "unit": sym_json(st, r.s[RET_S_UNIT]),
            "disposition": sym_json(st, r.s[RET_S_DISPOSITION]),
            "requested_quantity": dec_json(r.q[RET_Q_REQUESTED]),
            "received_quantity": dec_json(r.q[RET_Q_RECEIVED]),
            "quarantined_quantity": dec_json(r.q[RET_Q_QUARANTINED]),
            "restocked_quantity": dec_json(r.q[RET_Q_RESTOCKED]),
            "expected_credit_minor": r.m[RET_M_EXPECTED_CREDIT],
            "approved_at": ms_json(r.t[RET_T_APPROVED_AT]),
            "received_at": ms_json(r.t[RET_T_RECEIVED_AT]),
        }),
        Kind::Hold => json!({
            "hold_id": id,
            "status": match r.status { HOLD_ST_ACTIVE => "active", HOLD_ST_RELEASED => "released", _ => "unknown" },
            "account_id": sym_json(st, r.s[HOLD_S_ACCOUNT]),
            "transaction_id": sym_json(st, r.s[HOLD_S_TRANSACTION]),
            "currency": sym_json(st, r.s[HOLD_S_CURRENCY]),
            "reason": sym_json(st, r.s[HOLD_S_REASON]),
            "amount_minor": r.m[HOLD_M_AMOUNT],
            "released_minor": r.m[HOLD_M_RELEASED],
            "held_minor": r.m[HOLD_M_AMOUNT] - r.m[HOLD_M_RELEASED],
            "release_promised_at": ms_json(r.t[HOLD_T_RELEASE_PROMISED_AT]),
            "released_at": ms_json(r.t[HOLD_T_RELEASED_AT]),
        }),
        Kind::Dispute => json!({
            "dispute_id": id,
            "status": match r.status { DISP_ST_OPEN => "open", DISP_ST_RESOLVED => "resolved", _ => "unknown" },
            "transaction_id": sym_json(st, r.s[DISP_S_TRANSACTION]),
            "order_id": sym_json(st, r.s[DISP_S_ORDER]),
            "currency": sym_json(st, r.s[DISP_S_CURRENCY]),
            "outcome": sym_json(st, r.s[DISP_S_OUTCOME]),
            "amount_minor": r.m[DISP_M_AMOUNT],
            "debit_minor": r.m[DISP_M_DEBIT],
            "reversed_minor": r.m[DISP_M_REVERSED],
            "fee_minor": r.m[DISP_M_FEE],
            "opened_at": ms_json(r.t[DISP_T_OPENED_AT]),
        }),
        Kind::Promise => json!({
            "promise_id": id,
            "status": match r.status { PROM_ST_ACTIVE => "active", PROM_ST_WITHDRAWN => "withdrawn", _ => "unknown" },
            "order_id": sym_json(st, r.s[PROM_S_ORDER]),
            "line_id": sym_json(st, r.s[PROM_S_LINE]),
            "customer_id": sym_json(st, r.s[PROM_S_CUSTOMER]),
            "promise_kind": sym_json(st, r.s[PROM_S_KIND]),
            "timezone": sym_json(st, r.s[PROM_S_TIMEZONE]),
            "promised_at": ms_json(r.t[PROM_T_PROMISED_AT]),
            "previous_promised_at": ms_json(r.t[PROM_T_PREVIOUS_PROMISED_AT]),
            "revision": r.m[PROM_M_REVISION],
        }),
        Kind::Supply => json!({
            "promise_id": id,
            "status": match r.status { SUP_ST_ACTIVE => "active", SUP_ST_RECEIVED => "received", SUP_ST_CANCELLED => "cancelled", _ => "unknown" },
            "item_id": sym_json(st, r.s[SUP_S_ITEM]),
            "supplier_id": sym_json(st, r.s[SUP_S_SUPPLIER]),
            "unit": sym_json(st, r.s[SUP_S_UNIT]),
            "location_id": sym_json(st, r.s[SUP_S_LOCATION]),
            "quantity": dec_json(r.q[SUP_Q_QUANTITY]),
            "promised_at": ms_json(r.t[SUP_T_PROMISED_AT]),
            "previous_promised_at": ms_json(r.t[SUP_T_PREVIOUS_PROMISED_AT]),
            "revision": r.m[SUP_M_REVISION],
            "allocated_orders": r.linked(Kind::Order).map(|o| Value::String(st.sym(o).to_string())).collect::<Vec<_>>(),
        }),
        Kind::Policy => json!({
            "rule_id": id,
            "rule_kind": sym_json(st, r.s[POL_S_KIND]),
            "priority_method": sym_json(st, r.s[POL_S_PRIORITY_METHOD]),
            "invoicing_trigger": sym_json(st, r.s[POL_S_INVOICING_TRIGGER]),
            "reminder_policy": sym_json(st, r.s[POL_S_REMINDER_POLICY]),
            "attention_rule": sym_json(st, r.s[POL_S_ATTENTION_RULE]),
            "timezone": sym_json(st, r.s[POL_S_TIMEZONE]),
            "currency": sym_json(st, r.s[POL_S_CURRENCY]),
            "scope": sym_json(st, r.s[POL_S_SCOPE]),
            "tolerance_minor": r.m[POL_M_TOLERANCE],
            "stale_scan_seconds": r.m[POL_M_STALE_SCAN_SECONDS],
            "risk_hours": r.m[POL_M_RISK_HOURS],
            "version": r.m[POL_M_VERSION],
            "effective_from": ms_json(r.t[POL_T_EFFECTIVE_FROM]),
        }),
        Kind::Case => json!({
            "case_id": id,
            "status": sym_json(st, r.s[CASE_S_STATUS]),
            "open": r.status == CASE_ST_OPEN,
            "customer_id": sym_json(st, r.s[CASE_S_CUSTOMER]),
            "invoice_id": sym_json(st, r.s[CASE_S_INVOICE]),
            "transaction_id": sym_json(st, r.s[CASE_S_TRANSACTION]),
            "order_id": sym_json(st, r.s[CASE_S_ORDER]),
            "agreed_extension_until": ms_json(r.t[CASE_T_EXTENSION_UNTIL]),
        }),
        Kind::Link => json!({
            "link_id": id,
            "status": match r.status { LINK_ST_RECORDED => "recorded", LINK_ST_CONFLICT => "conflict", LINK_ST_REVISED => "revised", _ => "unknown" },
            "entity_type": sym_json(st, r.s[LINK_S_ENTITY_TYPE]),
            "entity_id": sym_json(st, r.s[LINK_S_ENTITY_ID]),
            "external_id": sym_json(st, r.s[LINK_S_EXTERNAL_ID]),
            "target_id": sym_json(st, r.s[LINK_S_TARGET]),
            "relationship_type": sym_json(st, r.s[LINK_S_RELATIONSHIP]),
            "connection": sym_json(st, r.s[LINK_S_CONNECTION]),
            "confidence": sym_json(st, r.s[LINK_S_CONFIDENCE]),
        }),
        Kind::Coverage => json!({
            "coverage_id": id,
            "status": match r.status { COV_ST_COMPLETE => "backfill_complete", COV_ST_INCOMPLETE => "incomplete", COV_ST_GAP => "gap", _ => "unknown" },
            "connection": sym_json(st, r.s[COV_S_CONNECTION]),
            "capability": sym_json(st, r.s[COV_S_CAPABILITY]),
            "entity_scope": sym_json(st, r.s[COV_S_ENTITY_SCOPE]),
            "history_start": ms_json(r.t[COV_T_HISTORY_START]),
            "complete_through": ms_json(r.t[COV_T_COMPLETE_THROUGH]),
        }),
        Kind::Communication => json!({
            "message_id": id,
            "status": match r.status { COM_ST_OBSERVED => "observed", COM_ST_REVIEWED => "reviewed", _ => "unknown" },
            "customer_id": sym_json(st, r.s[COM_S_CUSTOMER]),
            "order_id": sym_json(st, r.s[COM_S_ORDER]),
            "actor": sym_json(st, r.s[COM_S_ACTOR]),
            "summary": sym_json(st, r.s[COM_S_SUMMARY]),
            "sent_at": ms_json(r.t[COM_T_SENT_AT]),
        }),
        Kind::Dispatch => json!({
            "dispatch_id": id,
            "status": match r.status { DSP_ST_OK => "provider_reported_sent", DSP_ST_PENDING => "pending", DSP_ST_ERROR => "error", _ => "unknown" },
            "provider_status": sym_json(st, r.s[DSP_S_STATUS]),
            "invoice_id": sym_json(st, r.s[DSP_S_INVOICE]),
            "channel": sym_json(st, r.s[DSP_S_CHANNEL]),
            "processed_at": ms_json(r.t[DSP_T_PROCESSED_AT]),
        }),
        Kind::Entitlement => json!({
            "entitlement_id": id,
            "status": match r.status { ENT_ST_APPROVED => "approved", ENT_ST_VOID => "void", _ => "unknown" },
            "order_id": sym_json(st, r.s[ENT_S_ORDER]),
            "invoice_id": sym_json(st, r.s[ENT_S_INVOICE]),
            "credit_id": sym_json(st, r.s[ENT_S_CREDIT]),
            "original_transaction_id": sym_json(st, r.s[ENT_S_TRANSACTION]),
            "currency": sym_json(st, r.s[ENT_S_CURRENCY]),
            "destination": sym_json(st, r.s[ENT_S_DESTINATION]),
            "amount_minor": r.m[ENT_M_AMOUNT],
            "approved_at": ms_json(r.t[ENT_T_APPROVED_AT]),
        }),
        Kind::Allocation => json!({
            "allocation_id": id,
            "status": match r.status { ALLOC_ST_RECORDED => "recorded", ALLOC_ST_REVISED => "revised", _ => "unknown" },
            "invoice_id": sym_json(st, r.s[ALLOC_S_INVOICE]),
            "transaction_id": sym_json(st, r.s[ALLOC_S_TRANSACTION]),
            "currency": sym_json(st, r.s[ALLOC_S_CURRENCY]),
            "confidence": sym_json(st, r.s[ALLOC_S_CONFIDENCE]),
            "amount_minor": r.m[ALLOC_M_AMOUNT],
        }),
        Kind::Account => {
            let obs = r.status == ACC_ST_OBSERVED;
            let obs_val = |slot: usize| -> Value {
                if obs && r.m[slot] != i64::MIN {
                    json!(r.m[slot])
                } else {
                    Value::Null
                }
            };
            json!({
                "account_id": id,
                "account_ref": sym_json(st, r.s[ACC_S_ACCOUNT_REF]),
                "currency": sym_json(st, r.s[ACC_S_CURRENCY]),
                "captured_minor": r.m[ACC_M_CAPTURED],
                "fees_minor": r.m[ACC_M_FEES],
                "refunded_minor": r.m[ACC_M_REFUNDED],
                "held_minor": r.m[ACC_M_HELD],
                "payout_announced_minor": r.m[ACC_M_ANNOUNCED],
                "in_transit_minor": r.m[ACC_M_IN_TRANSIT],
                "bank_confirmed_minor": r.m[ACC_M_BANK_CONFIRMED],
                "chargeback_debit_minor": r.m[ACC_M_CB_DEBIT],
                "chargeback_reversed_minor": r.m[ACC_M_CB_REVERSED],
                "ledger_other_minor": r.m[ACC_M_LEDGER_OTHER],
                "payout_sent_minor": r.m[ACC_M_PAYOUT_SENT],
                "payout_reversed_minor": r.m[ACC_M_PAYOUT_REVERSED],
                "derived_balance_minor": account_balance(r),
                "observed_total_minor": obs_val(ACC_M_OBS_TOTAL),
                "observed_processing_minor": obs_val(ACC_M_OBS_PROCESSING),
                "observed_available_minor": obs_val(ACC_M_OBS_AVAILABLE),
                "observed_held_minor": obs_val(ACC_M_OBS_HELD),
                "observed_at": ms_json(r.t[ACC_T_OBSERVED_AT]),
            })
        }
        Kind::Customer => json!({"customer_id": id}),
        Kind::Ledger => json!({
            "ledger_entry_id": id,
            "account_id": sym_json(st, r.s[LED_S_ACCOUNT]),
            "transaction_id": sym_json(st, r.s[LED_S_TRANSACTION]),
            "payout_id": sym_json(st, r.s[LED_S_PAYOUT]),
            "posting_type": sym_json(st, r.s[LED_S_POSTING_TYPE]),
            "currency": sym_json(st, r.s[LED_S_CURRENCY]),
            "gross_minor": r.m[LED_M_GROSS],
            "fee_minor": r.m[LED_M_FEE],
            "net_minor": r.m[LED_M_NET],
            "effective_at": ms_json(r.t[LED_T_EFFECTIVE]),
        }),
    };
    if let Value::Object(ref mut map) = v {
        map.insert("links".into(), Value::Array(links));
        map.insert("last_sequence".into(), json!(r.last_seq));
    }
    v
}

/// Derived provider balance (captured − fees − refunded − payouts sent − chargebacks + reversals
/// + other ledger adjustments).
pub fn account_balance(r: &Rec) -> i64 {
    r.m[ACC_M_CAPTURED] - r.m[ACC_M_FEES] - r.m[ACC_M_REFUNDED] - r.m[ACC_M_PAYOUT_SENT]
        + r.m[ACC_M_PAYOUT_REVERSED]
        - r.m[ACC_M_CB_DEBIT]
        + r.m[ACC_M_CB_REVERSED]
        + r.m[ACC_M_LEDGER_OTHER]
}

/// Entity key for an `entity_type` string from the RPC contract.
pub fn kind_for_entity_type(s: &str) -> Option<Kind> {
    Kind::parse(s)
}
