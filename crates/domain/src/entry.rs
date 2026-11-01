//! Logical journal entry as read from `journal_entries` (packages/contracts/journal-entry.schema.json).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Track {
    Source,
    Fact,
    Commitment,
    Movement,
    Reservation,
}

impl Track {
    pub const ALL: [Track; 5] = [
        Track::Source,
        Track::Fact,
        Track::Commitment,
        Track::Movement,
        Track::Reservation,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Track::Source => "source",
            Track::Fact => "fact",
            Track::Commitment => "commitment",
            Track::Movement => "movement",
            Track::Reservation => "reservation",
        }
    }

    pub fn parse(s: &str) -> Option<Track> {
        match s {
            "source" => Some(Track::Source),
            "fact" => Some(Track::Fact),
            "commitment" => Some(Track::Commitment),
            "movement" => Some(Track::Movement),
            "reservation" => Some(Track::Reservation),
            _ => None,
        }
    }

    pub fn index(self) -> usize {
        match self {
            Track::Source => 0,
            Track::Fact => 1,
            Track::Commitment => 2,
            Track::Movement => 3,
            Track::Reservation => 4,
        }
    }

    pub fn from_index(i: u8) -> Track {
        match i {
            0 => Track::Source,
            1 => Track::Fact,
            2 => Track::Commitment,
            3 => Track::Movement,
            _ => Track::Reservation,
        }
    }
}

/// One committed journal entry. Field names match the shared JSON schema so the same struct
/// can be serialized back to API/MCP clients from the history endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub entry_id: Uuid,
    pub tenant_id: Uuid,
    pub journal_sequence: i64,
    pub track: Track,
    pub record_id: String,
    pub event_type: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: i32,
    #[serde(default)]
    pub connection_id: Option<Uuid>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub account_ref: Option<String>,
    #[serde(default)]
    pub provider_event_id: Option<String>,
    pub occurred_at: DateTime<Utc>,
    pub recorded_at: DateTime<Utc>,
    #[serde(default)]
    pub source_time: Option<DateTime<Utc>>,
    #[serde(default)]
    pub entity_refs: BTreeMap<String, String>,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub payload_hash: String,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub input_entry_ids: Vec<Uuid>,
    #[serde(default)]
    pub derivation_rule: Option<String>,
    #[serde(default)]
    pub derivation_version: Option<i32>,
    #[serde(default)]
    pub supersedes_entry_id: Option<Uuid>,
    #[serde(default)]
    pub correlation_id: Option<String>,
    #[serde(default)]
    pub causation_id: Option<String>,
}

fn default_schema_version() -> i32 {
    1
}

impl Entry {
    /// Observation key used by the effect-once rule (docs/engine.md "Effect-once rule").
    /// Priority: correlation_id, then connection/provider event identity for source entries,
    /// then the caller-resolved key of the first input entry, then the entry id itself.
    pub fn own_observation_key(&self) -> Option<String> {
        if let Some(c) = &self.correlation_id {
            if !c.is_empty() {
                return Some(c.clone());
            }
        }
        if self.track == Track::Source {
            if let Some(p) = &self.provider_event_id {
                if !p.is_empty() {
                    let conn = self
                        .connection_id
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "-".to_string());
                    return Some(format!("{conn}:{p}"));
                }
            }
        }
        None
    }

    /// Typed payload accessors (money integers, decimal quantities, strings).
    pub fn payload_i64(&self, key: &str) -> Option<i64> {
        payload_i64(&self.payload, key)
    }

    pub fn payload_str(&self, key: &str) -> Option<&str> {
        self.payload.get(key).and_then(|v| v.as_str())
    }

    pub fn payload_bool(&self, key: &str) -> Option<bool> {
        self.payload.get(key).and_then(|v| v.as_bool())
    }

    /// Resolves an entity reference: entity_refs first, then the payload field of the same name.
    pub fn entity_ref(&self, key: &str) -> Option<&str> {
        if let Some(v) = self.entity_refs.get(key) {
            if !v.is_empty() {
                return Some(v.as_str());
            }
        }
        self.payload_str(key)
    }

    pub fn currency(&self) -> Option<&str> {
        self.payload_str("currency")
    }
}

pub fn payload_i64(payload: &serde_json::Value, key: &str) -> Option<i64> {
    match payload.get(key)? {
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => s.parse::<i64>().ok(),
        _ => None,
    }
}

pub fn payload_decimal(payload: &serde_json::Value, key: &str) -> Option<rust_decimal::Decimal> {
    use std::str::FromStr;
    match payload.get(key)? {
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(rust_decimal::Decimal::from(i))
            } else {
                rust_decimal::Decimal::from_str(&n.to_string()).ok()
            }
        }
        serde_json::Value::String(s) => rust_decimal::Decimal::from_str(s).ok(),
        _ => None,
    }
}

/// Minimal summary of an entry exposed in the five track views of `/v1/state`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EntrySummary {
    pub entry_id: Uuid,
    pub journal_sequence: i64,
    pub track: Track,
    pub record_id: String,
    pub event_type: String,
    pub occurred_at: DateTime<Utc>,
    pub recorded_at: DateTime<Utc>,
    pub supersedes_entry_id: Option<Uuid>,
    pub superseded_by: Option<Uuid>,
    /// `applied` when the entry changed current state, `deduplicated` when the same observation
    /// was already counted, `superseded` when a later correction replaced it, `recorded` when the
    /// entry carries no state effect (history only) and `late_no_effect` for a stale late event.
    pub effect: String,
}
