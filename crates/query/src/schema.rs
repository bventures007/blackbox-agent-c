//! `describe_business_schema` payload (`GET /v1/schema`): record types, event families,
//! fields, units, time semantics and supported intents with parameters.

use crate::intents::{param_specs, INTENTS};
use blackbox_domain::reducer::{dataset_of, KNOWN_EVENT_TYPES};
use blackbox_domain::state::{Rec, NONE};
use blackbox_domain::views::record_view;
use blackbox_domain::{Kind, TenantState, REDUCER_VERSION};
use serde_json::{json, Value};

pub fn describe() -> Value {
    let dummy = TenantState::new(uuid::Uuid::nil());
    let record_types: Vec<Value> = Kind::ALL
        .iter()
        .map(|k| {
            let r = Rec::new(*k, NONE, 0);
            let v = record_view(&dummy, &r);
            let fields: Vec<String> = v.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
            json!({"type": k.as_str(), "fields": fields, "key": format!("(tenant_id, {}, id)", k.as_str())})
        })
        .collect();
    let events: Vec<Value> = KNOWN_EVENT_TYPES
        .iter()
        .map(|e| json!({"event_type": e, "dataset": dataset_of(e), "tracks": blackbox_domain::fixture::derived_tracks(e).iter().map(|t| t.as_str()).chain(std::iter::once("source")).collect::<Vec<_>>()}))
        .collect();
    let intents: Vec<Value> = INTENTS
        .iter()
        .map(|i| {
            let params: Vec<Value> = param_specs(i)
                .unwrap_or(&[])
                .iter()
                .map(|p| json!({"name": p.name, "type": format!("{:?}", p.ty).to_lowercase(), "required": p.required, "description": p.description}))
                .collect();
            json!({"intent": i, "params": params})
        })
        .collect();
    json!({
        "schema_version": 1,
        "reducer_version": REDUCER_VERSION,
        "tracks": ["source", "fact", "commitment", "movement", "reservation"],
        "record_types": record_types,
        "event_families": events,
        "units": {
            "money": "integer minor units (`*_minor`) with ISO 4217 `currency`; currencies are never summed together (a mismatch is a conflict)",
            "quantity": "decimal string with explicit `unit` (e.g. piece)",
            "time": "RFC3339 UTC"
        },
        "time_semantics": {
            "occurred_at": "effective business time supplied by the source",
            "recorded_at": "server-assigned durable recording time (journal position order)",
            "journal_sequence": "tenant-scoped committed position; cursors and snapshot boundaries use it",
            "as_of": "recorded-time cutoff replays entries with recorded_at <= cutoff (and optionally occurred_at <= effective cutoff) through the same reducers",
            "late_events": "keep their effective time; snapshot-type observations never regress a newer basis; corrections append with supersedes_entry_id"
        },
        "filterable_fields": {
            "history": ["entity_type", "entity_id", "journal_sequence range (keyset)", "recorded_at cutoff"],
            "query": "per-intent parameters listed under intents; unknown parameters are rejected (invalid_params)"
        },
        "consistency_modes": ["latest_committed", "at_least_cursor", "as_of", "stale_explicit"],
        "intents": intents,
        "capabilities": {
            "get_business_state": "POST /v1/state",
            "get_entity_history": "POST /v1/history",
            "query_business": "POST /v1/query",
            "thirty_day_summary": "POST /v1/summary",
            "describe_business_schema": "GET /v1/schema"
        }
    })
}
