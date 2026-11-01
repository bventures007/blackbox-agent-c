//! Per-tenant compact state. Every business record is a `Rec` with fixed slot arrays
//! (money `m`, quantity `q`, symbol links `s`, times `t`, status) so that reducers can keep a
//! mechanical undo log for `supersedes_entry_id` corrections and so that snapshots stay small.
//! Slot meanings are defined per record kind in `fields`.

use chrono::{DateTime, TimeZone, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// Interned string id. 0 is reserved for "none".
pub type Sym = u32;
pub const NONE: Sym = 0;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Interner {
    strings: Vec<String>,
    #[serde(skip)]
    index: HashMap<String, Sym>,
}

impl Interner {
    pub fn new() -> Self {
        let mut i = Interner::default();
        i.strings.push(String::new());
        i
    }

    pub fn rebuild_index(&mut self) {
        self.index.clear();
        for (i, s) in self.strings.iter().enumerate() {
            if i > 0 {
                self.index.insert(s.clone(), i as Sym);
            }
        }
    }

    pub fn intern(&mut self, s: &str) -> Sym {
        if s.is_empty() {
            return NONE;
        }
        if let Some(&id) = self.index.get(s) {
            return id;
        }
        let id = self.strings.len() as Sym;
        self.strings.push(s.to_string());
        self.index.insert(s.to_string(), id);
        id
    }

    pub fn get(&self, s: &str) -> Option<Sym> {
        if s.is_empty() {
            return None;
        }
        self.index.get(s).copied()
    }

    pub fn resolve(&self, id: Sym) -> &str {
        self.strings.get(id as usize).map(|s| s.as_str()).unwrap_or("")
    }

    pub fn resolve_opt(&self, id: Sym) -> Option<&str> {
        if id == NONE {
            None
        } else {
            Some(self.resolve(id))
        }
    }

    pub fn len(&self) -> usize {
        self.strings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.strings.len() <= 1
    }

    pub fn approx_bytes(&self) -> usize {
        self.strings.iter().map(|s| s.len() + 24).sum::<usize>() * 2 + self.strings.len() * 16
    }
}

/// Record kinds. The numeric value is stable (snapshot format).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[repr(u8)]
pub enum Kind {
    Order = 1,
    Line = 2,
    Item = 3,
    Reservation = 4,
    Invoice = 5,
    Credit = 6,
    Transaction = 7,
    Refund = 8,
    Payout = 9,
    BankEntry = 10,
    Shipment = 11,
    Return = 12,
    Hold = 13,
    Dispute = 14,
    Promise = 15,
    Supply = 16,
    Policy = 17,
    Case = 18,
    Link = 19,
    Coverage = 20,
    Communication = 21,
    Dispatch = 22,
    Entitlement = 23,
    Allocation = 24,
    Account = 25,
    Customer = 26,
    Ledger = 27,
    Attempt = 28,
}

impl Kind {
    pub const ALL: [Kind; 28] = [
        Kind::Order,
        Kind::Line,
        Kind::Item,
        Kind::Reservation,
        Kind::Invoice,
        Kind::Credit,
        Kind::Transaction,
        Kind::Refund,
        Kind::Payout,
        Kind::BankEntry,
        Kind::Shipment,
        Kind::Return,
        Kind::Hold,
        Kind::Dispute,
        Kind::Promise,
        Kind::Supply,
        Kind::Policy,
        Kind::Case,
        Kind::Link,
        Kind::Coverage,
        Kind::Communication,
        Kind::Dispatch,
        Kind::Entitlement,
        Kind::Allocation,
        Kind::Account,
        Kind::Customer,
        Kind::Ledger,
        Kind::Attempt,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Order => "order",
            Kind::Line => "line",
            Kind::Item => "item",
            Kind::Reservation => "reservation",
            Kind::Invoice => "invoice",
            Kind::Credit => "credit",
            Kind::Transaction => "transaction",
            Kind::Refund => "refund",
            Kind::Payout => "payout",
            Kind::BankEntry => "bank_entry",
            Kind::Shipment => "shipment",
            Kind::Return => "return",
            Kind::Hold => "hold",
            Kind::Dispute => "dispute",
            Kind::Promise => "promise",
            Kind::Supply => "supply",
            Kind::Policy => "policy",
            Kind::Case => "case",
            Kind::Link => "link",
            Kind::Coverage => "coverage",
            Kind::Communication => "communication",
            Kind::Dispatch => "dispatch",
            Kind::Entitlement => "entitlement",
            Kind::Allocation => "allocation",
            Kind::Account => "account",
            Kind::Customer => "customer",
            Kind::Ledger => "ledger",
            Kind::Attempt => "attempt",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        Kind::ALL.iter().copied().find(|k| k.as_str() == s)
    }

    /// Entity-ref key used in `entity_refs` / payloads for this kind.
    pub fn ref_key(self) -> &'static str {
        match self {
            Kind::Account => "account",
            other => other.as_str(),
        }
    }
}

pub const M_SLOTS: usize = 16;
pub const Q_SLOTS: usize = 10;
pub const S_SLOTS: usize = 8;
pub const T_SLOTS: usize = 4;

/// Slot names per kind. Index constants are grouped by kind; unrelated kinds may reuse numbers.
pub mod fields {
    // Order
    pub const ORDER_M_GROSS: usize = 0;
    pub const ORDER_Q_QUANTITY: usize = 0;
    pub const ORDER_Q_CANCELLED: usize = 1;
    pub const ORDER_Q_DISPATCHED: usize = 2;
    pub const ORDER_Q_DELIVERED: usize = 3;
    pub const ORDER_S_CUSTOMER: usize = 0;
    pub const ORDER_S_CURRENCY: usize = 1;
    pub const ORDER_S_ITEM: usize = 2;
    pub const ORDER_S_UNIT: usize = 3;
    pub const ORDER_T_ACCEPTED_AT: usize = 0;
    pub const ORDER_T_CANCELLED_AT: usize = 1;
    pub const ORDER_T_LAST_SHIPMENT_AT: usize = 2;
    pub const ORDER_ST_ACCEPTED: u8 = 1;
    pub const ORDER_ST_CANCELLED: u8 = 2;
    pub const ORDER_ST_PARTIALLY_CANCELLED: u8 = 3;

    // Line
    pub const LINE_M_GROSS: usize = 0;
    pub const LINE_M_UNIT_GROSS: usize = 1;
    pub const LINE_Q_QUANTITY: usize = 0;
    pub const LINE_Q_CANCELLED: usize = 1;
    pub const LINE_Q_DISPATCHED: usize = 2;
    pub const LINE_Q_DELIVERED: usize = 3;
    pub const LINE_Q_INVOICED: usize = 4;
    pub const LINE_S_ORDER: usize = 0;
    pub const LINE_S_ITEM: usize = 1;
    pub const LINE_S_UNIT: usize = 2;
    pub const LINE_S_CURRENCY: usize = 3;

    // Item
    pub const ITEM_Q_PHYSICAL: usize = 0;
    pub const ITEM_Q_QUARANTINED: usize = 1;
    pub const ITEM_Q_SNAPSHOT_RESERVED: usize = 2;
    pub const ITEM_Q_COMMITTED: usize = 3;
    pub const ITEM_Q_DAMAGED: usize = 4;
    pub const ITEM_Q_SAFETY: usize = 5;
    pub const ITEM_Q_QUALITY_CONTROL: usize = 6;
    pub const ITEM_Q_INCOMING: usize = 7;
    pub const ITEM_Q_PROVIDER_AVAILABLE: usize = 8;
    pub const ITEM_Q_RESERVED_ACTIVE: usize = 9;
    pub const ITEM_S_UNIT: usize = 0;
    pub const ITEM_S_LOCATION: usize = 1;
    pub const ITEM_T_BASIS_AT: usize = 0;
    pub const ITEM_ST_NO_BASIS: u8 = 0;
    pub const ITEM_ST_BASIS: u8 = 1;
    pub const ITEM_ST_BASIS_WITH_PROVIDER_AVAILABLE: u8 = 2;

    // Reservation
    pub const RES_Q_QUANTITY: usize = 0;
    pub const RES_Q_RELEASED: usize = 1;
    pub const RES_S_ITEM: usize = 0;
    pub const RES_S_ORDER: usize = 1;
    pub const RES_S_LINE: usize = 2;
    pub const RES_S_UNIT: usize = 3;
    pub const RES_T_OCCURRED_AT: usize = 0;
    pub const RES_ST_ACTIVE: u8 = 1;
    pub const RES_ST_RELEASED: u8 = 2;

    // Invoice
    pub const INV_M_GROSS: usize = 0;
    pub const INV_M_CREDIT: usize = 1;
    pub const INV_M_REPORTED_PAID: usize = 2;
    pub const INV_M_ALLOCATED: usize = 3;
    pub const INV_S_ORDER: usize = 0;
    pub const INV_S_CUSTOMER: usize = 1;
    pub const INV_S_CURRENCY: usize = 2;
    pub const INV_T_DUE_DATE: usize = 0;
    pub const INV_T_ISSUED_AT: usize = 1;
    pub const INV_ST_ISSUED: u8 = 1;
    pub const INV_ST_CANCELLED: u8 = 2;
    pub const INV_ST_DRAFT: u8 = 3;

    // Credit note
    pub const CREDIT_M_AMOUNT: usize = 0;
    pub const CREDIT_S_INVOICE: usize = 0;
    pub const CREDIT_S_ORDER: usize = 1;
    pub const CREDIT_S_CURRENCY: usize = 2;
    pub const CREDIT_T_ISSUED_AT: usize = 0;
    pub const CREDIT_ST_ISSUED: u8 = 1;
    pub const CREDIT_ST_CASH_REFUND_CONFIRMED: u8 = 2;
    pub const CREDIT_ST_CANCELLED: u8 = 3;

    // Transaction
    pub const TX_M_AUTHORIZED: usize = 0;
    pub const TX_M_CAPTURED: usize = 1;
    pub const TX_M_FEES: usize = 2;
    pub const TX_M_REFUNDED: usize = 3;
    pub const TX_M_REFUND_PENDING: usize = 4;
    pub const TX_M_HELD: usize = 5;
    pub const TX_M_CB_DEBIT: usize = 6;
    pub const TX_M_CB_REVERSED: usize = 7;
    pub const TX_M_CB_FEE: usize = 8;
    pub const TX_M_VOIDED: usize = 9;
    pub const TX_M_FAILED_ATTEMPTS: usize = 10;
    pub const TX_M_PAYOUT_SENT: usize = 11;
    pub const TX_S_ORDER: usize = 0;
    pub const TX_S_ACCOUNT: usize = 1;
    pub const TX_S_CURRENCY: usize = 2;
    pub const TX_S_ORIGINAL: usize = 3;
    pub const TX_S_CUSTOMER: usize = 4;
    pub const TX_S_GATEWAY: usize = 5;
    pub const TX_T_OCCURRED_AT: usize = 0;
    pub const TX_T_CAPTURED_AT: usize = 1;
    pub const TX_ST_AUTHORIZED: u8 = 1;
    pub const TX_ST_CAPTURED: u8 = 2;
    pub const TX_ST_FAILED: u8 = 3;
    pub const TX_ST_VOIDED: u8 = 4;

    // Attempt (failed/voided payment attempts kept visible)
    pub const ATT_M_AMOUNT: usize = 0;
    pub const ATT_S_TRANSACTION: usize = 0;
    pub const ATT_S_ORDER: usize = 1;
    pub const ATT_S_CURRENCY: usize = 2;
    pub const ATT_S_REASON: usize = 3;
    pub const ATT_T_OCCURRED_AT: usize = 0;
    pub const ATT_ST_FAILED: u8 = 3;
    pub const ATT_ST_VOIDED: u8 = 4;

    // Refund
    pub const RF_M_AMOUNT: usize = 0;
    pub const RF_M_HELD: usize = 1;
    pub const RF_S_TRANSACTION: usize = 0;
    pub const RF_S_ORDER: usize = 1;
    pub const RF_S_CURRENCY: usize = 2;
    pub const RF_S_DESTINATION: usize = 3;
    pub const RF_T_OCCURRED_AT: usize = 0;
    pub const RF_ST_PENDING: u8 = 1;
    pub const RF_ST_COMPLETED: u8 = 2;
    pub const RF_ST_FAILED: u8 = 3;
    pub const RF_ST_REVERSED: u8 = 4;

    // Payout
    pub const PO_M_AMOUNT: usize = 0;
    pub const PO_M_BANK_CONFIRMED: usize = 1;
    pub const PO_M_MEMBER_CAPTURES: usize = 2;
    pub const PO_M_MEMBER_FEES: usize = 3;
    pub const PO_M_MEMBER_REFUNDS: usize = 4;
    pub const PO_M_MEMBER_OTHER: usize = 5;
    pub const PO_S_ACCOUNT: usize = 0;
    pub const PO_S_CURRENCY: usize = 1;
    pub const PO_S_TRACE: usize = 2;
    pub const PO_T_ANNOUNCED_AT: usize = 0;
    pub const PO_T_SENT_AT: usize = 1;
    pub const PO_ST_ANNOUNCED: u8 = 1;
    pub const PO_ST_SENT: u8 = 2;
    pub const PO_ST_FAILED: u8 = 3;
    pub const PO_ST_REVERSED: u8 = 4;

    // Bank entry
    pub const BANK_M_AMOUNT: usize = 0;
    pub const BANK_S_PAYOUT: usize = 0;
    pub const BANK_S_ACCOUNT: usize = 1;
    pub const BANK_S_CURRENCY: usize = 2;
    pub const BANK_S_REFERENCE: usize = 3;
    pub const BANK_T_BOOKED_AT: usize = 0;
    pub const BANK_ST_CREDIT_BOOKED: u8 = 1;
    pub const BANK_ST_DEBIT_BOOKED: u8 = 2;
    pub const BANK_ST_PENDING: u8 = 3;
    pub const BANK_ST_CREDIT_MATCHED: u8 = 4;

    // Shipment
    pub const SHIP_Q_QUANTITY: usize = 0;
    pub const SHIP_Q_DELIVERED: usize = 1;
    pub const SHIP_S_ORDER: usize = 0;
    pub const SHIP_S_LINE: usize = 1;
    pub const SHIP_S_CARRIER: usize = 2;
    pub const SHIP_S_TRACKING: usize = 3;
    pub const SHIP_S_LAST_SCAN_CODE: usize = 4;
    pub const SHIP_S_ITEM: usize = 5;
    pub const SHIP_T_HANDOVER_AT: usize = 0;
    pub const SHIP_T_DELIVERED_AT: usize = 1;
    pub const SHIP_T_LAST_SCAN_AT: usize = 2;
    pub const SHIP_T_FORECAST_AT: usize = 3;
    pub const SHIP_ST_OBSERVED: u8 = 0;
    pub const SHIP_ST_DISPATCHED: u8 = 1;
    pub const SHIP_ST_IN_TRANSIT: u8 = 2;
    pub const SHIP_ST_EXCEPTION: u8 = 3;
    pub const SHIP_ST_DELIVERED: u8 = 4;
    pub const SHIP_ST_CANCELLED: u8 = 5;

    // Return
    pub const RET_Q_REQUESTED: usize = 0;
    pub const RET_Q_RECEIVED: usize = 1;
    pub const RET_Q_QUARANTINED: usize = 2;
    pub const RET_Q_RESTOCKED: usize = 3;
    pub const RET_M_EXPECTED_CREDIT: usize = 0;
    pub const RET_S_ORDER: usize = 0;
    pub const RET_S_LINE: usize = 1;
    pub const RET_S_ITEM: usize = 2;
    pub const RET_S_CURRENCY: usize = 3;
    pub const RET_S_UNIT: usize = 4;
    pub const RET_S_DISPOSITION: usize = 5;
    pub const RET_T_APPROVED_AT: usize = 0;
    pub const RET_T_RECEIVED_AT: usize = 1;
    pub const RET_ST_APPROVED: u8 = 1;
    pub const RET_ST_CANCELLED: u8 = 2;
    pub const RET_ST_RECEIVED: u8 = 3;
    pub const RET_ST_RESTOCKED: u8 = 4;

    // Hold
    pub const HOLD_M_AMOUNT: usize = 0;
    pub const HOLD_M_RELEASED: usize = 1;
    pub const HOLD_S_ACCOUNT: usize = 0;
    pub const HOLD_S_TRANSACTION: usize = 1;
    pub const HOLD_S_CURRENCY: usize = 2;
    pub const HOLD_S_REASON: usize = 3;
    pub const HOLD_T_RELEASE_PROMISED_AT: usize = 0;
    pub const HOLD_T_RELEASED_AT: usize = 1;
    pub const HOLD_ST_ACTIVE: u8 = 1;
    pub const HOLD_ST_RELEASED: u8 = 2;

    // Dispute
    pub const DISP_M_AMOUNT: usize = 0;
    pub const DISP_M_DEBIT: usize = 1;
    pub const DISP_M_REVERSED: usize = 2;
    pub const DISP_M_FEE: usize = 3;
    pub const DISP_S_TRANSACTION: usize = 0;
    pub const DISP_S_ORDER: usize = 1;
    pub const DISP_S_CURRENCY: usize = 2;
    pub const DISP_S_OUTCOME: usize = 3;
    pub const DISP_T_OPENED_AT: usize = 0;
    pub const DISP_ST_OPEN: u8 = 1;
    pub const DISP_ST_RESOLVED: u8 = 2;

    // Customer promise
    pub const PROM_S_ORDER: usize = 0;
    pub const PROM_S_LINE: usize = 1;
    pub const PROM_S_KIND: usize = 2;
    pub const PROM_S_TIMEZONE: usize = 3;
    pub const PROM_S_CUSTOMER: usize = 4;
    pub const PROM_T_PROMISED_AT: usize = 0;
    pub const PROM_T_PREVIOUS_PROMISED_AT: usize = 1;
    pub const PROM_M_REVISION: usize = 0;
    pub const PROM_ST_ACTIVE: u8 = 1;
    pub const PROM_ST_WITHDRAWN: u8 = 2;

    // Supply commitment
    pub const SUP_Q_QUANTITY: usize = 0;
    pub const SUP_S_ITEM: usize = 0;
    pub const SUP_S_SUPPLIER: usize = 1;
    pub const SUP_S_UNIT: usize = 2;
    pub const SUP_S_LOCATION: usize = 3;
    pub const SUP_T_PROMISED_AT: usize = 0;
    pub const SUP_T_PREVIOUS_PROMISED_AT: usize = 1;
    pub const SUP_M_REVISION: usize = 0;
    pub const SUP_ST_ACTIVE: u8 = 1;
    pub const SUP_ST_RECEIVED: u8 = 2;
    pub const SUP_ST_CANCELLED: u8 = 3;

    // Policy rule
    pub const POL_S_KIND: usize = 0;
    pub const POL_S_PRIORITY_METHOD: usize = 1;
    pub const POL_S_INVOICING_TRIGGER: usize = 2;
    pub const POL_S_REMINDER_POLICY: usize = 3;
    pub const POL_S_TIMEZONE: usize = 4;
    pub const POL_S_CURRENCY: usize = 5;
    pub const POL_S_ATTENTION_RULE: usize = 6;
    pub const POL_S_SCOPE: usize = 7;
    pub const POL_M_TOLERANCE: usize = 0;
    pub const POL_M_STALE_SCAN_SECONDS: usize = 1;
    pub const POL_M_VERSION: usize = 2;
    pub const POL_M_RISK_HOURS: usize = 3;
    pub const POL_T_EFFECTIVE_FROM: usize = 0;
    pub const POL_ST_ACTIVE: u8 = 1;
    pub const POL_ST_REVISED: u8 = 2;

    // Case
    pub const CASE_S_CUSTOMER: usize = 0;
    pub const CASE_S_INVOICE: usize = 1;
    pub const CASE_S_TRANSACTION: usize = 2;
    pub const CASE_S_STATUS: usize = 3;
    pub const CASE_S_ORDER: usize = 4;
    pub const CASE_T_EXTENSION_UNTIL: usize = 0;
    pub const CASE_ST_OPEN: u8 = 1;
    pub const CASE_ST_CLOSED: u8 = 2;

    // Identity link
    pub const LINK_S_ENTITY_TYPE: usize = 0;
    pub const LINK_S_ENTITY_ID: usize = 1;
    pub const LINK_S_EXTERNAL_ID: usize = 2;
    pub const LINK_S_TARGET: usize = 3;
    pub const LINK_S_RELATIONSHIP: usize = 4;
    pub const LINK_S_CONNECTION: usize = 5;
    pub const LINK_S_CONFIDENCE: usize = 6;
    pub const LINK_ST_RECORDED: u8 = 1;
    pub const LINK_ST_CONFLICT: u8 = 2;
    pub const LINK_ST_REVISED: u8 = 3;

    // Coverage
    pub const COV_S_CONNECTION: usize = 0;
    pub const COV_S_CAPABILITY: usize = 1;
    pub const COV_S_ENTITY_SCOPE: usize = 2;
    pub const COV_T_HISTORY_START: usize = 0;
    pub const COV_T_COMPLETE_THROUGH: usize = 1;
    pub const COV_ST_COMPLETE: u8 = 1;
    pub const COV_ST_INCOMPLETE: u8 = 2;
    pub const COV_ST_GAP: u8 = 3;

    // Communication
    pub const COM_S_CUSTOMER: usize = 0;
    pub const COM_S_ORDER: usize = 1;
    pub const COM_S_ACTOR: usize = 2;
    pub const COM_S_SUMMARY: usize = 3;
    pub const COM_T_SENT_AT: usize = 0;
    pub const COM_ST_OBSERVED: u8 = 1;
    pub const COM_ST_REVIEWED: u8 = 2;

    // Invoice dispatch
    pub const DSP_S_INVOICE: usize = 0;
    pub const DSP_S_CHANNEL: usize = 1;
    pub const DSP_S_STATUS: usize = 2;
    pub const DSP_T_PROCESSED_AT: usize = 0;
    pub const DSP_ST_OK: u8 = 1;
    pub const DSP_ST_PENDING: u8 = 2;
    pub const DSP_ST_ERROR: u8 = 3;

    // Refund entitlement
    pub const ENT_M_AMOUNT: usize = 0;
    pub const ENT_S_ORDER: usize = 0;
    pub const ENT_S_INVOICE: usize = 1;
    pub const ENT_S_CREDIT: usize = 2;
    pub const ENT_S_TRANSACTION: usize = 3;
    pub const ENT_S_CURRENCY: usize = 4;
    pub const ENT_S_DESTINATION: usize = 5;
    pub const ENT_T_APPROVED_AT: usize = 0;
    pub const ENT_ST_APPROVED: u8 = 1;
    pub const ENT_ST_VOID: u8 = 2;

    // Payment allocation
    pub const ALLOC_M_AMOUNT: usize = 0;
    pub const ALLOC_S_INVOICE: usize = 0;
    pub const ALLOC_S_TRANSACTION: usize = 1;
    pub const ALLOC_S_CURRENCY: usize = 2;
    pub const ALLOC_S_CONFIDENCE: usize = 3;
    pub const ALLOC_ST_RECORDED: u8 = 1;
    pub const ALLOC_ST_REVISED: u8 = 2;

    // Provider account (per account_ref + currency)
    pub const ACC_M_CAPTURED: usize = 0;
    pub const ACC_M_FEES: usize = 1;
    pub const ACC_M_REFUNDED: usize = 2;
    pub const ACC_M_HELD: usize = 3;
    pub const ACC_M_ANNOUNCED: usize = 4;
    pub const ACC_M_IN_TRANSIT: usize = 5;
    pub const ACC_M_BANK_CONFIRMED: usize = 6;
    pub const ACC_M_CB_DEBIT: usize = 7;
    pub const ACC_M_CB_REVERSED: usize = 8;
    pub const ACC_M_OBS_TOTAL: usize = 9;
    pub const ACC_M_OBS_PROCESSING: usize = 10;
    pub const ACC_M_OBS_AVAILABLE: usize = 11;
    pub const ACC_M_OBS_HELD: usize = 12;
    pub const ACC_M_LEDGER_OTHER: usize = 13;
    pub const ACC_M_PAYOUT_SENT: usize = 14;
    pub const ACC_M_PAYOUT_REVERSED: usize = 15;
    pub const ACC_S_ACCOUNT_REF: usize = 0;
    pub const ACC_S_CURRENCY: usize = 1;
    pub const ACC_T_OBSERVED_AT: usize = 0;
    pub const ACC_ST_DERIVED_ONLY: u8 = 0;
    pub const ACC_ST_OBSERVED: u8 = 1;

    // Ledger posting
    pub const LED_M_GROSS: usize = 0;
    pub const LED_M_FEE: usize = 1;
    pub const LED_M_NET: usize = 2;
    pub const LED_S_ACCOUNT: usize = 0;
    pub const LED_S_TRANSACTION: usize = 1;
    pub const LED_S_PAYOUT: usize = 2;
    pub const LED_S_POSTING_TYPE: usize = 3;
    pub const LED_S_CURRENCY: usize = 4;
    pub const LED_T_EFFECTIVE: usize = 0;
}

/// Compact business record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Rec {
    pub kind: Kind,
    pub id: Sym,
    pub m: [i64; M_SLOTS],
    pub q: [Decimal; Q_SLOTS],
    pub s: [Sym; S_SLOTS],
    pub t: [i64; T_SLOTS],
    pub status: u8,
    /// Adjacency: (kind, id) pairs in insertion order, deduplicated.
    pub links: Vec<(Kind, Sym)>,
    /// Sequence of the entry that last changed this record.
    pub last_seq: i64,
    pub created_seq: i64,
}

impl Rec {
    pub fn new(kind: Kind, id: Sym, seq: i64) -> Rec {
        Rec {
            kind,
            id,
            m: [0; M_SLOTS],
            q: [Decimal::ZERO; Q_SLOTS],
            s: [NONE; S_SLOTS],
            t: [0; T_SLOTS],
            status: 0,
            links: Vec::new(),
            last_seq: seq,
            created_seq: seq,
        }
    }

    pub fn linked(&self, kind: Kind) -> impl Iterator<Item = Sym> + '_ {
        self.links
            .iter()
            .filter(move |(k, _)| *k == kind)
            .map(|(_, id)| *id)
    }

    pub fn has_link(&self, kind: Kind, id: Sym) -> bool {
        self.links.iter().any(|(k, i)| *k == kind && *i == id)
    }

    pub fn time(&self, slot: usize) -> Option<DateTime<Utc>> {
        ms_to_time(self.t[slot])
    }

    pub fn approx_bytes(&self) -> usize {
        std::mem::size_of::<Rec>() + self.links.capacity() * 8
    }
}

pub fn ms_to_time(ms: i64) -> Option<DateTime<Utc>> {
    if ms == 0 {
        None
    } else {
        Utc.timestamp_millis_opt(ms).single()
    }
}

pub fn time_to_ms(t: DateTime<Utc>) -> i64 {
    t.timestamp_millis()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
pub struct RecKey {
    pub kind: Kind,
    pub id: Sym,
}

impl RecKey {
    pub fn new(kind: Kind, id: Sym) -> RecKey {
        RecKey { kind, id }
    }
}

/// Undo log element for one mutation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Undo {
    Created(RecKey),
    AddM(RecKey, u8, i64),
    AddQ(RecKey, u8, Decimal),
    SetM(RecKey, u8, i64, i64),
    SetQ(RecKey, u8, Decimal, Decimal),
    SetS(RecKey, u8, Sym, Sym),
    SetT(RecKey, u8, i64, i64),
    SetStatus(RecKey, u8, u8),
    Linked(RecKey, Kind, Sym),
}

/// History locator of one entry for one entity.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct EntryLoc {
    pub seq: i64,
    pub entry_id: Uuid,
    pub track: u8,
    pub event: Sym,
    pub occurred_ms: i64,
    pub recorded_ms: i64,
    pub record_id: Sym,
    pub effect: u8,
}

pub const EFFECT_APPLIED: u8 = 1;
pub const EFFECT_DEDUPLICATED: u8 = 2;
pub const EFFECT_SUPERSEDED: u8 = 3;
pub const EFFECT_RECORDED: u8 = 4;
pub const EFFECT_LATE_NO_EFFECT: u8 = 5;
pub const EFFECT_CONFLICT: u8 = 6;
pub const EFFECT_UNKNOWN_EVENT: u8 = 7;

pub fn effect_str(e: u8) -> &'static str {
    match e {
        EFFECT_APPLIED => "applied",
        EFFECT_DEDUPLICATED => "deduplicated",
        EFFECT_SUPERSEDED => "superseded",
        EFFECT_RECORDED => "recorded",
        EFFECT_LATE_NO_EFFECT => "late_no_effect",
        EFFECT_CONFLICT => "conflict",
        EFFECT_UNKNOWN_EVENT => "unknown_event_type",
        _ => "unknown",
    }
}

/// Per-entry metadata needed for dedup, supersession and summaries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EntryMeta {
    pub seq: i64,
    pub observation: Sym,
    pub event: Sym,
    pub track: u8,
    pub effect: u8,
    pub superseded_by: Option<Uuid>,
    pub supersedes: Option<Uuid>,
    pub undo: Vec<Undo>,
    pub entities: Vec<RecKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Conflict {
    pub case_id: String,
    pub reason: String,
    pub entry_id: Uuid,
    pub related_entry_id: Option<Uuid>,
    pub seq: i64,
    pub entities: Vec<(Kind, Sym)>,
}

/// Complete reducer state for one tenant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TenantState {
    pub tenant_id: Uuid,
    pub reducer_version: u32,
    pub applied_sequence: i64,
    pub applied_entries: u64,
    pub state_hash: [u8; 32],
    pub interner: Interner,
    pub recs: HashMap<RecKey, Rec>,
    pub by_kind: HashMap<Kind, Vec<Sym>>,
    pub history: HashMap<RecKey, Vec<EntryLoc>>,
    pub entries: HashMap<Uuid, EntryMeta>,
    /// (event family, observation key) pairs whose business effect was applied once.
    pub applied_effects: HashSet<(Sym, Sym)>,
    /// observation key -> (payload hash prefix, first entry id)
    pub observations: HashMap<Sym, (u64, Uuid)>,
    pub conflicts: Vec<Conflict>,
    /// Dataset ids (specs/question-data-contracts.json) with at least one entry.
    pub datasets_present: HashSet<Sym>,
    pub unknown_event_types: HashMap<Sym, u64>,
    pub last_recorded_ms: i64,
    pub last_occurred_ms: i64,
    /// tracking number -> shipment id
    pub tracking_index: HashMap<Sym, Sym>,
    /// Records whose history locators were evicted from RAM (history served from PostgreSQL).
    pub cold_history: HashSet<RecKey>,
    /// Undo logs of entries with sequence <= this value were evicted (a later correction of
    /// such an entry triggers a rebuild from the journal).
    pub undo_evicted_through: i64,
}

impl TenantState {
    pub fn tracking_index_get(&self, tracking: Sym) -> Option<Sym> {
        self.tracking_index.get(&tracking).copied()
    }

    pub fn tracking_index_insert(&mut self, tracking: Sym, shipment: Sym) {
        self.tracking_index.entry(tracking).or_insert(shipment);
    }

    pub fn new(tenant_id: Uuid) -> TenantState {
        TenantState {
            tenant_id,
            reducer_version: crate::REDUCER_VERSION,
            applied_sequence: 0,
            applied_entries: 0,
            state_hash: [0; 32],
            interner: Interner::new(),
            recs: HashMap::new(),
            by_kind: HashMap::new(),
            history: HashMap::new(),
            entries: HashMap::new(),
            applied_effects: HashSet::new(),
            observations: HashMap::new(),
            conflicts: Vec::new(),
            datasets_present: HashSet::new(),
            unknown_event_types: HashMap::new(),
            last_recorded_ms: 0,
            last_occurred_ms: 0,
            tracking_index: HashMap::new(),
            cold_history: HashSet::new(),
            undo_evicted_through: 0,
        }
    }

    pub fn rec(&self, kind: Kind, id: Sym) -> Option<&Rec> {
        self.recs.get(&RecKey { kind, id })
    }

    pub fn rec_by_str(&self, kind: Kind, id: &str) -> Option<&Rec> {
        let sym = self.interner.get(id)?;
        self.rec(kind, sym)
    }

    pub fn ids(&self, kind: Kind) -> &[Sym] {
        self.by_kind.get(&kind).map(|v| v.as_slice()).unwrap_or(&[])
    }

    pub fn sym(&self, id: Sym) -> &str {
        self.interner.resolve(id)
    }

    pub fn sym_opt(&self, id: Sym) -> Option<&str> {
        self.interner.resolve_opt(id)
    }

    pub fn dataset_present(&self, dataset: &str) -> bool {
        self.interner
            .get(dataset)
            .map(|s| self.datasets_present.contains(&s))
            .unwrap_or(false)
    }

    pub fn history_of(&self, kind: Kind, id: Sym) -> &[EntryLoc] {
        self.history
            .get(&RecKey { kind, id })
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Approximate resident bytes of this state (structural estimate, not allocator truth).
    pub fn approx_bytes(&self) -> usize {
        let recs: usize = self.recs.values().map(|r| r.approx_bytes() + 16).sum();
        let hist: usize = self
            .history
            .values()
            .map(|v| v.capacity() * std::mem::size_of::<EntryLoc>() + 32)
            .sum();
        let entries: usize = self
            .entries
            .values()
            .map(|m| {
                std::mem::size_of::<EntryMeta>()
                    + 16
                    + m.undo.capacity() * std::mem::size_of::<Undo>()
                    + m.entities.capacity() * 8
            })
            .sum();
        let effects = self.applied_effects.len() * 16 + self.observations.len() * 40;
        recs + hist + entries + effects + self.interner.approx_bytes()
    }

    /// Chain hash: identical for identical apply sequences. Used as checkpoint `state_hash`.
    pub fn state_hash_hex(&self) -> String {
        hex::encode(self.state_hash)
    }

    /// Rebuilds transient lookup structures after deserialization.
    pub fn after_deserialize(&mut self) {
        self.interner.rebuild_index();
    }
}
