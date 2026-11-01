//! Deterministic reducers: journal entry -> tenant state. See docs/engine.md for the rules.
//!
//! * Idempotent per (tenant, entry_id): an entry already in `state.entries` is skipped.
//! * Effect-once: every business effect is keyed by (event family, observation key). A source
//!   entry and the derived movement/reservation entries appended for the same observation share
//!   the key, so the first applied carries the effect and the rest are recorded as deduplicated.
//! * Late entries keep their effective time; snapshot-type assertions never regress a newer basis.
//! * `supersedes_entry_id` reverts the superseded entry through its undo log, then applies the
//!   correction; history keeps both entries.

use crate::entry::{payload_decimal, Entry, Track};
use crate::state::fields::*;
use crate::state::*;
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Applied,
    AlreadyApplied,
    Deduplicated,
    Recorded,
    LateNoEffect,
    Conflict,
    UnknownEvent,
    /// The correction target was not resident; the entry was applied but a rebuild from the
    /// journal is recommended to re-establish the superseded effect precisely.
    AppliedSupersedesUnknown,
}

/// Dataset id (specs/question-data-contracts.json) for an event family.
pub fn dataset_of(event_type: &str) -> Option<&'static str> {
    Some(match event_type {
        "order.accepted" | "order.revised" | "order.cancelled" => "orders",
        "inventory.snapshot" | "inventory.adjustment_observed" => "stock",
        "inventory.reserved" | "inventory.reservation_released" | "allocation.revised" => {
            "allocations"
        }
        "supply.commitment_recorded" | "supply.commitment_revised" => "supply",
        "customer.commitment_recorded" | "customer.commitment_revised" => "promises",
        "shipment.observed" | "shipment.dispatched" | "shipment.delivered" | "shipment.cancelled" => {
            "fulfillments"
        }
        "carrier.scan_observed" | "carrier.forecast_observed" => "tracking",
        "communication.observed" | "communication.extraction_reviewed" => "communications",
        "invoice.issued" | "invoice.revised" | "invoice.credit_issued" | "invoice.cancelled"
        | "invoice.payment_marked" => "invoices",
        "invoice.dispatch_observed" => "invoice_dispatch",
        "payment.authorized" | "payment.captured" | "payment.failed" | "payment.voided" => {
            "payments"
        }
        "payment.allocation_recorded" | "payment.allocation_revised" => "payment_allocations",
        "business.rule_recorded" | "business.rule_revised" => "policy",
        "business.case_recorded" | "business.case_revised" => "cases",
        "provider.ledger_posted" | "payment.fee_booked" => "provider_ledger",
        "provider.balance_observed" => "positions",
        "payout.announced" | "payout.sent" | "payout.failed" | "payout.reversed" => "payouts",
        "bank.credit_booked" | "bank.debit_booked" | "bank.match_recorded" | "bank.match_revised" => {
            "bank"
        }
        "provider.hold_recorded" | "provider.hold_released" | "provider.release_promised" => "holds",
        "return.approved" | "return.revised" | "return.cancelled" => "returns",
        "return.received" | "return.restocked" | "return.disposition_observed" => "receipts",
        "refund.entitlement_recorded" | "refund.entitlement_revised" => "entitlements",
        "refund.pending" | "refund.completed" | "refund.failed" | "refund.reversed" => "refunds",
        "dispute.opened" | "dispute.resolved" | "chargeback.debit_posted" | "chargeback.reversed" => {
            "disputes"
        }
        "coverage.observed" | "coverage.gap_recorded" => "coverage",
        "entity.link_recorded" | "entity.link_revised" | "entity.link_conflict" => "identity",
        _ => return None,
    })
}

pub const KNOWN_EVENT_TYPES: &[&str] = &[
    "allocation.revised",
    "bank.credit_booked",
    "bank.debit_booked",
    "bank.match_recorded",
    "bank.match_revised",
    "business.case_recorded",
    "business.case_revised",
    "business.rule_recorded",
    "business.rule_revised",
    "carrier.forecast_observed",
    "carrier.scan_observed",
    "chargeback.debit_posted",
    "chargeback.reversed",
    "communication.extraction_reviewed",
    "communication.observed",
    "coverage.gap_recorded",
    "coverage.observed",
    "customer.commitment_recorded",
    "customer.commitment_revised",
    "dispute.opened",
    "dispute.resolved",
    "entity.link_conflict",
    "entity.link_recorded",
    "entity.link_revised",
    "inventory.adjustment_observed",
    "inventory.reservation_released",
    "inventory.reserved",
    "inventory.snapshot",
    "invoice.cancelled",
    "invoice.credit_issued",
    "invoice.dispatch_observed",
    "invoice.issued",
    "invoice.payment_marked",
    "invoice.revised",
    "order.accepted",
    "order.cancelled",
    "order.revised",
    "payment.allocation_recorded",
    "payment.allocation_revised",
    "payment.authorized",
    "payment.captured",
    "payment.failed",
    "payment.fee_booked",
    "payment.voided",
    "payout.announced",
    "payout.failed",
    "payout.reversed",
    "payout.sent",
    "provider.balance_observed",
    "provider.hold_recorded",
    "provider.hold_released",
    "provider.ledger_posted",
    "provider.release_promised",
    "refund.completed",
    "refund.entitlement_recorded",
    "refund.entitlement_revised",
    "refund.failed",
    "refund.pending",
    "refund.reversed",
    "return.approved",
    "return.cancelled",
    "return.disposition_observed",
    "return.received",
    "return.restocked",
    "return.revised",
    "shipment.cancelled",
    "shipment.delivered",
    "shipment.dispatched",
    "shipment.observed",
    "supply.commitment_recorded",
    "supply.commitment_revised",
    "source.conflict_observed",
    "review.decision",
    "evidence.redacted",
];

/// Entity reference keys recognised in `entity_refs` and payloads, mapped to record kinds.
const REF_KINDS: &[(&str, Kind)] = &[
    ("order", Kind::Order),
    ("line", Kind::Line),
    ("customer", Kind::Customer),
    ("item", Kind::Item),
    ("sku", Kind::Item),
    ("invoice", Kind::Invoice),
    ("document", Kind::Invoice),
    ("credit", Kind::Credit),
    ("transaction", Kind::Transaction),
    ("refund", Kind::Refund),
    ("payout", Kind::Payout),
    ("return", Kind::Return),
    ("reservation", Kind::Reservation),
    ("bank_entry", Kind::BankEntry),
    ("shipment", Kind::Shipment),
    ("hold", Kind::Hold),
    ("dispute", Kind::Dispute),
    ("promise", Kind::Promise),
    ("case", Kind::Case),
    ("entitlement", Kind::Entitlement),
    ("allocation", Kind::Allocation),
];

struct Ctx<'a> {
    st: &'a mut TenantState,
    e: &'a Entry,
    seq: i64,
    undo: Vec<Undo>,
    entities: Vec<RecKey>,
    conflicted: bool,
}

impl<'a> Ctx<'a> {
    fn intern(&mut self, s: &str) -> Sym {
        self.st.interner.intern(s)
    }

    fn ref_sym(&mut self, key: &str) -> Option<Sym> {
        let v = self.e.entity_ref(key)?.to_string();
        Some(self.intern(&v))
    }

    fn ensure(&mut self, kind: Kind, id: Sym) -> RecKey {
        let key = RecKey { kind, id };
        if !self.st.recs.contains_key(&key) {
            self.st.recs.insert(key, Rec::new(kind, id, self.seq));
            self.st.by_kind.entry(kind).or_default().push(id);
            self.undo.push(Undo::Created(key));
        }
        if !self.entities.contains(&key) {
            self.entities.push(key);
        }
        key
    }

    fn ensure_ref(&mut self, kind: Kind, ref_key: &str) -> Option<RecKey> {
        let id = self.ref_sym(ref_key)?;
        Some(self.ensure(kind, id))
    }

    fn rec(&mut self, key: RecKey) -> &mut Rec {
        let seq = self.seq;
        let r = self.st.recs.get_mut(&key).expect("record ensured");
        r.last_seq = seq;
        r
    }

    fn get(&self, key: RecKey) -> Option<&Rec> {
        self.st.recs.get(&key)
    }

    fn add_m(&mut self, key: RecKey, slot: usize, delta: i64) {
        if delta == 0 {
            return;
        }
        self.rec(key).m[slot] += delta;
        self.undo.push(Undo::AddM(key, slot as u8, delta));
    }

    fn set_m(&mut self, key: RecKey, slot: usize, value: i64) {
        let old = self.rec(key).m[slot];
        if old == value {
            return;
        }
        self.rec(key).m[slot] = value;
        self.undo.push(Undo::SetM(key, slot as u8, old, value));
    }

    fn add_q(&mut self, key: RecKey, slot: usize, delta: Decimal) {
        if delta.is_zero() {
            return;
        }
        self.rec(key).q[slot] += delta;
        self.undo.push(Undo::AddQ(key, slot as u8, delta));
    }

    fn set_q(&mut self, key: RecKey, slot: usize, value: Decimal) {
        let old = self.rec(key).q[slot];
        if old == value {
            return;
        }
        self.rec(key).q[slot] = value;
        self.undo.push(Undo::SetQ(key, slot as u8, old, value));
    }

    fn set_s(&mut self, key: RecKey, slot: usize, value: Sym) {
        let old = self.rec(key).s[slot];
        if old == value {
            return;
        }
        self.rec(key).s[slot] = value;
        self.undo.push(Undo::SetS(key, slot as u8, old, value));
    }

    fn set_s_if_none(&mut self, key: RecKey, slot: usize, value: Sym) {
        if value == NONE {
            return;
        }
        if self.rec(key).s[slot] == NONE {
            self.set_s(key, slot, value);
        }
    }

    fn set_t(&mut self, key: RecKey, slot: usize, value: i64) {
        let old = self.rec(key).t[slot];
        if old == value {
            return;
        }
        self.rec(key).t[slot] = value;
        self.undo.push(Undo::SetT(key, slot as u8, old, value));
    }

    fn set_status(&mut self, key: RecKey, value: u8) {
        let old = self.rec(key).status;
        if old == value {
            return;
        }
        self.rec(key).status = value;
        self.undo.push(Undo::SetStatus(key, old, value));
    }

    fn link(&mut self, a: RecKey, b: RecKey) {
        if a == b {
            return;
        }
        for (x, y) in [(a, b), (b, a)] {
            let r = self.rec(x);
            if !r.has_link(y.kind, y.id) {
                r.links.push((y.kind, y.id));
                self.undo.push(Undo::Linked(x, y.kind, y.id));
            }
        }
    }

    fn conflict(&mut self, reason: &str, related: Option<Uuid>) {
        let case_id = format!("engine-conflict-{}", self.e.entry_id);
        let entities = self.entities.iter().map(|k| (k.kind, k.id)).collect();
        self.st.conflicts.push(Conflict {
            case_id,
            reason: reason.to_string(),
            entry_id: self.e.entry_id,
            related_entry_id: related,
            seq: self.seq,
            entities,
        });
        self.conflicted = true;
    }

    /// Sets the currency slot of a record or records a conflict when it differs.
    fn currency(&mut self, key: RecKey, slot: usize) -> Option<Sym> {
        let cur = self.e.currency().map(|c| c.to_uppercase());
        let cur_sym = match cur {
            Some(c) => self.intern(&c),
            None => return Some(self.get(key).map(|r| r.s[slot]).unwrap_or(NONE)),
        };
        let existing = self.get(key).map(|r| r.s[slot]).unwrap_or(NONE);
        if existing == NONE {
            self.set_s(key, slot, cur_sym);
            Some(cur_sym)
        } else if existing != cur_sym {
            self.conflict("currency_mismatch", None);
            None
        } else {
            Some(cur_sym)
        }
    }

    fn occurred_ms(&self) -> i64 {
        time_to_ms(self.e.occurred_at)
    }

    fn money(&self, key: &str) -> Option<i64> {
        self.e.payload_i64(key)
    }

    fn qty(&self, key: &str) -> Option<Decimal> {
        payload_decimal(&self.e.payload, key)
    }

    fn str_sym(&mut self, key: &str) -> Sym {
        match self.e.payload_str(key) {
            Some(s) => self.intern(s),
            None => NONE,
        }
    }

    fn time_ms(&self, key: &str) -> Option<i64> {
        let s = self.e.payload_str(key)?;
        parse_time_ms(s)
    }

    /// Provider account record for this entry (account_ref + currency).
    fn account(&mut self, currency: Sym, explicit: Option<Sym>) -> RecKey {
        let acc_ref: String = match explicit {
            Some(s) if s != NONE => self.st.sym(s).to_string(),
            _ => self
                .e
                .payload_str("account")
                .map(|s| s.to_string())
                .or_else(|| self.e.account_ref.clone())
                .unwrap_or_else(|| "default".to_string()),
        };
        let cur = self.st.sym(currency).to_string();
        let id_str = format!("{acc_ref}|{cur}");
        let id = self.intern(&id_str);
        let acc_sym = self.intern(&acc_ref);
        let key = self.ensure(Kind::Account, id);
        self.set_s_if_none(key, ACC_S_ACCOUNT_REF, acc_sym);
        self.set_s_if_none(key, ACC_S_CURRENCY, currency);
        key
    }

    fn order_key(&mut self) -> Option<RecKey> {
        self.ensure_ref(Kind::Order, "order")
    }

    fn item_key(&mut self) -> Option<RecKey> {
        if let Some(k) = self.ensure_ref(Kind::Item, "item") {
            return Some(k);
        }
        if let Some(k) = self.ensure_ref(Kind::Item, "sku") {
            return Some(k);
        }
        self.ensure_ref(Kind::Item, "item_id")
    }

    fn link_order_customer(&mut self, key: RecKey) {
        if let Some(o) = self.order_key() {
            self.link(o, key);
            if let Some(c) = self.ensure_ref(Kind::Customer, "customer") {
                self.link(o, c);
                self.set_s_if_none(o, ORDER_S_CUSTOMER, c.id);
            }
        }
        if let Some(c) = self.ensure_ref(Kind::Customer, "customer") {
            self.link(c, key);
        }
    }

    /// Applies a stock delta to an item unless the movement predates the current snapshot basis.
    fn stock_delta(&mut self, item: RecKey, physical: Decimal, quarantine: Decimal) -> bool {
        let basis = self.get(item).map(|r| r.t[ITEM_T_BASIS_AT]).unwrap_or(0);
        if basis != 0 && self.occurred_ms() <= basis {
            return false;
        }
        self.add_q(item, ITEM_Q_PHYSICAL, physical);
        self.add_q(item, ITEM_Q_QUARANTINED, quarantine);
        true
    }

    fn release_reservation(&mut self, res: RecKey, requested: Option<Decimal>) -> Decimal {
        let (qty, released, status, item) = {
            let r = self.get(res).expect("reservation");
            (r.q[RES_Q_QUANTITY], r.q[RES_Q_RELEASED], r.status, r.s[RES_S_ITEM])
        };
        if status == RES_ST_RELEASED {
            return Decimal::ZERO;
        }
        let remaining = qty - released;
        let amount = requested.unwrap_or(remaining).min(remaining).max(Decimal::ZERO);
        if amount.is_zero() {
            return amount;
        }
        self.add_q(res, RES_Q_RELEASED, amount);
        if status == RES_ST_ACTIVE && item != NONE {
            let ik = self.ensure(Kind::Item, item);
            self.add_q(ik, ITEM_Q_RESERVED_ACTIVE, -amount);
        }
        if released + amount >= qty {
            self.set_status(res, RES_ST_RELEASED);
        }
        amount
    }
}

pub fn parse_time_ms(s: &str) -> Option<i64> {
    if let Ok(t) = DateTime::parse_from_rfc3339(s) {
        return Some(t.with_timezone(&Utc).timestamp_millis());
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return d
            .and_hms_opt(0, 0, 0)
            .map(|n| n.and_utc().timestamp_millis());
    }
    None
}

fn hash_prefix(hash: &str, entry_id: Uuid) -> u64 {
    if hash.len() >= 16 {
        if let Ok(v) = u64::from_str_radix(&hash[..16], 16) {
            return v;
        }
    }
    let d = Sha256::digest(entry_id.as_bytes());
    u64::from_le_bytes(d[..8].try_into().unwrap())
}

/// Applies one entry. Entries must be applied in ascending `journal_sequence` for a tenant
/// in the serving path; scratch replays may apply any subset (the rules are order-independent
/// for independent entries).
pub fn apply(state: &mut TenantState, e: &Entry) -> Outcome {
    if e.tenant_id != state.tenant_id {
        return Outcome::Conflict;
    }
    if state.entries.contains_key(&e.entry_id) {
        return Outcome::AlreadyApplied;
    }
    let seq = e.journal_sequence;
    let event_sym = state.interner.intern(&e.event_type);
    let record_sym = state.interner.intern(&e.record_id);
    if let Some(ds) = dataset_of(&e.event_type) {
        let s = state.interner.intern(ds);
        state.datasets_present.insert(s);
    }

    // Observation key.
    let obs_string = match e.own_observation_key() {
        Some(k) => k,
        None => {
            let mut resolved = None;
            for input in &e.input_entry_ids {
                if let Some(meta) = state.entries.get(input) {
                    resolved = Some(state.interner.resolve(meta.observation).to_string());
                    break;
                }
            }
            resolved.unwrap_or_else(|| e.entry_id.to_string())
        }
    };
    let obs = state.interner.intern(&obs_string);

    let mut ctx = Ctx {
        st: state,
        e,
        seq,
        undo: Vec::new(),
        entities: Vec::new(),
        conflicted: false,
    };

    // Register every referenced entity for history locators.
    for (k, kind) in REF_KINDS {
        if let Some(v) = e.entity_refs.get(*k) {
            if !v.is_empty() {
                let id = ctx.intern(v);
                ctx.ensure(*kind, id);
            }
        }
    }
    for (k, kind) in REF_KINDS {
        if let Some(v) = e.payload_str(k) {
            if !v.is_empty() {
                let id = ctx.intern(v);
                ctx.ensure(*kind, id);
            }
        }
    }

    let mut effect = EFFECT_APPLIED;
    let mut outcome = Outcome::Applied;

    // Duplicate/conflicting source observation.
    let mut skip_effects = false;
    if e.track == Track::Source {
        let hp = hash_prefix(&e.payload_hash, e.entry_id);
        if let Some(&(prev_hash, prev_id)) = ctx.st.observations.get(&obs) {
            if prev_hash != hp {
                ctx.conflict("observation_content_conflict", Some(prev_id));
                effect = EFFECT_CONFLICT;
                outcome = Outcome::Conflict;
            } else {
                effect = EFFECT_DEDUPLICATED;
                outcome = Outcome::Deduplicated;
            }
            skip_effects = true;
        } else {
            ctx.st.observations.insert(obs, (hp, e.entry_id));
        }
    }

    // Supersession: revert the earlier assertion before applying the correction.
    let mut supersedes_unknown = false;
    if let Some(target) = e.supersedes_entry_id {
        if let Some(meta) = ctx.st.entries.get_mut(&target) {
            if meta.superseded_by.is_none() {
                let undo = std::mem::take(&mut meta.undo);
                meta.superseded_by = Some(e.entry_id);
                meta.effect = EFFECT_SUPERSEDED;
                revert(ctx.st, &undo);
            }
            // Mark in the history locators as superseded.
            for locs in ctx.st.history.values_mut() {
                for l in locs.iter_mut() {
                    if l.entry_id == target {
                        l.effect = EFFECT_SUPERSEDED;
                    }
                }
            }
        } else {
            supersedes_unknown = true;
            ctx.conflict("supersedes_unknown_entry", Some(target));
        }
    }

    if !skip_effects {
        let known = KNOWN_EVENT_TYPES.contains(&e.event_type.as_str());
        if !known {
            effect = EFFECT_UNKNOWN_EVENT;
            outcome = Outcome::UnknownEvent;
            *ctx.st.unknown_event_types.entry(event_sym).or_insert(0) += 1;
        } else if ctx.st.applied_effects.contains(&(event_sym, obs)) {
            effect = EFFECT_DEDUPLICATED;
            outcome = Outcome::Deduplicated;
        } else {
            let r = dispatch(&mut ctx);
            if ctx.conflicted && effect == EFFECT_APPLIED {
                effect = EFFECT_CONFLICT;
                outcome = Outcome::Conflict;
            }
            match r {
                Applied::Yes => {
                    ctx.st.applied_effects.insert((event_sym, obs));
                }
                Applied::Late => {
                    effect = EFFECT_LATE_NO_EFFECT;
                    outcome = Outcome::LateNoEffect;
                    ctx.st.applied_effects.insert((event_sym, obs));
                }
                Applied::RecordOnly => {
                    if effect == EFFECT_APPLIED {
                        effect = EFFECT_RECORDED;
                        outcome = Outcome::Recorded;
                    }
                }
            }
        }
    }

    let Ctx {
        undo, entities, ..
    } = ctx;

    // History locators.
    let loc = EntryLoc {
        seq,
        entry_id: e.entry_id,
        track: e.track.index() as u8,
        event: event_sym,
        occurred_ms: time_to_ms(e.occurred_at),
        recorded_ms: time_to_ms(e.recorded_at),
        record_id: record_sym,
        effect,
    };
    for key in &entities {
        state.history.entry(*key).or_default().push(loc);
    }

    // Chain hash.
    let mut h = Sha256::new();
    h.update(state.state_hash);
    h.update(e.entry_id.as_bytes());
    h.update(seq.to_le_bytes());
    h.update([effect]);
    state.state_hash = h.finalize().into();

    state.entries.insert(
        e.entry_id,
        EntryMeta {
            seq,
            observation: obs,
            event: event_sym,
            track: e.track.index() as u8,
            effect,
            superseded_by: None,
            supersedes: e.supersedes_entry_id,
            undo,
            entities,
        },
    );
    if seq > state.applied_sequence {
        state.applied_sequence = seq;
    }
    state.applied_entries += 1;
    let rec_ms = time_to_ms(e.recorded_at);
    if rec_ms > state.last_recorded_ms {
        state.last_recorded_ms = rec_ms;
    }
    let occ_ms = time_to_ms(e.occurred_at);
    if occ_ms > state.last_occurred_ms {
        state.last_occurred_ms = occ_ms;
    }
    if supersedes_unknown && outcome == Outcome::Applied {
        return Outcome::AppliedSupersedesUnknown;
    }
    outcome
}

fn revert(state: &mut TenantState, undo: &[Undo]) {
    for u in undo.iter().rev() {
        match u {
            Undo::Created(_) => {
                // Records stay (history still references them); values were reverted by the
                // other undo elements.
            }
            Undo::AddM(k, s, d) => {
                if let Some(r) = state.recs.get_mut(k) {
                    r.m[*s as usize] -= d;
                }
            }
            Undo::AddQ(k, s, d) => {
                if let Some(r) = state.recs.get_mut(k) {
                    r.q[*s as usize] -= d;
                }
            }
            Undo::SetM(k, s, old, new) => {
                if let Some(r) = state.recs.get_mut(k) {
                    if r.m[*s as usize] == *new {
                        r.m[*s as usize] = *old;
                    }
                }
            }
            Undo::SetQ(k, s, old, new) => {
                if let Some(r) = state.recs.get_mut(k) {
                    if r.q[*s as usize] == *new {
                        r.q[*s as usize] = *old;
                    }
                }
            }
            Undo::SetS(k, s, old, new) => {
                if let Some(r) = state.recs.get_mut(k) {
                    if r.s[*s as usize] == *new {
                        r.s[*s as usize] = *old;
                    }
                }
            }
            Undo::SetT(k, s, old, new) => {
                if let Some(r) = state.recs.get_mut(k) {
                    if r.t[*s as usize] == *new {
                        r.t[*s as usize] = *old;
                    }
                }
            }
            Undo::SetStatus(k, old, new) => {
                if let Some(r) = state.recs.get_mut(k) {
                    if r.status == *new {
                        r.status = *old;
                    }
                }
            }
            Undo::Linked(_, _, _) => {
                // Links are provenance; they are kept.
            }
        }
    }
}

enum Applied {
    Yes,
    Late,
    RecordOnly,
}

fn dispatch(c: &mut Ctx) -> Applied {
    match c.e.event_type.as_str() {
        "inventory.snapshot" => inventory_snapshot(c),
        "inventory.adjustment_observed" => inventory_adjustment(c),
        "inventory.reserved" => inventory_reserved(c),
        "inventory.reservation_released" => reservation_released(c),
        "allocation.revised" => allocation_revised(c),
        "order.accepted" => order_accepted(c, false),
        "order.revised" => order_accepted(c, true),
        "order.cancelled" => order_cancelled(c),
        "invoice.issued" => invoice_issued(c),
        "invoice.revised" => invoice_revised(c),
        "invoice.cancelled" => invoice_cancelled(c),
        "invoice.credit_issued" => credit_issued(c),
        "invoice.payment_marked" => payment_marked(c),
        "invoice.dispatch_observed" => dispatch_observed(c),
        "payment.authorized" => payment_authorized(c),
        "payment.captured" => payment_captured(c),
        "payment.failed" => payment_failed(c, false),
        "payment.voided" => payment_failed(c, true),
        "payment.fee_booked" => fee_booked(c),
        "provider.ledger_posted" => ledger_posted(c),
        "provider.balance_observed" => balance_observed(c),
        "provider.hold_recorded" => hold_recorded(c),
        "provider.hold_released" => hold_released(c),
        "provider.release_promised" => release_promised(c),
        "refund.pending" => refund_pending(c),
        "refund.completed" => refund_completed(c),
        "refund.failed" => refund_failed(c),
        "refund.reversed" => refund_reversed(c),
        "payout.announced" => payout_announced(c),
        "payout.sent" => payout_sent(c),
        "payout.failed" => payout_failed(c),
        "payout.reversed" => payout_reversed(c),
        "bank.credit_booked" => bank_booked(c, true),
        "bank.debit_booked" => bank_booked(c, false),
        "bank.match_recorded" => bank_match(c, false),
        "bank.match_revised" => bank_match(c, true),
        "shipment.observed" => shipment_observed(c),
        "shipment.dispatched" => shipment_dispatched(c),
        "shipment.delivered" => shipment_delivered(c),
        "shipment.cancelled" => shipment_cancelled(c),
        "carrier.scan_observed" => scan_observed(c),
        "carrier.forecast_observed" => forecast_observed(c),
        "return.approved" => return_approved(c, false),
        "return.revised" => return_approved(c, true),
        "return.cancelled" => return_cancelled(c),
        "return.received" => return_received(c),
        "return.restocked" => return_restocked(c),
        "return.disposition_observed" => return_disposition(c),
        "refund.entitlement_recorded" => entitlement(c, false),
        "refund.entitlement_revised" => entitlement(c, true),
        "dispute.opened" => dispute_opened(c),
        "dispute.resolved" => dispute_resolved(c),
        "chargeback.debit_posted" => chargeback_debit(c),
        "chargeback.reversed" => chargeback_reversed(c),
        "customer.commitment_recorded" => customer_promise(c, false),
        "customer.commitment_revised" => customer_promise(c, true),
        "supply.commitment_recorded" => supply_commitment(c, false),
        "supply.commitment_revised" => supply_commitment(c, true),
        "business.rule_recorded" => rule(c, false),
        "business.rule_revised" => rule(c, true),
        "business.case_recorded" => case(c, false),
        "business.case_revised" => case(c, true),
        "entity.link_recorded" => identity_link(c, LINK_ST_RECORDED),
        "entity.link_revised" => identity_link(c, LINK_ST_REVISED),
        "entity.link_conflict" => identity_link(c, LINK_ST_CONFLICT),
        "coverage.observed" => coverage(c, false),
        "coverage.gap_recorded" => coverage(c, true),
        "communication.observed" => communication(c, false),
        "communication.extraction_reviewed" => communication(c, true),
        "payment.allocation_recorded" => allocation(c, false),
        "payment.allocation_revised" => allocation(c, true),
        "source.conflict_observed" => {
            let related = c
                .e
                .payload_str("original_entry_id")
                .and_then(|s| Uuid::parse_str(s).ok());
            c.conflict("source_conflict_observed", related);
            Applied::RecordOnly
        }
        "review.decision" | "evidence.redacted" => Applied::RecordOnly,
        _ => Applied::RecordOnly,
    }
}

// ---------------------------------------------------------------- stock

fn inventory_snapshot(c: &mut Ctx) -> Applied {
    let Some(item) = c.item_key() else {
        c.conflict("missing_item_reference", None);
        return Applied::RecordOnly;
    };
    let now = c.occurred_ms();
    let basis = c.get(item).map(|r| r.t[ITEM_T_BASIS_AT]).unwrap_or(0);
    if basis != 0 && now < basis {
        return Applied::Late;
    }
    let physical = c.qty("physical").unwrap_or(Decimal::ZERO);
    let quarantined = c
        .qty("quarantined")
        .or_else(|| c.qty("quality_control"))
        .unwrap_or(Decimal::ZERO);
    let qc = if c.qty("quarantined").is_some() {
        c.qty("quality_control").unwrap_or(Decimal::ZERO)
    } else {
        Decimal::ZERO
    };
    let reserved = c.qty("reserved").unwrap_or(Decimal::ZERO);
    let committed = c.qty("committed").unwrap_or(Decimal::ZERO);
    let damaged = c.qty("damaged").unwrap_or(Decimal::ZERO);
    let safety = c.qty("safety_stock").unwrap_or(Decimal::ZERO);
    let incoming = c.qty("incoming").unwrap_or(Decimal::ZERO);
    let provider_available = c.qty("available").or_else(|| c.qty("provider_available"));
    c.set_q(item, ITEM_Q_PHYSICAL, physical);
    c.set_q(item, ITEM_Q_QUARANTINED, quarantined);
    c.set_q(item, ITEM_Q_QUALITY_CONTROL, qc);
    c.set_q(item, ITEM_Q_SNAPSHOT_RESERVED, reserved);
    c.set_q(item, ITEM_Q_COMMITTED, committed);
    c.set_q(item, ITEM_Q_DAMAGED, damaged);
    c.set_q(item, ITEM_Q_SAFETY, safety);
    c.set_q(item, ITEM_Q_INCOMING, incoming);
    match provider_available {
        Some(a) => {
            c.set_q(item, ITEM_Q_PROVIDER_AVAILABLE, a);
            c.set_status(item, ITEM_ST_BASIS_WITH_PROVIDER_AVAILABLE);
        }
        None => {
            c.set_q(item, ITEM_Q_PROVIDER_AVAILABLE, Decimal::ZERO);
            c.set_status(item, ITEM_ST_BASIS);
        }
    }
    let unit = c.str_sym("unit");
    c.set_s_if_none(item, ITEM_S_UNIT, unit);
    let loc = c.str_sym("location");
    c.set_s_if_none(item, ITEM_S_LOCATION, loc);
    c.set_t(item, ITEM_T_BASIS_AT, now);
    // Reservations made before this basis are now covered by the snapshot's own reserved figure.
    let reservations: Vec<Sym> = c
        .get(item)
        .map(|r| r.linked(Kind::Reservation).collect())
        .unwrap_or_default();
    for rid in reservations {
        let rk = RecKey::new(Kind::Reservation, rid);
        let (status, occ, qty, released) = match c.get(rk) {
            Some(r) => (
                r.status,
                r.t[RES_T_OCCURRED_AT],
                r.q[RES_Q_QUANTITY],
                r.q[RES_Q_RELEASED],
            ),
            None => continue,
        };
        if status == RES_ST_ACTIVE && occ <= now {
            c.add_q(item, ITEM_Q_RESERVED_ACTIVE, -(qty - released));
            c.set_status(rk, RES_ST_ACTIVE_COVERED);
        }
    }
    Applied::Yes
}

pub const RES_ST_ACTIVE_COVERED: u8 = 3;

fn inventory_adjustment(c: &mut Ctx) -> Applied {
    let Some(item) = c.item_key() else {
        c.conflict("missing_item_reference", None);
        return Applied::RecordOnly;
    };
    let p = c.qty("physical_delta").unwrap_or(Decimal::ZERO);
    let q = c.qty("quarantine_delta").unwrap_or(Decimal::ZERO);
    if c.stock_delta(item, p, q) {
        Applied::Yes
    } else {
        Applied::Late
    }
}

fn inventory_reserved(c: &mut Ctx) -> Applied {
    let Some(res) = c.ensure_ref(Kind::Reservation, "reservation") else {
        c.conflict("missing_reservation_reference", None);
        return Applied::RecordOnly;
    };
    let qty = c.qty("quantity").unwrap_or(Decimal::ZERO);
    let item = c.item_key();
    let order = c.order_key();
    let line = c.ensure_ref(Kind::Line, "line");
    let now = c.occurred_ms();
    let existing_status = c.get(res).map(|r| r.status).unwrap_or(0);
    if existing_status != 0 {
        // Re-assertion of an existing reservation: treat as quantity revision.
        return allocation_revised(c);
    }
    c.set_q(res, RES_Q_QUANTITY, qty);
    c.set_t(res, RES_T_OCCURRED_AT, now);
    let unit = c.str_sym("unit");
    c.set_s_if_none(res, RES_S_UNIT, unit);
    if let Some(o) = order {
        c.set_s(res, RES_S_ORDER, o.id);
        c.link(o, res);
        if let Some(i) = item {
            c.link(o, i);
        }
    }
    if let Some(l) = line {
        c.set_s(res, RES_S_LINE, l.id);
        c.link(l, res);
    }
    if let Some(i) = item {
        c.set_s(res, RES_S_ITEM, i.id);
        c.link(i, res);
        let basis = c.get(i).map(|r| r.t[ITEM_T_BASIS_AT]).unwrap_or(0);
        if basis != 0 && now <= basis {
            c.set_status(res, RES_ST_ACTIVE_COVERED);
        } else {
            c.set_status(res, RES_ST_ACTIVE);
            c.add_q(i, ITEM_Q_RESERVED_ACTIVE, qty);
        }
    } else {
        c.set_status(res, RES_ST_ACTIVE);
    }
    Applied::Yes
}

fn reservation_released(c: &mut Ctx) -> Applied {
    let Some(res) = c.ensure_ref(Kind::Reservation, "reservation") else {
        c.conflict("missing_reservation_reference", None);
        return Applied::RecordOnly;
    };
    let q = c.qty("quantity");
    c.release_reservation(res, q);
    Applied::Yes
}

fn allocation_revised(c: &mut Ctx) -> Applied {
    let Some(res) = c.ensure_ref(Kind::Reservation, "reservation") else {
        c.conflict("missing_reservation_reference", None);
        return Applied::RecordOnly;
    };
    let Some(new_qty) = c.qty("quantity") else {
        return Applied::RecordOnly;
    };
    let (old, status, item) = {
        let r = c.get(res).expect("res");
        (r.q[RES_Q_QUANTITY], r.status, r.s[RES_S_ITEM])
    };
    c.set_q(res, RES_Q_QUANTITY, new_qty);
    if status == RES_ST_ACTIVE && item != NONE {
        let ik = c.ensure(Kind::Item, item);
        c.add_q(ik, ITEM_Q_RESERVED_ACTIVE, new_qty - old);
    }
    Applied::Yes
}

// ---------------------------------------------------------------- orders

fn order_accepted(c: &mut Ctx, revision: bool) -> Applied {
    let Some(order) = c.order_key() else {
        c.conflict("missing_order_reference", None);
        return Applied::RecordOnly;
    };
    let cur = c.currency(order, ORDER_S_CURRENCY);
    if cur.is_none() {
        return Applied::RecordOnly;
    }
    let cur = cur.unwrap_or(NONE);
    if let Some(cust) = c.ensure_ref(Kind::Customer, "customer") {
        c.set_s_if_none(order, ORDER_S_CUSTOMER, cust.id);
        c.link(order, cust);
    }
    if !revision || c.get(order).map(|r| r.status).unwrap_or(0) == 0 {
        c.set_status(order, ORDER_ST_ACCEPTED);
        c.set_t(order, ORDER_T_ACCEPTED_AT, c.occurred_ms());
    }
    if let Some(g) = c.money("gross_minor") {
        c.set_m(order, ORDER_M_GROSS, g);
    }
    let lines: Vec<serde_json::Value> = match c.e.payload.get("lines").and_then(|l| l.as_array()) {
        Some(arr) => arr.clone(),
        None => {
            let mut single = serde_json::Map::new();
            if let Some(q) = c.e.payload.get("quantity") {
                single.insert("quantity".into(), q.clone());
            }
            for k in ["item", "sku", "unit", "gross_minor", "unit_gross_minor", "line"] {
                if let Some(v) = c.e.payload.get(k) {
                    single.insert(k.into(), v.clone());
                }
            }
            if !single.contains_key("item") {
                if let Some(i) = c.e.entity_refs.get("item") {
                    single.insert("item".into(), serde_json::Value::String(i.clone()));
                }
            }
            if !single.contains_key("line") {
                if let Some(l) = c.e.entity_refs.get("line") {
                    single.insert("line".into(), serde_json::Value::String(l.clone()));
                }
            }
            if single.contains_key("quantity") {
                vec![serde_json::Value::Object(single)]
            } else {
                vec![]
            }
        }
    };
    let order_id_str = c.st.sym(order.id).to_string();
    let mut total_qty = Decimal::ZERO;
    let mut first_item = NONE;
    let mut unit_sym = NONE;
    for (i, l) in lines.iter().enumerate() {
        let line_id = l
            .get("line")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{order_id_str}#{}", i + 1));
        let line_sym = c.intern(&line_id);
        let lk = c.ensure(Kind::Line, line_sym);
        c.link(order, lk);
        c.set_s(lk, LINE_S_ORDER, order.id);
        c.set_s(lk, LINE_S_CURRENCY, cur);
        let qty = payload_decimal(l, "quantity").unwrap_or(Decimal::ZERO);
        c.set_q(lk, LINE_Q_QUANTITY, qty);
        total_qty += qty;
        if let Some(g) = crate::entry::payload_i64(l, "gross_minor") {
            c.set_m(lk, LINE_M_GROSS, g);
        }
        if let Some(g) = crate::entry::payload_i64(l, "unit_gross_minor") {
            c.set_m(lk, LINE_M_UNIT_GROSS, g);
        }
        if let Some(u) = l.get("unit").and_then(|v| v.as_str()) {
            let us = c.intern(u);
            c.set_s(lk, LINE_S_UNIT, us);
            if unit_sym == NONE {
                unit_sym = us;
            }
        }
        let item_str = l
            .get("item")
            .or_else(|| l.get("sku"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if let Some(it) = item_str {
            let is = c.intern(&it);
            let ik = c.ensure(Kind::Item, is);
            c.set_s(lk, LINE_S_ITEM, is);
            c.link(lk, ik);
            c.link(order, ik);
            if first_item == NONE {
                first_item = is;
            }
        }
    }
    if !lines.is_empty() {
        c.set_q(order, ORDER_Q_QUANTITY, total_qty);
    }
    if first_item != NONE {
        c.set_s_if_none(order, ORDER_S_ITEM, first_item);
    } else if let Some(ik) = c.item_key() {
        c.set_s_if_none(order, ORDER_S_ITEM, ik.id);
        c.link(order, ik);
    }
    if unit_sym != NONE {
        c.set_s_if_none(order, ORDER_S_UNIT, unit_sym);
    }
    Applied::Yes
}

fn order_cancelled(c: &mut Ctx) -> Applied {
    let Some(order) = c.order_key() else {
        c.conflict("missing_order_reference", None);
        return Applied::RecordOnly;
    };
    let requested = c.qty("quantity");
    let line = c.ensure_ref(Kind::Line, "line");
    let targets: Vec<RecKey> = match line {
        Some(l) => vec![l],
        None => c
            .get(order)
            .map(|r| {
                r.linked(Kind::Line)
                    .map(|id| RecKey::new(Kind::Line, id))
                    .collect()
            })
            .unwrap_or_default(),
    };
    let mut remaining_request = requested;
    let mut cancelled_total = Decimal::ZERO;
    for lk in targets {
        let (q, canc, disp) = {
            let r = c.get(lk).expect("line");
            (r.q[LINE_Q_QUANTITY], r.q[LINE_Q_CANCELLED], r.q[LINE_Q_DISPATCHED])
        };
        let open = (q - canc - disp).max(Decimal::ZERO);
        let amount = match remaining_request {
            Some(rq) => rq.min(open),
            None => open,
        };
        if amount > Decimal::ZERO {
            c.add_q(lk, LINE_Q_CANCELLED, amount);
            cancelled_total += amount;
            if let Some(rq) = remaining_request {
                remaining_request = Some(rq - amount);
            }
        }
    }
    if line.is_none() && requested.is_none() {
        // Whole-order cancellation also when no lines are known.
        let (q, canc, disp) = {
            let r = c.get(order).expect("order");
            (r.q[ORDER_Q_QUANTITY], r.q[ORDER_Q_CANCELLED], r.q[ORDER_Q_DISPATCHED])
        };
        let open = (q - canc - disp).max(Decimal::ZERO);
        if cancelled_total.is_zero() {
            cancelled_total = open;
        }
    }
    c.add_q(order, ORDER_Q_CANCELLED, cancelled_total);
    let (q, canc, disp) = {
        let r = c.get(order).expect("order");
        (r.q[ORDER_Q_QUANTITY], r.q[ORDER_Q_CANCELLED], r.q[ORDER_Q_DISPATCHED])
    };
    if canc >= q - disp || (line.is_none() && requested.is_none()) {
        c.set_status(order, ORDER_ST_CANCELLED);
    } else {
        c.set_status(order, ORDER_ST_PARTIALLY_CANCELLED);
    }
    c.set_t(order, ORDER_T_CANCELLED_AT, c.occurred_ms());
    Applied::Yes
}

// ---------------------------------------------------------------- invoices

fn invoice_key(c: &mut Ctx) -> Option<RecKey> {
    c.ensure_ref(Kind::Invoice, "invoice")
        .or_else(|| c.ensure_ref(Kind::Invoice, "document"))
}

fn invoice_issued(c: &mut Ctx) -> Applied {
    let Some(inv) = invoice_key(c) else {
        c.conflict("missing_invoice_reference", None);
        return Applied::RecordOnly;
    };
    if c.currency(inv, INV_S_CURRENCY).is_none() {
        return Applied::RecordOnly;
    }
    if let Some(g) = c.money("gross_minor") {
        c.set_m(inv, INV_M_GROSS, g);
    }
    let draft = c.e.payload_bool("draft").unwrap_or(false)
        || c.e.payload_str("draft_state") == Some("draft");
    c.set_status(inv, if draft { INV_ST_DRAFT } else { INV_ST_ISSUED });
    if let Some(d) = c.time_ms("due_date") {
        c.set_t(inv, INV_T_DUE_DATE, d);
    }
    c.set_t(inv, INV_T_ISSUED_AT, c.occurred_ms());
    c.link_order_customer(inv);
    if let Some(o) = c.order_key() {
        c.set_s_if_none(inv, INV_S_ORDER, o.id);
        let cust = c.get(o).map(|r| r.s[ORDER_S_CUSTOMER]).unwrap_or(NONE);
        c.set_s_if_none(inv, INV_S_CUSTOMER, cust);
    }
    if let Some(cu) = c.ensure_ref(Kind::Customer, "customer") {
        c.set_s_if_none(inv, INV_S_CUSTOMER, cu.id);
    }
    if let Some(links) = c.e.payload.get("line_links").and_then(|v| v.as_array()).cloned() {
        for l in links {
            if let Some(line) = l.get("line").and_then(|v| v.as_str()) {
                let ls = c.intern(line);
                let lk = c.ensure(Kind::Line, ls);
                c.link(inv, lk);
                if let Some(q) = payload_decimal(&l, "quantity") {
                    c.add_q(lk, LINE_Q_INVOICED, q);
                }
            }
        }
    }
    Applied::Yes
}

fn invoice_revised(c: &mut Ctx) -> Applied {
    let Some(inv) = invoice_key(c) else {
        c.conflict("missing_invoice_reference", None);
        return Applied::RecordOnly;
    };
    if c.currency(inv, INV_S_CURRENCY).is_none() {
        return Applied::RecordOnly;
    }
    if let Some(g) = c.money("gross_minor") {
        c.set_m(inv, INV_M_GROSS, g);
    }
    if let Some(d) = c.time_ms("due_date") {
        c.set_t(inv, INV_T_DUE_DATE, d);
    }
    if c.e.payload_str("draft_state") == Some("finalized") {
        c.set_status(inv, INV_ST_ISSUED);
    }
    Applied::Yes
}

fn invoice_cancelled(c: &mut Ctx) -> Applied {
    let Some(inv) = invoice_key(c) else {
        c.conflict("missing_invoice_reference", None);
        return Applied::RecordOnly;
    };
    c.set_status(inv, INV_ST_CANCELLED);
    Applied::Yes
}

fn credit_issued(c: &mut Ctx) -> Applied {
    let Some(inv) = invoice_key(c) else {
        c.conflict("missing_invoice_reference", None);
        return Applied::RecordOnly;
    };
    if c.currency(inv, INV_S_CURRENCY).is_none() {
        return Applied::RecordOnly;
    }
    let cur = c.get(inv).map(|r| r.s[INV_S_CURRENCY]).unwrap_or(NONE);
    let amount = c.money("credit_minor").or_else(|| c.money("amount_minor")).unwrap_or(0);
    let credit_id = c
        .e
        .entity_ref("credit")
        .map(|s| s.to_string())
        .unwrap_or_else(|| c.e.record_id.clone());
    let cs = c.intern(&credit_id);
    let ck = c.ensure(Kind::Credit, cs);
    c.set_m(ck, CREDIT_M_AMOUNT, amount);
    c.set_s(ck, CREDIT_S_INVOICE, inv.id);
    c.set_s(ck, CREDIT_S_CURRENCY, cur);
    let confirmed = c.e.payload_bool("cash_refund_confirmed").unwrap_or(false);
    c.set_status(
        ck,
        if confirmed {
            CREDIT_ST_CASH_REFUND_CONFIRMED
        } else {
            CREDIT_ST_ISSUED
        },
    );
    c.set_t(ck, CREDIT_T_ISSUED_AT, c.occurred_ms());
    c.add_m(inv, INV_M_CREDIT, amount);
    c.link(inv, ck);
    let order = c.get(inv).map(|r| r.s[INV_S_ORDER]).unwrap_or(NONE);
    if order != NONE {
        let ok = c.ensure(Kind::Order, order);
        c.set_s(ck, CREDIT_S_ORDER, order);
        c.link(ok, ck);
    }
    c.link_order_customer(ck);
    Applied::Yes
}

fn payment_marked(c: &mut Ctx) -> Applied {
    let Some(inv) = invoice_key(c) else {
        c.conflict("missing_invoice_reference", None);
        return Applied::RecordOnly;
    };
    if c.currency(inv, INV_S_CURRENCY).is_none() {
        return Applied::RecordOnly;
    }
    let paid = c.money("paid_minor").unwrap_or(0);
    // Reported marker only; never a cash movement (is_new_cash_movement is informational).
    c.add_m(inv, INV_M_REPORTED_PAID, paid);
    if let Some(tx) = c.ensure_ref(Kind::Transaction, "transaction") {
        c.link(inv, tx);
    }
    c.link_order_customer(inv);
    Applied::Yes
}

fn dispatch_observed(c: &mut Ctx) -> Applied {
    let Some(inv) = invoice_key(c) else {
        c.conflict("missing_invoice_reference", None);
        return Applied::RecordOnly;
    };
    let id = c
        .e
        .payload_str("dispatch")
        .map(|s| s.to_string())
        .unwrap_or_else(|| c.e.record_id.clone());
    let ds = c.intern(&id);
    let dk = c.ensure(Kind::Dispatch, ds);
    c.set_s(dk, DSP_S_INVOICE, inv.id);
    let ch = c.str_sym("channel");
    c.set_s(dk, DSP_S_CHANNEL, ch);
    let status_str = c
        .e
        .payload_str("status")
        .unwrap_or("")
        .to_ascii_lowercase();
    let ss = c.intern(&status_str);
    c.set_s(dk, DSP_S_STATUS, ss);
    let st = match status_str.as_str() {
        "ok" | "sent" | "delivered" | "success" => DSP_ST_OK,
        "error" | "failed" | "bounced" => DSP_ST_ERROR,
        _ => DSP_ST_PENDING,
    };
    c.set_status(dk, st);
    if let Some(t) = c.time_ms("processed_at") {
        c.set_t(dk, DSP_T_PROCESSED_AT, t);
    } else {
        c.set_t(dk, DSP_T_PROCESSED_AT, c.occurred_ms());
    }
    c.link(inv, dk);
    Applied::Yes
}

// ---------------------------------------------------------------- payments

fn tx_key(c: &mut Ctx) -> Option<RecKey> {
    c.ensure_ref(Kind::Transaction, "transaction")
}

fn tx_setup(c: &mut Ctx, tx: RecKey) -> Option<Sym> {
    let cur = c.currency(tx, TX_S_CURRENCY)?;
    c.link_order_customer(tx);
    if let Some(o) = c.order_key() {
        c.set_s_if_none(tx, TX_S_ORDER, o.id);
        let cust = c.get(o).map(|r| r.s[ORDER_S_CUSTOMER]).unwrap_or(NONE);
        c.set_s_if_none(tx, TX_S_CUSTOMER, cust);
    }
    let acc = c.account(cur, None);
    c.set_s_if_none(tx, TX_S_ACCOUNT, acc.id);
    let gw = c.str_sym("gateway");
    c.set_s_if_none(tx, TX_S_GATEWAY, gw);
    if let Some(orig) = c.e.payload_str("original_transaction") {
        let os = c.intern(orig);
        c.set_s_if_none(tx, TX_S_ORIGINAL, os);
    }
    if c.get(tx).map(|r| r.t[TX_T_OCCURRED_AT]).unwrap_or(0) == 0 {
        c.set_t(tx, TX_T_OCCURRED_AT, c.occurred_ms());
    }
    Some(cur)
}

fn tx_account(c: &mut Ctx, tx: RecKey) -> RecKey {
    let acc = c.get(tx).map(|r| r.s[TX_S_ACCOUNT]).unwrap_or(NONE);
    let cur = c.get(tx).map(|r| r.s[TX_S_CURRENCY]).unwrap_or(NONE);
    if acc != NONE {
        c.ensure(Kind::Account, acc)
    } else {
        c.account(cur, None)
    }
}

fn payment_authorized(c: &mut Ctx) -> Applied {
    let Some(tx) = tx_key(c) else {
        c.conflict("missing_transaction_reference", None);
        return Applied::RecordOnly;
    };
    if tx_setup(c, tx).is_none() {
        return Applied::RecordOnly;
    }
    let amount = c
        .money("authorized_minor")
        .or_else(|| c.money("amount_minor"))
        .unwrap_or(0);
    c.add_m(tx, TX_M_AUTHORIZED, amount);
    if c.get(tx).map(|r| r.status).unwrap_or(0) < TX_ST_AUTHORIZED
        || c.get(tx).map(|r| r.status).unwrap_or(0) == TX_ST_FAILED
    {
        c.set_status(tx, TX_ST_AUTHORIZED);
    }
    Applied::Yes
}

fn payment_captured(c: &mut Ctx) -> Applied {
    let Some(tx) = tx_key(c) else {
        c.conflict("missing_transaction_reference", None);
        return Applied::RecordOnly;
    };
    if tx_setup(c, tx).is_none() {
        return Applied::RecordOnly;
    }
    let amount = c
        .money("captured_minor")
        .or_else(|| c.money("amount_minor"))
        .unwrap_or(0);
    c.add_m(tx, TX_M_CAPTURED, amount);
    c.set_status(tx, TX_ST_CAPTURED);
    c.set_t(tx, TX_T_CAPTURED_AT, c.occurred_ms());
    let acc = tx_account(c, tx);
    c.add_m(acc, ACC_M_CAPTURED, amount);
    Applied::Yes
}

fn payment_failed(c: &mut Ctx, voided: bool) -> Applied {
    let Some(tx) = tx_key(c) else {
        c.conflict("missing_transaction_reference", None);
        return Applied::RecordOnly;
    };
    if tx_setup(c, tx).is_none() {
        return Applied::RecordOnly;
    }
    let attempt_id = c
        .e
        .payload_str("attempt")
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{}:{}", c.e.record_id, c.e.entry_id));
    let asym = c.intern(&attempt_id);
    let ak = c.ensure(Kind::Attempt, asym);
    let amount = c
        .money("amount_minor")
        .or_else(|| c.money("voided_minor"))
        .or_else(|| c.money("authorized_minor"))
        .unwrap_or(0);
    c.set_m(ak, ATT_M_AMOUNT, amount);
    c.set_s(ak, ATT_S_TRANSACTION, tx.id);
    let order = c.get(tx).map(|r| r.s[TX_S_ORDER]).unwrap_or(NONE);
    c.set_s(ak, ATT_S_ORDER, order);
    let cur = c.get(tx).map(|r| r.s[TX_S_CURRENCY]).unwrap_or(NONE);
    c.set_s(ak, ATT_S_CURRENCY, cur);
    let reason = c.str_sym("reason");
    c.set_s(ak, ATT_S_REASON, reason);
    c.set_t(ak, ATT_T_OCCURRED_AT, c.occurred_ms());
    c.set_status(ak, if voided { ATT_ST_VOIDED } else { ATT_ST_FAILED });
    c.link(tx, ak);
    if order != NONE {
        let ok = c.ensure(Kind::Order, order);
        c.link(ok, ak);
    }
    let status = c.get(tx).map(|r| r.status).unwrap_or(0);
    if voided {
        let v = if amount != 0 {
            amount
        } else {
            c.get(tx).map(|r| r.m[TX_M_AUTHORIZED]).unwrap_or(0)
        };
        c.add_m(tx, TX_M_VOIDED, v);
        if status != TX_ST_CAPTURED {
            c.set_status(tx, TX_ST_VOIDED);
        }
    } else {
        c.add_m(tx, TX_M_FAILED_ATTEMPTS, 1);
        if status == 0 {
            c.set_status(tx, TX_ST_FAILED);
        }
    }
    Applied::Yes
}

fn fee_booked(c: &mut Ctx) -> Applied {
    let Some(tx) = tx_key(c) else {
        c.conflict("missing_transaction_reference", None);
        return Applied::RecordOnly;
    };
    if tx_setup(c, tx).is_none() {
        return Applied::RecordOnly;
    }
    let fee = c.money("fee_minor").unwrap_or(0);
    c.add_m(tx, TX_M_FEES, fee);
    let acc = tx_account(c, tx);
    c.add_m(acc, ACC_M_FEES, fee);
    Applied::Yes
}

fn ledger_posted(c: &mut Ctx) -> Applied {
    let id = c
        .e
        .payload_str("ledger_entry")
        .map(|s| s.to_string())
        .unwrap_or_else(|| c.e.record_id.clone());
    let ls = c.intern(&id);
    let lk = c.ensure(Kind::Ledger, ls);
    let Some(cur) = c.currency(lk, LED_S_CURRENCY) else {
        return Applied::RecordOnly;
    };
    let gross = c.money("gross_minor").unwrap_or(0);
    let fee = c.money("fee_minor").unwrap_or(0);
    let net = c.money("net_minor").unwrap_or(gross - fee);
    c.set_m(lk, LED_M_GROSS, gross);
    c.set_m(lk, LED_M_FEE, fee);
    c.set_m(lk, LED_M_NET, net);
    let ptype = c
        .e
        .payload_str("posting_type")
        .unwrap_or("")
        .to_ascii_lowercase();
    let ps = c.intern(&ptype);
    c.set_s(lk, LED_S_POSTING_TYPE, ps);
    c.set_t(lk, LED_T_EFFECTIVE, c.occurred_ms());
    let acc = c.account(cur, None);
    c.set_s(lk, LED_S_ACCOUNT, acc.id);
    c.link(acc, lk);
    if let Some(tx) = c.ensure_ref(Kind::Transaction, "transaction") {
        c.set_s(lk, LED_S_TRANSACTION, tx.id);
        c.link(tx, lk);
    }
    if let Some(po) = c.ensure_ref(Kind::Payout, "payout") {
        c.set_s(lk, LED_S_PAYOUT, po.id);
        c.link(po, lk);
        let slot = match ptype.as_str() {
            "charge" | "capture" | "sale" | "payment" => PO_M_MEMBER_CAPTURES,
            "fee" | "charge_fee" | "processing_fee" => PO_M_MEMBER_FEES,
            "refund" | "refund_adjustment" => PO_M_MEMBER_REFUNDS,
            _ => PO_M_MEMBER_OTHER,
        };
        match slot {
            PO_M_MEMBER_CAPTURES => {
                c.add_m(po, PO_M_MEMBER_CAPTURES, gross);
                if fee != 0 {
                    c.add_m(po, PO_M_MEMBER_FEES, fee);
                }
            }
            PO_M_MEMBER_FEES => c.add_m(po, PO_M_MEMBER_FEES, if fee != 0 { fee } else { -net }),
            PO_M_MEMBER_REFUNDS => c.add_m(po, PO_M_MEMBER_REFUNDS, -net),
            _ => c.add_m(po, PO_M_MEMBER_OTHER, net),
        }
    }
    if matches!(ptype.as_str(), "adjustment" | "transfer" | "withdrawal" | "fx") {
        c.add_m(acc, ACC_M_LEDGER_OTHER, net);
    }
    Applied::Yes
}

fn balance_observed(c: &mut Ctx) -> Applied {
    let cur_str = c.e.currency().unwrap_or("").to_uppercase();
    let cur = c.intern(&cur_str);
    if cur == NONE {
        c.conflict("missing_currency", None);
        return Applied::RecordOnly;
    }
    let acc = c.account(cur, None);
    let observed = c.time_ms("observed_at").unwrap_or_else(|| c.occurred_ms());
    let prev = c.get(acc).map(|r| r.t[ACC_T_OBSERVED_AT]).unwrap_or(0);
    if prev != 0 && observed < prev {
        return Applied::Late;
    }
    // Snapshots supersede; never summed.
    for (k, slot) in [
        ("total_minor", ACC_M_OBS_TOTAL),
        ("processing_minor", ACC_M_OBS_PROCESSING),
        ("available_minor", ACC_M_OBS_AVAILABLE),
        ("held_minor", ACC_M_OBS_HELD),
    ] {
        let v = c.money(k).unwrap_or(i64::MIN);
        c.set_m(acc, slot, v);
    }
    c.set_t(acc, ACC_T_OBSERVED_AT, observed);
    c.set_status(acc, ACC_ST_OBSERVED);
    Applied::Yes
}

fn hold_recorded(c: &mut Ctx) -> Applied {
    let Some(hk) = c.ensure_ref(Kind::Hold, "hold") else {
        c.conflict("missing_hold_reference", None);
        return Applied::RecordOnly;
    };
    let Some(cur) = c.currency(hk, HOLD_S_CURRENCY) else {
        return Applied::RecordOnly;
    };
    let amount = c.money("amount_minor").unwrap_or(0);
    let prev_amount = c.get(hk).map(|r| r.m[HOLD_M_AMOUNT]).unwrap_or(0);
    let prev_status = c.get(hk).map(|r| r.status).unwrap_or(0);
    c.set_m(hk, HOLD_M_AMOUNT, amount);
    let reason = c.str_sym("reason");
    c.set_s(hk, HOLD_S_REASON, reason);
    if let Some(t) = c.time_ms("release_promised_at") {
        c.set_t(hk, HOLD_T_RELEASE_PROMISED_AT, t);
    }
    c.set_status(hk, HOLD_ST_ACTIVE);
    let acc = c.account(cur, None);
    c.set_s(hk, HOLD_S_ACCOUNT, acc.id);
    c.link(acc, hk);
    let delta = if prev_status == HOLD_ST_ACTIVE {
        amount - prev_amount
    } else {
        amount
    };
    c.add_m(acc, ACC_M_HELD, delta);
    if let Some(tx) = c.ensure_ref(Kind::Transaction, "transaction") {
        c.set_s(hk, HOLD_S_TRANSACTION, tx.id);
        c.link(tx, hk);
        c.add_m(tx, TX_M_HELD, delta);
        c.link_order_customer(hk);
    }
    Applied::Yes
}

fn hold_released(c: &mut Ctx) -> Applied {
    let Some(hk) = c.ensure_ref(Kind::Hold, "hold") else {
        c.conflict("missing_hold_reference", None);
        return Applied::RecordOnly;
    };
    let (amount, released, status, acc, tx) = {
        let r = c.get(hk).expect("hold");
        (
            r.m[HOLD_M_AMOUNT],
            r.m[HOLD_M_RELEASED],
            r.status,
            r.s[HOLD_S_ACCOUNT],
            r.s[HOLD_S_TRANSACTION],
        )
    };
    if status != HOLD_ST_ACTIVE {
        return Applied::RecordOnly;
    }
    let remaining = amount - released;
    let rel = c.money("amount_minor").unwrap_or(remaining).min(remaining);
    c.add_m(hk, HOLD_M_RELEASED, rel);
    if acc != NONE {
        let ak = c.ensure(Kind::Account, acc);
        c.add_m(ak, ACC_M_HELD, -rel);
    }
    if tx != NONE {
        let tk = c.ensure(Kind::Transaction, tx);
        c.add_m(tk, TX_M_HELD, -rel);
    }
    if released + rel >= amount {
        c.set_status(hk, HOLD_ST_RELEASED);
        c.set_t(hk, HOLD_T_RELEASED_AT, c.occurred_ms());
    }
    Applied::Yes
}

fn release_promised(c: &mut Ctx) -> Applied {
    let Some(hk) = c.ensure_ref(Kind::Hold, "hold") else {
        c.conflict("missing_hold_reference", None);
        return Applied::RecordOnly;
    };
    if let Some(t) = c.time_ms("release_promised_at") {
        c.set_t(hk, HOLD_T_RELEASE_PROMISED_AT, t);
    }
    Applied::Yes
}

// ---------------------------------------------------------------- refunds

fn refund_setup(c: &mut Ctx) -> Option<(RecKey, RecKey)> {
    let rf = c.ensure_ref(Kind::Refund, "refund")?;
    let tx = c.ensure_ref(Kind::Transaction, "transaction").or_else(|| {
        let t = c.get(rf).map(|r| r.s[RF_S_TRANSACTION]).unwrap_or(NONE);
        if t != NONE {
            Some(c.ensure(Kind::Transaction, t))
        } else {
            None
        }
    })?;
    c.currency(tx, TX_S_CURRENCY)?;
    let cur = c.get(tx).map(|r| r.s[TX_S_CURRENCY]).unwrap_or(NONE);
    c.set_s(rf, RF_S_TRANSACTION, tx.id);
    c.set_s_if_none(rf, RF_S_CURRENCY, cur);
    let dest = c.str_sym("destination");
    c.set_s_if_none(rf, RF_S_DESTINATION, dest);
    c.link(tx, rf);
    c.link_order_customer(rf);
    let order = c
        .order_key()
        .map(|o| o.id)
        .unwrap_or_else(|| c.get(tx).map(|r| r.s[TX_S_ORDER]).unwrap_or(NONE));
    if order != NONE {
        c.set_s_if_none(rf, RF_S_ORDER, order);
        let ok = c.ensure(Kind::Order, order);
        c.link(ok, rf);
        c.link(ok, tx);
        c.set_s_if_none(tx, TX_S_ORDER, order);
    }
    if c.get(tx).map(|r| r.s[TX_S_ACCOUNT]).unwrap_or(NONE) == NONE {
        let acc = c.account(cur, None);
        c.set_s(tx, TX_S_ACCOUNT, acc.id);
    }
    if c.get(rf).map(|r| r.t[RF_T_OCCURRED_AT]).unwrap_or(0) == 0 {
        c.set_t(rf, RF_T_OCCURRED_AT, c.occurred_ms());
    }
    Some((rf, tx))
}

fn refund_pending(c: &mut Ctx) -> Applied {
    let Some((rf, tx)) = refund_setup(c) else {
        c.conflict("missing_refund_reference", None);
        return Applied::RecordOnly;
    };
    let status = c.get(rf).map(|r| r.status).unwrap_or(0);
    if status != 0 {
        return Applied::RecordOnly;
    }
    let amount = c.money("amount_minor").unwrap_or(0);
    let held = c.money("held_minor").unwrap_or(amount);
    c.set_m(rf, RF_M_AMOUNT, amount);
    c.set_m(rf, RF_M_HELD, held);
    c.set_status(rf, RF_ST_PENDING);
    c.add_m(tx, TX_M_REFUND_PENDING, amount);
    c.add_m(tx, TX_M_HELD, held);
    let acc = tx_account(c, tx);
    c.add_m(acc, ACC_M_HELD, held);
    Applied::Yes
}

fn refund_completed(c: &mut Ctx) -> Applied {
    let Some((rf, tx)) = refund_setup(c) else {
        c.conflict("missing_refund_reference", None);
        return Applied::RecordOnly;
    };
    let (status, pending_amount, held) = {
        let r = c.get(rf).expect("refund");
        (r.status, r.m[RF_M_AMOUNT], r.m[RF_M_HELD])
    };
    if status == RF_ST_COMPLETED {
        return Applied::RecordOnly;
    }
    let amount = c.money("amount_minor").unwrap_or(pending_amount);
    let acc = tx_account(c, tx);
    if status == RF_ST_PENDING {
        c.add_m(tx, TX_M_REFUND_PENDING, -pending_amount);
        let rel = c.money("hold_released_minor").unwrap_or(held).min(held);
        c.add_m(tx, TX_M_HELD, -rel);
        c.add_m(acc, ACC_M_HELD, -rel);
        c.add_m(rf, RF_M_HELD, -rel);
    }
    c.set_m(rf, RF_M_AMOUNT, amount);
    c.set_status(rf, RF_ST_COMPLETED);
    c.add_m(tx, TX_M_REFUNDED, amount);
    c.add_m(acc, ACC_M_REFUNDED, amount);
    Applied::Yes
}

fn refund_failed(c: &mut Ctx) -> Applied {
    let Some((rf, tx)) = refund_setup(c) else {
        c.conflict("missing_refund_reference", None);
        return Applied::RecordOnly;
    };
    let (status, pending_amount, held) = {
        let r = c.get(rf).expect("refund");
        (r.status, r.m[RF_M_AMOUNT], r.m[RF_M_HELD])
    };
    if status == RF_ST_PENDING {
        c.add_m(tx, TX_M_REFUND_PENDING, -pending_amount);
        c.add_m(tx, TX_M_HELD, -held);
        let acc = tx_account(c, tx);
        c.add_m(acc, ACC_M_HELD, -held);
        c.add_m(rf, RF_M_HELD, -held);
    }
    c.set_status(rf, RF_ST_FAILED);
    Applied::Yes
}

fn refund_reversed(c: &mut Ctx) -> Applied {
    let Some((rf, tx)) = refund_setup(c) else {
        c.conflict("missing_refund_reference", None);
        return Applied::RecordOnly;
    };
    let (status, amount) = {
        let r = c.get(rf).expect("refund");
        (r.status, r.m[RF_M_AMOUNT])
    };
    if status == RF_ST_COMPLETED {
        let a = c.money("amount_minor").unwrap_or(amount);
        c.add_m(tx, TX_M_REFUNDED, -a);
        let acc = tx_account(c, tx);
        c.add_m(acc, ACC_M_REFUNDED, -a);
    }
    c.set_status(rf, RF_ST_REVERSED);
    Applied::Yes
}

// ---------------------------------------------------------------- payouts and bank

fn payout_setup(c: &mut Ctx) -> Option<(RecKey, RecKey)> {
    let po = c.ensure_ref(Kind::Payout, "payout")?;
    let cur = c.currency(po, PO_S_CURRENCY)?;
    let acc_prev = c.get(po).map(|r| r.s[PO_S_ACCOUNT]).unwrap_or(NONE);
    let acc = if acc_prev != NONE {
        c.ensure(Kind::Account, acc_prev)
    } else {
        let a = c.account(cur, None);
        c.set_s(po, PO_S_ACCOUNT, a.id);
        a
    };
    c.link(acc, po);
    let trace = c.str_sym("trace_reference");
    c.set_s_if_none(po, PO_S_TRACE, trace);
    c.link_order_customer(po);
    if let Some(txs) = c.e.payload.get("transactions").and_then(|v| v.as_array()).cloned() {
        for t in txs {
            if let Some(s) = t.as_str() {
                let ts = c.intern(s);
                let tk = c.ensure(Kind::Transaction, ts);
                c.link(po, tk);
            }
        }
    }
    if let Some(tx) = c.ensure_ref(Kind::Transaction, "transaction") {
        c.link(po, tx);
    }
    Some((po, acc))
}

fn payout_announced(c: &mut Ctx) -> Applied {
    let Some((po, acc)) = payout_setup(c) else {
        c.conflict("missing_payout_reference", None);
        return Applied::RecordOnly;
    };
    let status = c.get(po).map(|r| r.status).unwrap_or(0);
    let amount = c.money("amount_minor").unwrap_or(0);
    if status != 0 {
        // Already announced/sent: an announcement after the fact changes nothing.
        if status == PO_ST_ANNOUNCED && c.get(po).map(|r| r.m[PO_M_AMOUNT]).unwrap_or(0) != amount
        {
            let old = c.get(po).map(|r| r.m[PO_M_AMOUNT]).unwrap_or(0);
            c.set_m(po, PO_M_AMOUNT, amount);
            c.add_m(acc, ACC_M_ANNOUNCED, amount - old);
            return Applied::Yes;
        }
        return Applied::RecordOnly;
    }
    c.set_m(po, PO_M_AMOUNT, amount);
    c.set_status(po, PO_ST_ANNOUNCED);
    c.set_t(po, PO_T_ANNOUNCED_AT, c.occurred_ms());
    c.add_m(acc, ACC_M_ANNOUNCED, amount);
    Applied::Yes
}

fn payout_sent(c: &mut Ctx) -> Applied {
    let Some((po, acc)) = payout_setup(c) else {
        c.conflict("missing_payout_reference", None);
        return Applied::RecordOnly;
    };
    let (status, prev_amount) = {
        let r = c.get(po).expect("payout");
        (r.status, r.m[PO_M_AMOUNT])
    };
    if status == PO_ST_SENT || status == PO_ST_REVERSED {
        return Applied::RecordOnly;
    }
    let amount = c.money("amount_minor").unwrap_or(prev_amount);
    if status == PO_ST_ANNOUNCED {
        c.add_m(acc, ACC_M_ANNOUNCED, -prev_amount);
    }
    c.set_m(po, PO_M_AMOUNT, amount);
    c.set_status(po, PO_ST_SENT);
    c.set_t(po, PO_T_SENT_AT, c.occurred_ms());
    c.add_m(acc, ACC_M_IN_TRANSIT, amount);
    c.add_m(acc, ACC_M_PAYOUT_SENT, amount);
    // A bank credit may already have been booked for this payout (bank entries ahead of
    // provider status): match it now.
    let banks: Vec<Sym> = c
        .get(po)
        .map(|r| r.linked(Kind::BankEntry).collect())
        .unwrap_or_default();
    for b in banks {
        let bk = RecKey::new(Kind::BankEntry, b);
        let (bstatus, bamount, bcur) = match c.get(bk) {
            Some(r) => (r.status, r.m[BANK_M_AMOUNT], r.s[BANK_S_CURRENCY]),
            None => continue,
        };
        let pcur = c.get(po).map(|r| r.s[PO_S_CURRENCY]).unwrap_or(NONE);
        if bstatus == BANK_ST_CREDIT_BOOKED && (bcur == pcur || bcur == NONE) {
            apply_bank_match(c, bk, po, acc, bamount);
        }
    }
    Applied::Yes
}

fn apply_bank_match(c: &mut Ctx, bk: RecKey, po: RecKey, acc: RecKey, amount: i64) {
    c.set_status(bk, BANK_ST_CREDIT_MATCHED);
    c.set_s(bk, BANK_S_PAYOUT, po.id);
    c.add_m(po, PO_M_BANK_CONFIRMED, amount);
    c.add_m(acc, ACC_M_IN_TRANSIT, -amount);
    c.add_m(acc, ACC_M_BANK_CONFIRMED, amount);
    c.link(bk, po);
    let orders: Vec<Sym> = c
        .get(po)
        .map(|r| r.linked(Kind::Order).collect())
        .unwrap_or_default();
    for o in orders {
        let ok = c.ensure(Kind::Order, o);
        c.link(ok, bk);
    }
}

fn payout_failed(c: &mut Ctx) -> Applied {
    let Some((po, acc)) = payout_setup(c) else {
        c.conflict("missing_payout_reference", None);
        return Applied::RecordOnly;
    };
    let (status, amount) = {
        let r = c.get(po).expect("payout");
        (r.status, r.m[PO_M_AMOUNT])
    };
    match status {
        PO_ST_ANNOUNCED => c.add_m(acc, ACC_M_ANNOUNCED, -amount),
        PO_ST_SENT => {
            c.add_m(acc, ACC_M_IN_TRANSIT, -amount);
            c.add_m(acc, ACC_M_PAYOUT_SENT, -amount);
        }
        _ => {}
    }
    c.set_status(po, PO_ST_FAILED);
    Applied::Yes
}

fn payout_reversed(c: &mut Ctx) -> Applied {
    let Some((po, acc)) = payout_setup(c) else {
        c.conflict("missing_payout_reference", None);
        return Applied::RecordOnly;
    };
    let (status, amount, confirmed) = {
        let r = c.get(po).expect("payout");
        (r.status, r.m[PO_M_AMOUNT], r.m[PO_M_BANK_CONFIRMED])
    };
    let rev = c.money("amount_minor").unwrap_or(amount);
    if status == PO_ST_SENT {
        let from_bank = rev.min(confirmed);
        let from_transit = rev - from_bank;
        c.add_m(acc, ACC_M_BANK_CONFIRMED, -from_bank);
        c.add_m(po, PO_M_BANK_CONFIRMED, -from_bank);
        c.add_m(acc, ACC_M_IN_TRANSIT, -from_transit);
        c.add_m(acc, ACC_M_PAYOUT_SENT, -rev);
        c.add_m(acc, ACC_M_PAYOUT_REVERSED, rev);
    } else if status == PO_ST_ANNOUNCED {
        c.add_m(acc, ACC_M_ANNOUNCED, -amount);
    }
    c.set_status(po, PO_ST_REVERSED);
    Applied::Yes
}

fn bank_booked(c: &mut Ctx, credit: bool) -> Applied {
    let Some(bk) = c.ensure_ref(Kind::BankEntry, "bank_entry") else {
        c.conflict("missing_bank_entry_reference", None);
        return Applied::RecordOnly;
    };
    let Some(cur) = c.currency(bk, BANK_S_CURRENCY) else {
        return Applied::RecordOnly;
    };
    let amount = c.money("amount_minor").unwrap_or(0);
    c.set_m(bk, BANK_M_AMOUNT, amount);
    let booked = c
        .time_ms("booked_at")
        .or_else(|| c.time_ms("value_at"))
        .unwrap_or_else(|| c.occurred_ms());
    c.set_t(bk, BANK_T_BOOKED_AT, booked);
    let reference = c.str_sym("reference");
    c.set_s_if_none(bk, BANK_S_REFERENCE, reference);
    let bank_account = c.str_sym("bank_account");
    c.set_s_if_none(bk, BANK_S_ACCOUNT, bank_account);
    let pending = matches!(
        c.e.payload_str("status").or(c.e.payload_str("booking_status")),
        Some("pending") | Some("PENDING")
    );
    if !credit {
        c.set_status(bk, BANK_ST_DEBIT_BOOKED);
        c.link_order_customer(bk);
        return Applied::Yes;
    }
    if pending {
        c.set_status(bk, BANK_ST_PENDING);
        c.link_order_customer(bk);
        return Applied::Yes;
    }
    c.set_status(bk, BANK_ST_CREDIT_BOOKED);
    c.link_order_customer(bk);
    if let Some(po) = c.ensure_ref(Kind::Payout, "payout") {
        c.set_s(bk, BANK_S_PAYOUT, po.id);
        c.link(bk, po);
        let (pstatus, pcur, pacc) = {
            let r = c.get(po).expect("payout");
            (r.status, r.s[PO_S_CURRENCY], r.s[PO_S_ACCOUNT])
        };
        if pstatus == PO_ST_SENT && pcur == cur && pacc != NONE {
            let acc = c.ensure(Kind::Account, pacc);
            apply_bank_match(c, bk, po, acc, amount);
        } else if pstatus == PO_ST_SENT && pcur != cur {
            c.conflict("bank_payout_currency_mismatch", None);
        }
        // Not yet sent: the link is kept; payout.sent matches it later.
    }
    Applied::Yes
}

fn bank_match(c: &mut Ctx, revised: bool) -> Applied {
    let Some(bk) = c.ensure_ref(Kind::BankEntry, "bank_entry") else {
        c.conflict("missing_bank_entry_reference", None);
        return Applied::RecordOnly;
    };
    let (bstatus, amount, cur, prev_po) = {
        let r = c.get(bk).expect("bank");
        (r.status, r.m[BANK_M_AMOUNT], r.s[BANK_S_CURRENCY], r.s[BANK_S_PAYOUT])
    };
    if revised && bstatus == BANK_ST_CREDIT_MATCHED && prev_po != NONE {
        let pk = c.ensure(Kind::Payout, prev_po);
        let pacc = c.get(pk).map(|r| r.s[PO_S_ACCOUNT]).unwrap_or(NONE);
        if pacc != NONE {
            let acc = c.ensure(Kind::Account, pacc);
            c.add_m(pk, PO_M_BANK_CONFIRMED, -amount);
            c.add_m(acc, ACC_M_IN_TRANSIT, amount);
            c.add_m(acc, ACC_M_BANK_CONFIRMED, -amount);
        }
        c.set_status(bk, BANK_ST_CREDIT_BOOKED);
        c.set_s(bk, BANK_S_PAYOUT, NONE);
    }
    if let Some(po) = c.ensure_ref(Kind::Payout, "payout") {
        let (pstatus, pcur, pacc) = {
            let r = c.get(po).expect("payout");
            (r.status, r.s[PO_S_CURRENCY], r.s[PO_S_ACCOUNT])
        };
        let bstatus = c.get(bk).map(|r| r.status).unwrap_or(0);
        c.link(bk, po);
        c.set_s(bk, BANK_S_PAYOUT, po.id);
        if bstatus == BANK_ST_CREDIT_BOOKED && pstatus == PO_ST_SENT && pcur == cur && pacc != NONE {
            let acc = c.ensure(Kind::Account, pacc);
            apply_bank_match(c, bk, po, acc, amount);
        }
    }
    Applied::Yes
}

// ---------------------------------------------------------------- shipments

fn ship_key(c: &mut Ctx) -> Option<RecKey> {
    if let Some(k) = c.ensure_ref(Kind::Shipment, "shipment") {
        return Some(k);
    }
    let tracking = c.e.payload_str("tracking_number")?.to_string();
    let ts = c.intern(&tracking);
    let sk = c.st.tracking_index_get(ts)?;
    Some(c.ensure(Kind::Shipment, sk))
}

fn ship_setup(c: &mut Ctx, sk: RecKey) {
    c.link_order_customer(sk);
    if let Some(o) = c.order_key() {
        c.set_s_if_none(sk, SHIP_S_ORDER, o.id);
    }
    if let Some(l) = c.ensure_ref(Kind::Line, "line") {
        c.set_s_if_none(sk, SHIP_S_LINE, l.id);
        c.link(sk, l);
    }
    if let Some(i) = c.item_key() {
        c.set_s_if_none(sk, SHIP_S_ITEM, i.id);
    }
    let carrier = c.str_sym("carrier");
    c.set_s_if_none(sk, SHIP_S_CARRIER, carrier);
    let tracking = c.str_sym("tracking_number");
    if tracking != NONE {
        c.set_s_if_none(sk, SHIP_S_TRACKING, tracking);
        c.st.tracking_index_insert(tracking, sk.id);
    }
}

fn shipment_observed(c: &mut Ctx) -> Applied {
    let Some(sk) = ship_key(c) else {
        c.conflict("missing_shipment_reference", None);
        return Applied::RecordOnly;
    };
    ship_setup(c, sk);
    if let Some(q) = c.qty("quantity") {
        c.set_q(sk, SHIP_Q_QUANTITY, q);
    }
    let state = c.e.payload_str("state").unwrap_or("observed");
    let mapped = map_ship_state(state);
    let cur = c.get(sk).map(|r| r.status).unwrap_or(0);
    // Labels never count as handover; only explicit milestones advance status.
    if mapped > cur && mapped != SHIP_ST_DISPATCHED {
        c.set_status(sk, mapped);
    }
    Applied::Yes
}

fn map_ship_state(s: &str) -> u8 {
    match s.to_ascii_lowercase().as_str() {
        "delivered" => SHIP_ST_DELIVERED,
        "exception" | "failed_attempt" | "damaged" | "returned_to_sender" | "lost" => {
            SHIP_ST_EXCEPTION
        }
        "in_transit" | "transit" | "out_for_delivery" => SHIP_ST_IN_TRANSIT,
        "dispatched" | "handed_over" | "pickup" | "picked_up" | "shipped" => SHIP_ST_DISPATCHED,
        "cancelled" => SHIP_ST_CANCELLED,
        _ => SHIP_ST_OBSERVED,
    }
}

fn shipment_dispatched(c: &mut Ctx) -> Applied {
    let Some(sk) = ship_key(c) else {
        c.conflict("missing_shipment_reference", None);
        return Applied::RecordOnly;
    };
    ship_setup(c, sk);
    let qty = c.qty("quantity").unwrap_or(Decimal::ZERO);
    c.set_q(sk, SHIP_Q_QUANTITY, qty);
    let cur = c.get(sk).map(|r| r.status).unwrap_or(0);
    if cur < SHIP_ST_DISPATCHED {
        c.set_status(sk, SHIP_ST_DISPATCHED);
    }
    c.set_t(sk, SHIP_T_HANDOVER_AT, c.occurred_ms());
    // Stock movement (only when the shop reports it; the carrier never moves stock).
    if let Some(delta) = c.qty("physical_stock_delta") {
        if let Some(item) = c.item_key().or_else(|| {
            let i = c.get(sk).map(|r| r.s[SHIP_S_ITEM]).unwrap_or(NONE);
            if i != NONE {
                Some(c.ensure(Kind::Item, i))
            } else {
                None
            }
        }) {
            c.stock_delta(item, delta, Decimal::ZERO);
        }
    }
    // Reservation release.
    if let Some(res) = c.ensure_ref(Kind::Reservation, "reservation") {
        let released = c.qty("reservation_released").or(Some(qty));
        c.release_reservation(res, released);
        c.link(sk, res);
    }
    // Line / order progress.
    let line = c.get(sk).map(|r| r.s[SHIP_S_LINE]).unwrap_or(NONE);
    let order = c.get(sk).map(|r| r.s[SHIP_S_ORDER]).unwrap_or(NONE);
    if line != NONE {
        let lk = c.ensure(Kind::Line, line);
        c.add_q(lk, LINE_Q_DISPATCHED, qty);
    } else if order != NONE {
        // Single-line orders: attribute to the only line.
        let lines: Vec<Sym> = c
            .get(RecKey::new(Kind::Order, order))
            .map(|r| r.linked(Kind::Line).collect())
            .unwrap_or_default();
        if lines.len() == 1 {
            let lk = c.ensure(Kind::Line, lines[0]);
            c.add_q(lk, LINE_Q_DISPATCHED, qty);
            c.set_s(sk, SHIP_S_LINE, lines[0]);
        }
    }
    if order != NONE {
        let ok = c.ensure(Kind::Order, order);
        c.add_q(ok, ORDER_Q_DISPATCHED, qty);
        let now = c.occurred_ms();
        c.set_t(ok, ORDER_T_LAST_SHIPMENT_AT, now);
    }
    Applied::Yes
}

fn shipment_delivered(c: &mut Ctx) -> Applied {
    let Some(sk) = ship_key(c) else {
        c.conflict("missing_shipment_reference", None);
        return Applied::RecordOnly;
    };
    ship_setup(c, sk);
    let cur = c.get(sk).map(|r| r.status).unwrap_or(0);
    if cur == SHIP_ST_DELIVERED {
        return Applied::RecordOnly;
    }
    let qty = c
        .qty("quantity")
        .unwrap_or_else(|| c.get(sk).map(|r| r.q[SHIP_Q_QUANTITY]).unwrap_or(Decimal::ZERO));
    c.set_status(sk, SHIP_ST_DELIVERED);
    c.set_t(sk, SHIP_T_DELIVERED_AT, c.occurred_ms());
    c.add_q(sk, SHIP_Q_DELIVERED, qty);
    let line = c.get(sk).map(|r| r.s[SHIP_S_LINE]).unwrap_or(NONE);
    let order = c.get(sk).map(|r| r.s[SHIP_S_ORDER]).unwrap_or(NONE);
    if line != NONE {
        let lk = c.ensure(Kind::Line, line);
        c.add_q(lk, LINE_Q_DELIVERED, qty);
    } else if order != NONE {
        let lines: Vec<Sym> = c
            .get(RecKey::new(Kind::Order, order))
            .map(|r| r.linked(Kind::Line).collect())
            .unwrap_or_default();
        if lines.len() == 1 {
            let lk = c.ensure(Kind::Line, lines[0]);
            c.add_q(lk, LINE_Q_DELIVERED, qty);
        }
    }
    if order != NONE {
        let ok = c.ensure(Kind::Order, order);
        c.add_q(ok, ORDER_Q_DELIVERED, qty);
        let now = c.occurred_ms();
        c.set_t(ok, ORDER_T_LAST_SHIPMENT_AT, now);
    }
    Applied::Yes
}

fn shipment_cancelled(c: &mut Ctx) -> Applied {
    let Some(sk) = ship_key(c) else {
        c.conflict("missing_shipment_reference", None);
        return Applied::RecordOnly;
    };
    let (status, qty, line, order) = {
        let r = c.get(sk).expect("shipment");
        (r.status, r.q[SHIP_Q_QUANTITY], r.s[SHIP_S_LINE], r.s[SHIP_S_ORDER])
    };
    if status >= SHIP_ST_DISPATCHED && status < SHIP_ST_DELIVERED {
        if line != NONE {
            let lk = c.ensure(Kind::Line, line);
            c.add_q(lk, LINE_Q_DISPATCHED, -qty);
        }
        if order != NONE {
            let ok = c.ensure(Kind::Order, order);
            c.add_q(ok, ORDER_Q_DISPATCHED, -qty);
        }
    }
    c.set_status(sk, SHIP_ST_CANCELLED);
    Applied::Yes
}

fn scan_observed(c: &mut Ctx) -> Applied {
    let Some(sk) = ship_key(c) else {
        c.conflict("tracking_number_unlinked", None);
        return Applied::RecordOnly;
    };
    ship_setup(c, sk);
    let eff = c.time_ms("effective_time").unwrap_or_else(|| c.occurred_ms());
    let last = c.get(sk).map(|r| r.t[SHIP_T_LAST_SCAN_AT]).unwrap_or(0);
    if last != 0 && eff < last {
        return Applied::Late;
    }
    let code = c
        .e
        .payload_str("status_code")
        .or(c.e.payload_str("status"))
        .unwrap_or("")
        .to_string();
    let cs = c.intern(&code);
    c.set_s(sk, SHIP_S_LAST_SCAN_CODE, cs);
    c.set_t(sk, SHIP_T_LAST_SCAN_AT, eff);
    let mapped = map_ship_state(&code);
    let cur = c.get(sk).map(|r| r.status).unwrap_or(0);
    if mapped == SHIP_ST_DELIVERED && cur != SHIP_ST_DELIVERED {
        c.set_status(sk, SHIP_ST_DELIVERED);
        c.set_t(sk, SHIP_T_DELIVERED_AT, eff);
    } else if mapped == SHIP_ST_EXCEPTION && cur != SHIP_ST_DELIVERED {
        c.set_status(sk, SHIP_ST_EXCEPTION);
    } else if mapped == SHIP_ST_IN_TRANSIT && cur < SHIP_ST_IN_TRANSIT {
        c.set_status(sk, SHIP_ST_IN_TRANSIT);
    } else if mapped == SHIP_ST_IN_TRANSIT && cur == SHIP_ST_EXCEPTION {
        c.set_status(sk, SHIP_ST_IN_TRANSIT);
    }
    Applied::Yes
}

fn forecast_observed(c: &mut Ctx) -> Applied {
    let Some(sk) = ship_key(c) else {
        c.conflict("tracking_number_unlinked", None);
        return Applied::RecordOnly;
    };
    ship_setup(c, sk);
    if let Some(f) = c
        .time_ms("forecast")
        .or_else(|| c.time_ms("expected_at"))
        .or_else(|| c.time_ms("estimated_delivery_at"))
    {
        c.set_t(sk, SHIP_T_FORECAST_AT, f);
    }
    Applied::Yes
}

// ---------------------------------------------------------------- returns

fn return_setup(c: &mut Ctx) -> Option<RecKey> {
    let rk = c.ensure_ref(Kind::Return, "return")?;
    c.link_order_customer(rk);
    if let Some(o) = c.order_key() {
        c.set_s_if_none(rk, RET_S_ORDER, o.id);
    }
    if let Some(l) = c.ensure_ref(Kind::Line, "line") {
        c.set_s_if_none(rk, RET_S_LINE, l.id);
        c.link(rk, l);
    }
    if let Some(i) = c.item_key() {
        c.set_s_if_none(rk, RET_S_ITEM, i.id);
        c.link(rk, i);
    } else {
        let order = c.get(rk).map(|r| r.s[RET_S_ORDER]).unwrap_or(NONE);
        if order != NONE {
            let item = c
                .get(RecKey::new(Kind::Order, order))
                .map(|r| r.s[ORDER_S_ITEM])
                .unwrap_or(NONE);
            if item != NONE {
                c.set_s_if_none(rk, RET_S_ITEM, item);
                let ik = c.ensure(Kind::Item, item);
                c.link(rk, ik);
            }
        }
    }
    let unit = c.str_sym("unit");
    c.set_s_if_none(rk, RET_S_UNIT, unit);
    Some(rk)
}

fn return_approved(c: &mut Ctx, revision: bool) -> Applied {
    let Some(rk) = return_setup(c) else {
        c.conflict("missing_return_reference", None);
        return Applied::RecordOnly;
    };
    if c.e.currency().is_some() && c.currency(rk, RET_S_CURRENCY).is_none() {
        return Applied::RecordOnly;
    }
    if let Some(q) = c.qty("quantity") {
        c.set_q(rk, RET_Q_REQUESTED, q);
    }
    if let Some(m) = c.money("expected_credit_minor") {
        c.set_m(rk, RET_M_EXPECTED_CREDIT, m);
    }
    let status = c.get(rk).map(|r| r.status).unwrap_or(0);
    if !revision || status == 0 {
        c.set_status(rk, RET_ST_APPROVED);
        c.set_t(rk, RET_T_APPROVED_AT, c.occurred_ms());
    }
    Applied::Yes
}

fn return_cancelled(c: &mut Ctx) -> Applied {
    let Some(rk) = return_setup(c) else {
        c.conflict("missing_return_reference", None);
        return Applied::RecordOnly;
    };
    c.set_status(rk, RET_ST_CANCELLED);
    Applied::Yes
}

fn return_item(c: &mut Ctx, rk: RecKey) -> Option<RecKey> {
    let item = c.get(rk).map(|r| r.s[RET_S_ITEM]).unwrap_or(NONE);
    if item != NONE {
        Some(c.ensure(Kind::Item, item))
    } else {
        None
    }
}

fn return_received(c: &mut Ctx) -> Applied {
    let Some(rk) = return_setup(c) else {
        c.conflict("missing_return_reference", None);
        return Applied::RecordOnly;
    };
    let qty = c.qty("quantity").unwrap_or(Decimal::ZERO);
    let pdelta = c.qty("physical_stock_delta").unwrap_or(qty);
    let qdelta = c.qty("quarantine_delta").unwrap_or(qty);
    c.add_q(rk, RET_Q_RECEIVED, qty);
    c.add_q(rk, RET_Q_QUARANTINED, qdelta);
    let st = c.get(rk).map(|r| r.status).unwrap_or(0);
    if st < RET_ST_RECEIVED {
        c.set_status(rk, RET_ST_RECEIVED);
    }
    c.set_t(rk, RET_T_RECEIVED_AT, c.occurred_ms());
    let mut late = false;
    if let Some(item) = return_item(c, rk) {
        late = !c.stock_delta(item, pdelta, qdelta);
    }
    if late {
        Applied::Late
    } else {
        Applied::Yes
    }
}

fn return_restocked(c: &mut Ctx) -> Applied {
    let Some(rk) = return_setup(c) else {
        c.conflict("missing_return_reference", None);
        return Applied::RecordOnly;
    };
    let qty = c.qty("quantity").unwrap_or(Decimal::ZERO);
    let pdelta = c.qty("physical_stock_delta").unwrap_or(Decimal::ZERO);
    let qdelta = c.qty("quarantine_delta").unwrap_or(-qty);
    c.add_q(rk, RET_Q_RESTOCKED, qty);
    c.add_q(rk, RET_Q_QUARANTINED, qdelta);
    c.set_status(rk, RET_ST_RESTOCKED);
    let mut late = false;
    if let Some(item) = return_item(c, rk) {
        late = !c.stock_delta(item, pdelta, qdelta);
    }
    if late {
        Applied::Late
    } else {
        Applied::Yes
    }
}

fn return_disposition(c: &mut Ctx) -> Applied {
    let Some(rk) = return_setup(c) else {
        c.conflict("missing_return_reference", None);
        return Applied::RecordOnly;
    };
    let d = c.str_sym("disposition");
    c.set_s(rk, RET_S_DISPOSITION, d);
    Applied::Yes
}

fn entitlement(c: &mut Ctx, revision: bool) -> Applied {
    let Some(ek) = c.ensure_ref(Kind::Entitlement, "entitlement") else {
        c.conflict("missing_entitlement_reference", None);
        return Applied::RecordOnly;
    };
    if c.e.currency().is_some() && c.currency(ek, ENT_S_CURRENCY).is_none() {
        return Applied::RecordOnly;
    }
    if let Some(a) = c.money("amount_minor") {
        c.set_m(ek, ENT_M_AMOUNT, a);
    }
    c.link_order_customer(ek);
    if let Some(o) = c.order_key() {
        c.set_s_if_none(ek, ENT_S_ORDER, o.id);
    }
    if let Some(i) = invoice_key(c) {
        c.set_s_if_none(ek, ENT_S_INVOICE, i.id);
        c.link(ek, i);
    }
    if let Some(cr) = c.ensure_ref(Kind::Credit, "credit") {
        c.set_s_if_none(ek, ENT_S_CREDIT, cr.id);
        c.link(ek, cr);
    }
    if let Some(tx) = c
        .ensure_ref(Kind::Transaction, "original_transaction")
        .or_else(|| c.ensure_ref(Kind::Transaction, "transaction"))
    {
        c.set_s_if_none(ek, ENT_S_TRANSACTION, tx.id);
        c.link(ek, tx);
    }
    let dest = c.str_sym("destination");
    if dest != NONE {
        c.set_s(ek, ENT_S_DESTINATION, dest);
    }
    let state = c.e.payload_str("state").unwrap_or("approved");
    let st = match state {
        "void" | "withdrawn" | "cancelled" => ENT_ST_VOID,
        _ => ENT_ST_APPROVED,
    };
    c.set_status(ek, st);
    if !revision {
        let at = c.time_ms("approved_at").unwrap_or_else(|| c.occurred_ms());
        c.set_t(ek, ENT_T_APPROVED_AT, at);
    }
    Applied::Yes
}

// ---------------------------------------------------------------- disputes

fn dispute_setup(c: &mut Ctx) -> Option<RecKey> {
    let dk = c.ensure_ref(Kind::Dispute, "dispute")?;
    c.link_order_customer(dk);
    if let Some(tx) = c
        .ensure_ref(Kind::Transaction, "original_transaction")
        .or_else(|| c.ensure_ref(Kind::Transaction, "transaction"))
    {
        c.set_s_if_none(dk, DISP_S_TRANSACTION, tx.id);
        c.link(dk, tx);
        let order = c.get(tx).map(|r| r.s[TX_S_ORDER]).unwrap_or(NONE);
        if order != NONE {
            c.set_s_if_none(dk, DISP_S_ORDER, order);
            let ok = c.ensure(Kind::Order, order);
            c.link(ok, dk);
        }
    }
    if let Some(o) = c.order_key() {
        c.set_s_if_none(dk, DISP_S_ORDER, o.id);
    }
    Some(dk)
}

fn dispute_opened(c: &mut Ctx) -> Applied {
    let Some(dk) = dispute_setup(c) else {
        c.conflict("missing_dispute_reference", None);
        return Applied::RecordOnly;
    };
    if c.currency(dk, DISP_S_CURRENCY).is_none() {
        return Applied::RecordOnly;
    }
    if let Some(a) = c.money("amount_minor") {
        c.set_m(dk, DISP_M_AMOUNT, a);
    }
    c.set_status(dk, DISP_ST_OPEN);
    c.set_t(dk, DISP_T_OPENED_AT, c.occurred_ms());
    Applied::Yes
}

fn dispute_resolved(c: &mut Ctx) -> Applied {
    let Some(dk) = dispute_setup(c) else {
        c.conflict("missing_dispute_reference", None);
        return Applied::RecordOnly;
    };
    let outcome = c.str_sym("outcome");
    c.set_s(dk, DISP_S_OUTCOME, outcome);
    c.set_status(dk, DISP_ST_RESOLVED);
    Applied::Yes
}

fn chargeback_debit(c: &mut Ctx) -> Applied {
    let Some(dk) = dispute_setup(c) else {
        c.conflict("missing_dispute_reference", None);
        return Applied::RecordOnly;
    };
    if c.currency(dk, DISP_S_CURRENCY).is_none() {
        return Applied::RecordOnly;
    }
    let debit = c.money("debit_minor").or_else(|| c.money("amount_minor")).unwrap_or(0);
    let fee = c.money("fee_minor").unwrap_or(0);
    c.add_m(dk, DISP_M_DEBIT, debit);
    c.add_m(dk, DISP_M_FEE, fee);
    let tx = c.get(dk).map(|r| r.s[DISP_S_TRANSACTION]).unwrap_or(NONE);
    if tx != NONE {
        let tk = c.ensure(Kind::Transaction, tx);
        c.add_m(tk, TX_M_CB_DEBIT, debit);
        c.add_m(tk, TX_M_CB_FEE, fee);
        if c.get(tk).map(|r| r.s[TX_S_CURRENCY]).unwrap_or(NONE) != NONE {
            let acc = tx_account(c, tk);
            c.add_m(acc, ACC_M_CB_DEBIT, debit + fee);
        }
    }
    Applied::Yes
}

fn chargeback_reversed(c: &mut Ctx) -> Applied {
    let Some(dk) = dispute_setup(c) else {
        c.conflict("missing_dispute_reference", None);
        return Applied::RecordOnly;
    };
    let rev = c
        .money("reversal_minor")
        .or_else(|| c.money("amount_minor"))
        .unwrap_or(0);
    c.add_m(dk, DISP_M_REVERSED, rev);
    let tx = c.get(dk).map(|r| r.s[DISP_S_TRANSACTION]).unwrap_or(NONE);
    if tx != NONE {
        let tk = c.ensure(Kind::Transaction, tx);
        c.add_m(tk, TX_M_CB_REVERSED, rev);
        if c.get(tk).map(|r| r.s[TX_S_CURRENCY]).unwrap_or(NONE) != NONE {
            let acc = tx_account(c, tk);
            c.add_m(acc, ACC_M_CB_REVERSED, rev);
        }
    }
    Applied::Yes
}

// ---------------------------------------------------------------- promises, policy, context

fn customer_promise(c: &mut Ctx, revision: bool) -> Applied {
    let Some(pk) = c.ensure_ref(Kind::Promise, "promise") else {
        c.conflict("missing_promise_reference", None);
        return Applied::RecordOnly;
    };
    c.link_order_customer(pk);
    if let Some(o) = c.order_key() {
        c.set_s_if_none(pk, PROM_S_ORDER, o.id);
        let cust = c.get(o).map(|r| r.s[ORDER_S_CUSTOMER]).unwrap_or(NONE);
        c.set_s_if_none(pk, PROM_S_CUSTOMER, cust);
    }
    if let Some(l) = c.ensure_ref(Kind::Line, "line") {
        c.set_s_if_none(pk, PROM_S_LINE, l.id);
    }
    let kind = c.str_sym("promise_kind");
    c.set_s_if_none(pk, PROM_S_KIND, kind);
    let tz = c.str_sym("timezone");
    c.set_s_if_none(pk, PROM_S_TIMEZONE, tz);
    if let Some(t) = c.time_ms("promised_at") {
        let prev = c.get(pk).map(|r| r.t[PROM_T_PROMISED_AT]).unwrap_or(0);
        if revision && prev != 0 {
            c.set_t(pk, PROM_T_PREVIOUS_PROMISED_AT, prev);
        }
        c.set_t(pk, PROM_T_PROMISED_AT, t);
    }
    if let Some(r) = c.money("revision") {
        c.set_m(pk, PROM_M_REVISION, r);
    } else if revision {
        c.add_m(pk, PROM_M_REVISION, 1);
    }
    let state = c.e.payload_str("state").unwrap_or("active");
    c.set_status(
        pk,
        if state == "withdrawn" {
            PROM_ST_WITHDRAWN
        } else {
            PROM_ST_ACTIVE
        },
    );
    Applied::Yes
}

fn supply_commitment(c: &mut Ctx, revision: bool) -> Applied {
    let Some(sk) = c.ensure_ref(Kind::Supply, "promise") else {
        c.conflict("missing_promise_reference", None);
        return Applied::RecordOnly;
    };
    if let Some(i) = c.item_key() {
        c.set_s_if_none(sk, SUP_S_ITEM, i.id);
        c.link(sk, i);
    }
    let sup = c.str_sym("supplier");
    c.set_s_if_none(sk, SUP_S_SUPPLIER, sup);
    let unit = c.str_sym("unit");
    c.set_s_if_none(sk, SUP_S_UNIT, unit);
    let loc = c.str_sym("location");
    c.set_s_if_none(sk, SUP_S_LOCATION, loc);
    if let Some(q) = c.qty("quantity") {
        c.set_q(sk, SUP_Q_QUANTITY, q);
    }
    if let Some(t) = c.time_ms("promised_at") {
        let prev = c.get(sk).map(|r| r.t[SUP_T_PROMISED_AT]).unwrap_or(0);
        if revision && prev != 0 {
            c.set_t(sk, SUP_T_PREVIOUS_PROMISED_AT, prev);
        }
        c.set_t(sk, SUP_T_PROMISED_AT, t);
    }
    if revision {
        c.add_m(sk, SUP_M_REVISION, 1);
    }
    let state = c.e.payload_str("state").unwrap_or("active");
    c.set_status(
        sk,
        match state {
            "received" => SUP_ST_RECEIVED,
            "cancelled" => SUP_ST_CANCELLED,
            _ => SUP_ST_ACTIVE,
        },
    );
    if let Some(links) = c
        .e
        .payload
        .get("allocation_links")
        .and_then(|v| v.as_array())
        .cloned()
    {
        for l in links {
            let order = l
                .as_str()
                .map(|s| s.to_string())
                .or_else(|| l.get("order").and_then(|v| v.as_str()).map(|s| s.to_string()));
            if let Some(o) = order {
                let os = c.intern(&o);
                let ok = c.ensure(Kind::Order, os);
                c.link(sk, ok);
            }
        }
    }
    Applied::Yes
}

fn rule(c: &mut Ctx, revision: bool) -> Applied {
    let id = c
        .e
        .payload_str("rule")
        .or(c.e.payload_str("rule_id"))
        .map(|s| s.to_string())
        .unwrap_or_else(|| c.e.record_id.clone());
    let rs = c.intern(&id);
    let rk = c.ensure(Kind::Policy, rs);
    for (k, slot) in [
        ("rule_kind", POL_S_KIND),
        ("priority_method", POL_S_PRIORITY_METHOD),
        ("invoicing_trigger", POL_S_INVOICING_TRIGGER),
        ("reminder_policy", POL_S_REMINDER_POLICY),
        ("timezone", POL_S_TIMEZONE),
        ("currency", POL_S_CURRENCY),
        ("attention_rule", POL_S_ATTENTION_RULE),
        ("scope", POL_S_SCOPE),
    ] {
        let s = c.str_sym(k);
        if s != NONE {
            c.set_s(rk, slot, s);
        }
    }
    for (k, slot) in [
        ("tolerance_minor", POL_M_TOLERANCE),
        ("stale_scan_seconds", POL_M_STALE_SCAN_SECONDS),
        ("version", POL_M_VERSION),
        ("risk_hours", POL_M_RISK_HOURS),
    ] {
        if let Some(v) = c.money(k) {
            c.set_m(rk, slot, v);
        }
    }
    if let Some(t) = c.time_ms("effective_from") {
        c.set_t(rk, POL_T_EFFECTIVE_FROM, t);
    } else if !revision {
        c.set_t(rk, POL_T_EFFECTIVE_FROM, c.occurred_ms());
    }
    c.set_status(rk, POL_ST_ACTIVE);
    Applied::Yes
}

fn case(c: &mut Ctx, _revision: bool) -> Applied {
    let Some(ck) = c.ensure_ref(Kind::Case, "case") else {
        c.conflict("missing_case_reference", None);
        return Applied::RecordOnly;
    };
    c.link_order_customer(ck);
    if let Some(cu) = c.ensure_ref(Kind::Customer, "customer") {
        c.set_s_if_none(ck, CASE_S_CUSTOMER, cu.id);
    }
    if let Some(i) = invoice_key(c) {
        c.set_s_if_none(ck, CASE_S_INVOICE, i.id);
        c.link(ck, i);
    }
    if let Some(t) = c.ensure_ref(Kind::Transaction, "transaction") {
        c.set_s_if_none(ck, CASE_S_TRANSACTION, t.id);
        c.link(ck, t);
    }
    if let Some(o) = c.order_key() {
        c.set_s_if_none(ck, CASE_S_ORDER, o.id);
    }
    let status = c.e.payload_str("status").unwrap_or("open").to_string();
    let ss = c.intern(&status);
    c.set_s(ck, CASE_S_STATUS, ss);
    let st = match status.as_str() {
        "closed" | "resolved" | "withdrawn" => CASE_ST_CLOSED,
        _ => CASE_ST_OPEN,
    };
    c.set_status(ck, st);
    if let Some(t) = c.time_ms("agreed_extension_until") {
        c.set_t(ck, CASE_T_EXTENSION_UNTIL, t);
    }
    Applied::Yes
}

fn identity_link(c: &mut Ctx, status: u8) -> Applied {
    let id = c
        .e
        .payload_str("link")
        .or(c.e.payload_str("link_id"))
        .map(|s| s.to_string())
        .unwrap_or_else(|| c.e.record_id.clone());
    let ls = c.intern(&id);
    let lk = c.ensure(Kind::Link, ls);
    for (k, slot) in [
        ("entity_type", LINK_S_ENTITY_TYPE),
        ("entity_id", LINK_S_ENTITY_ID),
        ("external_id", LINK_S_EXTERNAL_ID),
        ("target_id", LINK_S_TARGET),
        ("relationship_type", LINK_S_RELATIONSHIP),
        ("connection", LINK_S_CONNECTION),
        ("confidence", LINK_S_CONFIDENCE),
    ] {
        let s = c.str_sym(k);
        if s != NONE {
            c.set_s(lk, slot, s);
        }
    }
    c.set_status(lk, status);
    if status == LINK_ST_CONFLICT {
        c.conflict("identity_link_conflict", None);
        // Record-only effect but the conflict is visible; keep applied marker.
    }
    if let (Some(et), Some(eid)) = (c.e.payload_str("entity_type"), c.e.payload_str("entity_id")) {
        if let Some(kind) = Kind::parse(et) {
            let s = c.intern(eid);
            let ek = c.ensure(kind, s);
            c.link(ek, lk);
        }
    }
    Applied::Yes
}

fn coverage(c: &mut Ctx, gap: bool) -> Applied {
    let conn = c
        .e
        .payload_str("connection")
        .map(|s| s.to_string())
        .or_else(|| c.e.connection_id.map(|u| u.to_string()))
        .unwrap_or_default();
    let cap = c.e.payload_str("capability").unwrap_or("").to_string();
    let id = c
        .e
        .payload_str("coverage")
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{conn}|{cap}"));
    let cs = c.intern(&id);
    let ck = c.ensure(Kind::Coverage, cs);
    let conn_s = c.intern(&conn);
    let cap_s = c.intern(&cap);
    c.set_s(ck, COV_S_CONNECTION, conn_s);
    c.set_s(ck, COV_S_CAPABILITY, cap_s);
    let scope = c.str_sym("entity_scope");
    c.set_s_if_none(ck, COV_S_ENTITY_SCOPE, scope);
    if let Some(t) = c.time_ms("history_start") {
        c.set_t(ck, COV_T_HISTORY_START, t);
    }
    if let Some(t) = c.time_ms("complete_through") {
        c.set_t(ck, COV_T_COMPLETE_THROUGH, t);
    }
    if gap {
        c.set_status(ck, COV_ST_GAP);
    } else {
        let complete = c.e.payload_bool("backfill_complete").unwrap_or(false);
        c.set_status(ck, if complete { COV_ST_COMPLETE } else { COV_ST_INCOMPLETE });
    }
    Applied::Yes
}

fn communication(c: &mut Ctx, reviewed: bool) -> Applied {
    let id = c
        .e
        .payload_str("message")
        .or(c.e.payload_str("message_id"))
        .map(|s| s.to_string())
        .unwrap_or_else(|| c.e.record_id.clone());
    let ms = c.intern(&id);
    let mk = c.ensure(Kind::Communication, ms);
    c.link_order_customer(mk);
    if let Some(cu) = c.ensure_ref(Kind::Customer, "customer") {
        c.set_s_if_none(mk, COM_S_CUSTOMER, cu.id);
    }
    if let Some(o) = c.order_key() {
        c.set_s_if_none(mk, COM_S_ORDER, o.id);
    }
    let actor = c.str_sym("actor");
    c.set_s_if_none(mk, COM_S_ACTOR, actor);
    let summary = c.str_sym("summary");
    if summary != NONE {
        c.set_s(mk, COM_S_SUMMARY, summary);
    }
    if let Some(t) = c.time_ms("sent_at") {
        c.set_t(mk, COM_T_SENT_AT, t);
    } else if c.get(mk).map(|r| r.t[COM_T_SENT_AT]).unwrap_or(0) == 0 {
        c.set_t(mk, COM_T_SENT_AT, c.occurred_ms());
    }
    c.set_status(mk, if reviewed { COM_ST_REVIEWED } else { COM_ST_OBSERVED });
    Applied::Yes
}

fn allocation(c: &mut Ctx, revision: bool) -> Applied {
    let Some(ak) = c.ensure_ref(Kind::Allocation, "allocation") else {
        c.conflict("missing_allocation_reference", None);
        return Applied::RecordOnly;
    };
    let Some(inv) = invoice_key(c) else {
        c.conflict("missing_invoice_reference", None);
        return Applied::RecordOnly;
    };
    if c.currency(ak, ALLOC_S_CURRENCY).is_none() {
        return Applied::RecordOnly;
    }
    let cur = c.get(ak).map(|r| r.s[ALLOC_S_CURRENCY]).unwrap_or(NONE);
    let inv_cur = c.get(inv).map(|r| r.s[INV_S_CURRENCY]).unwrap_or(NONE);
    if inv_cur != NONE && cur != NONE && inv_cur != cur {
        c.conflict("currency_mismatch", None);
        return Applied::RecordOnly;
    }
    let old = c.get(ak).map(|r| r.m[ALLOC_M_AMOUNT]).unwrap_or(0);
    let amount = c.money("amount_minor").unwrap_or(old);
    c.set_m(ak, ALLOC_M_AMOUNT, amount);
    c.set_s(ak, ALLOC_S_INVOICE, inv.id);
    let conf = c.str_sym("confidence");
    if conf != NONE {
        c.set_s(ak, ALLOC_S_CONFIDENCE, conf);
    }
    c.set_status(ak, if revision { ALLOC_ST_REVISED } else { ALLOC_ST_RECORDED });
    c.add_m(inv, INV_M_ALLOCATED, amount - old);
    c.link(inv, ak);
    if let Some(tx) = c.ensure_ref(Kind::Transaction, "transaction") {
        c.set_s(ak, ALLOC_S_TRANSACTION, tx.id);
        c.link(tx, ak);
        c.link(inv, tx);
    }
    Applied::Yes
}
