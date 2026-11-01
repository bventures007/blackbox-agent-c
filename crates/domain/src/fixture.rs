//! Golden scenario loader and synthetic entry builders in the shapes the TypeScript ingestion
//! produces: one source entry per observation (event_type = kind, payload = fixture payload,
//! entity_refs {order, customer, item, ...}) plus optional derived fact/commitment/movement/
//! reservation entries referencing `input_entry_ids` and sharing `correlation_id`.

use crate::entry::{Entry, Track};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
pub struct GoldenEvent {
    pub id: String,
    pub connection: String,
    pub provider_event_id: String,
    pub occurred_at: DateTime<Utc>,
    pub entity: BTreeMap<String, String>,
    pub kind: String,
    pub payload: Map<String, Value>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GoldenCheckpoint {
    pub after: String,
    pub expected: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AdversarialVariant {
    pub name: String,
    pub action: String,
    pub expected: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GoldenScenario {
    pub version: String,
    pub currency: String,
    pub events: Vec<GoldenEvent>,
    pub checkpoints: Vec<GoldenCheckpoint>,
    #[serde(default)]
    pub invariants: Vec<String>,
    #[serde(default)]
    pub adversarial_variants: Vec<AdversarialVariant>,
}

impl GoldenScenario {
    pub fn parse(json: &str) -> serde_json::Result<GoldenScenario> {
        serde_json::from_str(json)
    }

    /// Loads GOLDEN-ORDER-TO-CASH.json from the repository root (relative to this crate).
    pub fn load_from_repo() -> std::io::Result<GoldenScenario> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../GOLDEN-ORDER-TO-CASH.json");
        let s = std::fs::read_to_string(path)?;
        GoldenScenario::parse(&s).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }
}

/// Tracks that a derived expansion of a family extends beyond `source` (packages/contracts/events.json).
pub fn derived_tracks(event_type: &str) -> Vec<Track> {
    use Track::*;
    match event_type {
        "allocation.revised" | "inventory.reserved" | "inventory.reservation_released" => {
            vec![Fact, Reservation]
        }
        "bank.credit_booked" | "bank.debit_booked" | "bank.match_recorded" | "bank.match_revised" => {
            vec![Fact, Movement]
        }
        "chargeback.debit_posted" | "chargeback.reversed" | "dispute.opened" | "dispute.resolved" => {
            vec![Fact, Movement, Reservation]
        }
        "customer.commitment_recorded" | "customer.commitment_revised" => vec![Fact, Commitment],
        "invoice.cancelled" | "invoice.credit_issued" | "invoice.issued" | "invoice.payment_marked"
        | "invoice.revised" => vec![Fact, Commitment],
        "order.accepted" | "order.cancelled" | "order.revised" => vec![Fact, Commitment],
        "payment.authorized" | "payment.captured" | "payment.failed" | "payment.fee_booked"
        | "payment.voided" | "provider.ledger_posted" => vec![Fact, Movement],
        "payout.announced" | "payout.failed" | "payout.reversed" | "payout.sent" => {
            vec![Fact, Commitment, Movement]
        }
        "provider.hold_recorded" | "provider.hold_released" | "provider.release_promised" => {
            vec![Fact, Reservation, Commitment]
        }
        "refund.completed" | "refund.failed" | "refund.pending" | "refund.reversed" => {
            vec![Fact, Movement, Reservation]
        }
        "refund.entitlement_recorded" | "refund.entitlement_revised" => vec![Fact, Commitment],
        "return.disposition_observed" | "return.received" | "return.restocked" => {
            vec![Fact, Movement, Reservation]
        }
        "shipment.cancelled" | "shipment.delivered" | "shipment.dispatched" | "shipment.observed" => {
            vec![Fact, Movement, Reservation]
        }
        "supply.commitment_recorded" | "supply.commitment_revised" => vec![Fact, Commitment],
        _ => vec![Fact],
    }
}

/// Record id for an observation (the business record whose history the entry extends).
pub fn record_id_for(kind: &str, payload: &Map<String, Value>, entity: &BTreeMap<String, String>) -> String {
    let family = kind.split('.').next().unwrap_or(kind);
    let key = match family {
        "order" => "order",
        "inventory" => {
            if payload.contains_key("reservation") {
                "reservation"
            } else {
                "sku"
            }
        }
        "allocation" => "reservation",
        "invoice" => "invoice",
        "payment" => "transaction",
        "shipment" | "carrier" => "shipment",
        "return" => "return",
        "refund" => "refund",
        "payout" => "payout",
        "bank" => "bank_entry",
        "provider" => {
            if payload.contains_key("hold") {
                "hold"
            } else {
                "account"
            }
        }
        "dispute" | "chargeback" => "dispute",
        "customer" | "supply" => "promise",
        "business" => {
            if payload.contains_key("case") {
                "case"
            } else {
                "rule"
            }
        }
        "entity" => "link",
        "coverage" => "coverage",
        "communication" => "message",
        _ => "order",
    };
    if let Some(v) = payload.get(key).and_then(|v| v.as_str()) {
        return format!("{key}:{v}");
    }
    if let Some(v) = entity.get(key) {
        return format!("{key}:{v}");
    }
    if let Some(v) = payload.get("item").and_then(|v| v.as_str()) {
        return format!("item:{v}");
    }
    if let Some(v) = entity.get("item") {
        return format!("item:{v}");
    }
    format!("{family}:{}", entity.get("order").cloned().unwrap_or_default())
}

/// Builds the source entry for a golden/synthetic event.
pub fn source_entry(
    tenant: Uuid,
    seq: i64,
    ev: &GoldenEvent,
    connection_id: Uuid,
    recorded_at: DateTime<Utc>,
) -> Entry {
    let payload = Value::Object(ev.payload.clone());
    let mut entity_refs = ev.entity.clone();
    for k in [
        "invoice",
        "transaction",
        "refund",
        "payout",
        "return",
        "reservation",
        "bank_entry",
        "shipment",
        "credit",
        "hold",
        "dispute",
        "promise",
        "case",
        "entitlement",
        "allocation",
        "line",
    ] {
        if let Some(v) = ev.payload.get(k).and_then(|v| v.as_str()) {
            entity_refs.entry(k.to_string()).or_insert_with(|| v.to_string());
        }
    }
    if let Some(v) = ev.payload.get("sku").and_then(|v| v.as_str()) {
        entity_refs
            .entry("item".to_string())
            .or_insert_with(|| v.to_string());
    }
    Entry {
        entry_id: Uuid::new_v4(),
        tenant_id: tenant,
        journal_sequence: seq,
        track: Track::Source,
        record_id: record_id_for(&ev.kind, &ev.payload, &ev.entity),
        event_type: ev.kind.clone(),
        schema_version: 1,
        connection_id: Some(connection_id),
        provider: Some(ev.connection.clone()),
        account_ref: None,
        provider_event_id: Some(ev.provider_event_id.clone()),
        occurred_at: ev.occurred_at,
        recorded_at,
        source_time: Some(ev.occurred_at),
        entity_refs,
        payload_hash: payload_hash(&payload),
        payload,
        evidence_refs: ev.evidence_refs.clone(),
        input_entry_ids: vec![],
        derivation_rule: None,
        derivation_version: None,
        supersedes_entry_id: None,
        correlation_id: Some(format!("{}:{}", connection_id, ev.provider_event_id)),
        causation_id: None,
    }
}

/// Derived entries the ingestion appends for a source observation (same payload subset,
/// `input_entry_ids = [source]`, shared correlation id, derivation rule/version).
pub fn derived_entries(source: &Entry, first_seq: i64) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut seq = first_seq;
    for track in derived_tracks(&source.event_type) {
        let mut e = source.clone();
        e.entry_id = Uuid::new_v4();
        e.journal_sequence = seq;
        e.track = track;
        e.provider_event_id = None;
        e.input_entry_ids = vec![source.entry_id];
        e.derivation_rule = Some(format!("derive.{}.{}", track.as_str(), source.event_type));
        e.derivation_version = Some(1);
        e.recorded_at = source.recorded_at + Duration::milliseconds(1);
        e.causation_id = Some(source.entry_id.to_string());
        out.push(e);
        seq += 1;
    }
    out
}

pub fn payload_hash(payload: &Value) -> String {
    use sha2::{Digest, Sha256};
    let s = payload.to_string();
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// JSON object in the shape accepted by `append_journal_entries(jsonb)`.
pub fn append_json(e: &Entry) -> Value {
    let mut v = json!({
        "track": e.track.as_str(),
        "record_id": e.record_id,
        "event_type": e.event_type,
        "schema_version": e.schema_version,
        "provider": e.provider,
        "account_ref": e.account_ref,
        "provider_event_id": e.provider_event_id,
        "occurred_at": e.occurred_at.to_rfc3339(),
        "source_time": e.source_time.map(|t| t.to_rfc3339()),
        "entity_refs": e.entity_refs,
        "payload": e.payload,
        "evidence_refs": e.evidence_refs,
        "input_entry_ids": e.input_entry_ids,
        "derivation_rule": e.derivation_rule,
        "derivation_version": e.derivation_version,
        "supersedes_entry_id": e.supersedes_entry_id,
        "correlation_id": e.correlation_id,
        "causation_id": e.causation_id,
    });
    if let Some(c) = e.connection_id {
        v["connection_id"] = json!(c);
    }
    v
}

/// Parameters of a mutated golden scenario (DOMAIN-02 / adversarial "mutation").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScenarioParams {
    pub quantity: i64,
    pub unit_gross_minor: i64,
    pub fee_minor: i64,
    pub return_quantity: i64,
    pub physical_stock: i64,
    pub currency: String,
    pub suffix: String,
}

impl ScenarioParams {
    pub fn golden() -> ScenarioParams {
        ScenarioParams {
            quantity: 10,
            unit_gross_minor: 1190,
            fee_minor: 350,
            return_quantity: 2,
            physical_stock: 120,
            currency: "EUR".into(),
            suffix: String::new(),
        }
    }

    pub fn gross(&self) -> i64 {
        self.quantity * self.unit_gross_minor
    }

    pub fn credit(&self) -> i64 {
        self.return_quantity * self.unit_gross_minor
    }

    pub fn payout(&self) -> i64 {
        self.gross() - self.fee_minor - self.credit()
    }
}

/// Rewrites the golden events with the given parameters (ids suffixed so that scenarios stay
/// distinct). Payload shapes are unchanged.
pub fn mutate(scenario: &GoldenScenario, p: &ScenarioParams) -> Vec<GoldenEvent> {
    let sfx = &p.suffix;
    let rename = |s: &str| -> String { format!("{s}{sfx}") };
    scenario
        .events
        .iter()
        .map(|ev| {
            let mut e = ev.clone();
            for v in e.entity.values_mut() {
                *v = rename(v);
            }
            e.provider_event_id = rename(&e.provider_event_id);
            let mut pl = Map::new();
            for (k, v) in &ev.payload {
                let nv = match (k.as_str(), v) {
                    ("currency", _) => json!(p.currency),
                    ("physical", _) => json!(p.physical_stock),
                    ("quantity", _) if ev.kind.starts_with("return") => json!(p.return_quantity),
                    ("quantity", _) => json!(p.quantity),
                    ("physical_stock_delta", _) if ev.kind == "shipment.dispatched" => {
                        json!(-p.quantity)
                    }
                    ("physical_stock_delta", _) if ev.kind == "return.received" => {
                        json!(p.return_quantity)
                    }
                    ("quarantine_delta", _) if ev.kind == "return.received" => {
                        json!(p.return_quantity)
                    }
                    ("quarantine_delta", _) if ev.kind == "return.restocked" => {
                        json!(-p.return_quantity)
                    }
                    ("reservation_released", _) => json!(p.quantity),
                    ("unit_gross_minor", _) => json!(p.unit_gross_minor),
                    ("gross_minor", _) => json!(p.gross()),
                    ("authorized_minor", _) | ("captured_minor", _) | ("paid_minor", _) => {
                        json!(p.gross())
                    }
                    ("fee_minor", _) => json!(p.fee_minor),
                    ("expected_credit_minor", _) | ("credit_minor", _) => json!(p.credit()),
                    ("amount_minor", _) | ("held_minor", _) | ("hold_released_minor", _)
                        if ev.kind.starts_with("refund") =>
                    {
                        json!(p.credit())
                    }
                    ("amount_minor", _) => json!(p.payout()),
                    (_, Value::String(s)) if k != "status" && k != "carrier_status" && k != "unit" && k != "due_date" => {
                        json!(rename(s))
                    }
                    _ => v.clone(),
                };
                pl.insert(k.clone(), nv);
            }
            e.payload = pl;
            e
        })
        .collect()
}

/// Parametric expectation model for the golden checkpoints. `expected_checkpoints(golden)` must
/// equal the checkpoints in GOLDEN-ORDER-TO-CASH.json exactly (tested), which validates the
/// model before it is used for mutated scenarios.
pub fn expected_checkpoints(p: &ScenarioParams) -> Vec<(String, Map<String, Value>)> {
    let g = p.gross();
    let f = p.fee_minor;
    let c = p.credit();
    let po = p.payout();
    let s = p.physical_stock;
    let q = p.quantity;
    let r = p.return_quantity;
    let obj = |pairs: &[(&str, Value)]| -> Map<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    };
    vec![
        (
            "G05".into(),
            obj(&[
                ("physical_stock", json!(s)),
                ("reserved_stock", json!(q)),
                ("available_stock", json!(s - q)),
                ("authorized_minor", json!(g)),
                ("captured_minor", json!(0)),
                ("open_receivable_minor", json!(g)),
                ("provider_balance_minor", json!(0)),
                ("bank_confirmed_minor", json!(0)),
            ]),
        ),
        (
            "G08".into(),
            obj(&[
                ("captured_minor", json!(g)),
                ("fees_minor", json!(f)),
                ("provider_balance_minor", json!(g - f)),
                ("open_receivable_minor", json!(0)),
                ("bank_confirmed_minor", json!(0)),
            ]),
        ),
        (
            "G10".into(),
            obj(&[
                ("physical_stock", json!(s - q)),
                ("reserved_stock", json!(0)),
                ("available_stock", json!(s - q)),
                ("shipment_status", json!("delivered")),
                ("provider_balance_minor", json!(g - f)),
            ]),
        ),
        (
            "G12".into(),
            obj(&[
                ("physical_stock", json!(s - q + r)),
                ("quarantined_stock", json!(r)),
                ("reserved_stock", json!(0)),
                ("available_stock", json!(s - q)),
            ]),
        ),
        (
            "G13".into(),
            obj(&[
                ("physical_stock", json!(s - q + r)),
                ("quarantined_stock", json!(0)),
                ("available_stock", json!(s - q + r)),
            ]),
        ),
        (
            "G14".into(),
            obj(&[
                ("invoice_original_minor", json!(g)),
                ("invoice_credit_minor", json!(c)),
                ("invoice_net_minor", json!(g - c)),
                ("captured_minor", json!(g)),
                ("refunded_minor", json!(0)),
                ("refund_payable_minor", json!(c)),
                ("open_receivable_minor", json!(0)),
                ("provider_balance_minor", json!(g - f)),
            ]),
        ),
        (
            "G15".into(),
            obj(&[
                ("provider_balance_minor", json!(g - f)),
                ("provider_held_minor", json!(c)),
                ("provider_available_minor", json!(g - f - c)),
                ("refunded_minor", json!(0)),
                ("refund_payable_minor", json!(c)),
            ]),
        ),
        (
            "G16".into(),
            obj(&[
                ("provider_balance_minor", json!(g - f - c)),
                ("provider_held_minor", json!(0)),
                ("provider_available_minor", json!(g - f - c)),
                ("refunded_minor", json!(c)),
                ("refund_payable_minor", json!(0)),
                ("open_receivable_minor", json!(0)),
                ("customer_net_paid_minor", json!(g - c)),
            ]),
        ),
        (
            "G17".into(),
            obj(&[
                ("provider_balance_minor", json!(po)),
                ("payout_announced_minor", json!(po)),
                ("in_transit_minor", json!(0)),
                ("bank_confirmed_minor", json!(0)),
            ]),
        ),
        (
            "G18".into(),
            obj(&[
                ("provider_balance_minor", json!(0)),
                ("payout_announced_minor", json!(0)),
                ("in_transit_minor", json!(po)),
                ("bank_confirmed_minor", json!(0)),
            ]),
        ),
        (
            "G19".into(),
            obj(&[
                ("physical_stock", json!(s - q + r)),
                ("reserved_stock", json!(0)),
                ("quarantined_stock", json!(0)),
                ("available_stock", json!(s - q + r)),
                ("captured_minor", json!(g)),
                ("fees_minor", json!(f)),
                ("refunded_minor", json!(c)),
                ("invoice_net_minor", json!(g - c)),
                ("open_receivable_minor", json!(0)),
                ("refund_payable_minor", json!(0)),
                ("provider_balance_minor", json!(0)),
                ("in_transit_minor", json!(0)),
                ("bank_confirmed_minor", json!(po)),
            ]),
        ),
    ]
}

/// Compares an order-state JSON object with expected checkpoint values. Numbers compare by
/// value (integers vs decimal strings), strings by equality. Returns mismatches.
pub fn compare_expected(actual: &Value, expected: &Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();
    for (k, want) in expected {
        let got = actual.get(k).cloned().unwrap_or(Value::Null);
        let ok = match (want, &got) {
            (Value::Number(w), Value::Number(g)) => w == g,
            (Value::Number(w), Value::String(g)) => {
                g.parse::<f64>().map(|x| Some(x) == w.as_f64()).unwrap_or(false)
            }
            (Value::String(w), Value::String(g)) => w == g,
            (a, b) => a == b,
        };
        if !ok {
            out.push(format!("{k}: expected {want} got {got}"));
        }
    }
    out
}

/// Connection ids used by the fixtures (stable per connection name).
pub fn connection_uuid(tenant: Uuid, connection: &str) -> Uuid {
    Uuid::new_v5(&tenant, format!("connection:{connection}").as_bytes())
}
