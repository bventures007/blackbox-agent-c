//! Bounded business queries over `TenantState`: the 24 intents of
//! specs/question-data-contracts.json, the `/v1/state` view, the thirty-day summary and the
//! business schema description. Pure functions; consistency handling lives in the engine app.

pub mod intents;
pub mod schema;
pub mod state;

use blackbox_domain::state::{EntryLoc, RecKey};
use blackbox_domain::views::{conflicts_for, merged_history, ConflictView, Coverage};
use blackbox_domain::{TenantState, REDUCER_VERSION};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::str::FromStr;
use uuid::Uuid;

pub const MAX_PAGE_ROWS: usize = 500;
pub const DEFAULT_PAGE_ROWS: usize = 100;
/// Upper bound of entry ids / evidence refs attached to one answer.
pub const MAX_EVIDENCE: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Complete,
    Partial,
    Unknown,
    Conflict,
    Unsupported,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Complete => "complete",
            Status::Partial => "partial",
            Status::Unknown => "unknown",
            Status::Conflict => "conflict",
            Status::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub step: String,
    pub formula: String,
    pub values: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageOut {
    pub next_cursor: Option<String>,
    pub truncated: bool,
    pub returned: usize,
    pub total: usize,
    pub snapshot_cursor: i64,
}

/// common_result_envelope (consistency is attached by the engine app).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub status: Status,
    pub intent: String,
    pub result: Value,
    pub calculation: Vec<Step>,
    pub rule_version: u32,
    pub evidence_refs: Vec<String>,
    pub entry_ids: Vec<Uuid>,
    pub missing_inputs: Vec<String>,
    pub conflicts: Vec<ConflictView>,
    pub coverage: Value,
    pub effective_at: Option<DateTime<Utc>>,
    pub page: PageOut,
    /// Touched entities whose history locators were evicted from RAM (kind, id). Not serialized: the
    /// engine's HTTP layer uses it to serve the evidence from the indexed cold path instead of citing nothing.
    #[serde(skip)]
    pub cold_entities: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub enum QueryError {
    UnsupportedIntent(String),
    InvalidParams(String),
    TooLarge(String),
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QueryError::UnsupportedIntent(s) => write!(f, "unsupported intent: {s}"),
            QueryError::InvalidParams(s) => write!(f, "invalid params: {s}"),
            QueryError::TooLarge(s) => write!(f, "too large: {s}"),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct PageIn {
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamType {
    Str,
    Int,
    Bool,
    Decimal,
    Time,
    StrList,
}

pub struct ParamSpec {
    pub name: &'static str,
    pub ty: ParamType,
    pub required: bool,
    pub description: &'static str,
}

/// Validated parameters.
#[derive(Debug, Clone, Default)]
pub struct Params {
    pub values: Map<String, Value>,
}

impl Params {
    pub fn str(&self, k: &str) -> Option<&str> {
        self.values.get(k).and_then(|v| v.as_str())
    }

    pub fn int(&self, k: &str) -> Option<i64> {
        self.values.get(k).and_then(|v| v.as_i64())
    }

    pub fn bool(&self, k: &str) -> Option<bool> {
        self.values.get(k).and_then(|v| v.as_bool())
    }

    pub fn decimal(&self, k: &str) -> Option<Decimal> {
        match self.values.get(k)? {
            Value::Number(n) => Decimal::from_str(&n.to_string()).ok(),
            Value::String(s) => Decimal::from_str(s).ok(),
            _ => None,
        }
    }

    pub fn time(&self, k: &str) -> Option<DateTime<Utc>> {
        let s = self.values.get(k)?.as_str()?;
        blackbox_domain::reducer::parse_time_ms(s)
            .and_then(blackbox_domain::state::ms_to_time)
    }

    pub fn list(&self, k: &str) -> Vec<String> {
        self.values
            .get(k)
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default()
    }
}

/// Validates raw params against the intent's spec; rejects unknown names and wrong types.
pub fn validate_params(intent: &str, raw: &Map<String, Value>) -> Result<Params, QueryError> {
    let spec = intents::param_specs(intent).ok_or_else(|| QueryError::UnsupportedIntent(intent.to_string()))?;
    let mut out = Map::new();
    for (k, v) in raw {
        let Some(ps) = spec.iter().find(|p| p.name == k) else {
            return Err(QueryError::InvalidParams(format!("unknown parameter '{k}' for intent {intent}")));
        };
        if v.is_null() {
            continue;
        }
        let ok = match ps.ty {
            ParamType::Str => v.is_string(),
            ParamType::Int => v.as_i64().is_some() || v.as_str().map(|s| s.parse::<i64>().is_ok()).unwrap_or(false),
            ParamType::Bool => v.is_boolean(),
            ParamType::Decimal => v.is_number() || v.as_str().map(|s| Decimal::from_str(s).is_ok()).unwrap_or(false),
            ParamType::Time => v
                .as_str()
                .map(|s| blackbox_domain::reducer::parse_time_ms(s).is_some())
                .unwrap_or(false),
            ParamType::StrList => v.as_array().map(|a| a.iter().all(|x| x.is_string())).unwrap_or(false),
        };
        if !ok {
            return Err(QueryError::InvalidParams(format!("parameter '{k}' has the wrong type (expected {:?})", ps.ty)));
        }
        let norm = match ps.ty {
            ParamType::Int => match v.as_str() {
                Some(s) => json!(s.parse::<i64>().unwrap()),
                None => v.clone(),
            },
            _ => v.clone(),
        };
        out.insert(k.clone(), norm);
    }
    for ps in spec {
        if ps.required && !out.contains_key(ps.name) {
            return Err(QueryError::InvalidParams(format!("missing required parameter '{}'", ps.name)));
        }
    }
    Ok(Params { values: out })
}

/// Parses a page cursor "<snapshot_seq>:<offset>" scoped to a tenant hash.
pub fn parse_cursor(tenant: Uuid, cursor: &str) -> Result<(i64, usize), QueryError> {
    let parts: Vec<&str> = cursor.split(':').collect();
    if parts.len() != 3 {
        return Err(QueryError::InvalidParams("malformed cursor".into()));
    }
    if parts[0] != tenant_tag(tenant) {
        return Err(QueryError::InvalidParams("cursor does not belong to this tenant".into()));
    }
    let snap = parts[1].parse::<i64>().map_err(|_| QueryError::InvalidParams("malformed cursor".into()))?;
    let off = parts[2].parse::<usize>().map_err(|_| QueryError::InvalidParams("malformed cursor".into()))?;
    Ok((snap, off))
}

pub fn make_cursor(tenant: Uuid, snapshot: i64, offset: usize) -> String {
    format!("{}:{}:{}", tenant_tag(tenant), snapshot, offset)
}

pub fn tenant_tag(tenant: Uuid) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(tenant.as_bytes());
    hex::encode(&d[..6])
}

/// Builder used by intent implementations.
pub struct Answer<'a> {
    pub st: &'a TenantState,
    pub intent: String,
    pub status: Status,
    pub result: Map<String, Value>,
    pub calculation: Vec<Step>,
    pub missing_inputs: Vec<String>,
    pub entities: Vec<RecKey>,
    /// Membership index of `entities` (touch order is kept in the Vec; the former linear `contains` made a
    /// tenant-wide intent quadratic in the number of touched records — 5,000 invoices on the smoke corpus).
    entity_set: HashSet<RecKey>,
    pub coverage_datasets: Vec<&'static str>,
    pub coverage_extra: Map<String, Value>,
    pub items: Vec<Value>,
    pub items_key: &'static str,
    pub effective_at: Option<DateTime<Utc>>,
}

impl<'a> Answer<'a> {
    pub fn new(st: &'a TenantState, intent: &str, datasets: &[&'static str]) -> Answer<'a> {
        Answer {
            st,
            intent: intent.to_string(),
            status: Status::Complete,
            result: Map::new(),
            calculation: Vec::new(),
            missing_inputs: Vec::new(),
            entities: Vec::new(),
            entity_set: HashSet::new(),
            coverage_datasets: datasets.to_vec(),
            coverage_extra: Map::new(),
            items: Vec::new(),
            items_key: "items",
            effective_at: None,
        }
    }

    pub fn step(&mut self, step: &str, formula: &str, values: Value) {
        self.calculation.push(Step {
            step: step.to_string(),
            formula: formula.to_string(),
            values,
        });
    }

    pub fn set(&mut self, k: &str, v: Value) {
        self.result.insert(k.to_string(), v);
    }

    pub fn missing(&mut self, input: &str) {
        if !self.missing_inputs.iter().any(|m| m == input) {
            self.missing_inputs.push(input.to_string());
        }
    }

    pub fn downgrade(&mut self, to: Status) {
        let rank = |s: Status| match s {
            Status::Complete => 0,
            Status::Partial => 1,
            Status::Conflict => 2,
            Status::Unknown => 3,
            Status::Unsupported => 4,
        };
        if rank(to) > rank(self.status) {
            self.status = to;
        }
    }

    pub fn touch(&mut self, key: RecKey) {
        if self.entity_set.insert(key) {
            self.entities.push(key);
        }
    }

    /// Marks a required dataset missing for this tenant (status unknown).
    pub fn require_dataset(&mut self, dataset: &str, missing_label: &str) -> bool {
        if self.st.dataset_present(dataset) {
            true
        } else {
            self.missing(missing_label);
            self.downgrade(Status::Unknown);
            false
        }
    }

    pub fn finish(mut self, tenant: Uuid, page: &PageIn, applied: i64) -> Result<Envelope, QueryError> {
        let st = self.st;
        let limit = page.limit.unwrap_or(DEFAULT_PAGE_ROWS);
        if limit == 0 || limit > MAX_PAGE_ROWS {
            return Err(QueryError::InvalidParams(format!("page.limit must be 1..={MAX_PAGE_ROWS}")));
        }
        let (snapshot, offset) = match &page.cursor {
            Some(c) => parse_cursor(tenant, c)?,
            None => (applied, 0),
        };
        let total = self.items.len();
        let slice: Vec<Value> = self.items.iter().skip(offset).take(limit).cloned().collect();
        let returned = slice.len();
        let truncated = offset + returned < total;
        let next_cursor = if truncated {
            Some(make_cursor(tenant, snapshot, offset + returned))
        } else {
            None
        };
        if !self.items.is_empty() || self.items_key != "items" {
            self.result.insert(self.items_key.to_string(), Value::Array(slice));
        }
        if self.calculation.is_empty() {
            let missing = self.missing_inputs.clone();
            self.step(
                "status",
                "no calculation performed: required inputs are missing or the scope is unknown",
                json!({"status": self.status.as_str(), "missing_inputs": missing}),
            );
        }
        // Evicted history is disclosed the same way the state path does it (`history.evicted_use_cold_read`)
        // instead of silently answering with no evidence; the HTTP layer fills the evidence from PostgreSQL.
        let cold_entities: Vec<(String, String)> = self
            .entities
            .iter()
            .filter(|k| st.cold_history.contains(k))
            .map(|k| (k.kind.as_str().to_string(), st.sym(k.id).to_string()))
            .collect();
        if !cold_entities.is_empty() && !self.missing_inputs.iter().any(|m| m == "history.evicted_use_cold_read") {
            self.missing_inputs.push("history.evicted_use_cold_read".into());
        }
        let hist: Vec<EntryLoc> = merged_history(st, &self.entities);
        let mut entry_ids: Vec<Uuid> = hist.iter().map(|l| l.entry_id).collect();
        let evidence_truncated = entry_ids.len() > MAX_EVIDENCE;
        entry_ids.truncate(MAX_EVIDENCE);
        let evidence_refs: Vec<String> = entry_ids.iter().map(|e| format!("journal:{e}")).collect();
        let conflicts = conflicts_for(st, &self.entities);
        if !conflicts.is_empty() {
            self.downgrade(Status::Conflict);
        }
        let mut coverage: Map<String, Value> = Map::new();
        let cov: Coverage = blackbox_domain::views::coverage_for(st, &self.coverage_datasets);
        coverage.insert("datasets_present".into(), json!(cov.datasets_present));
        coverage.insert("datasets_missing".into(), json!(cov.datasets_missing));
        coverage.insert("population".into(), json!({"records_considered": total, "returned": returned}));
        coverage.insert("evidence_truncated".into(), json!(evidence_truncated));
        coverage.insert("coverage_assertions".into(), json!(coverage_assertions(st)));
        if !cold_entities.is_empty() {
            coverage.insert("evidence_evicted_entities".into(), json!(cold_entities.len()));
        }
        for (k, v) in self.coverage_extra {
            coverage.insert(k, v);
        }
        if st.unknown_event_types.len() > 0 {
            coverage.insert("unknown_event_types".into(), json!(st.unknown_event_types.len()));
        }
        Ok(Envelope {
            status: self.status,
            intent: self.intent,
            result: Value::Object(self.result),
            calculation: self.calculation,
            rule_version: REDUCER_VERSION,
            evidence_refs,
            entry_ids,
            missing_inputs: self.missing_inputs,
            conflicts,
            coverage: Value::Object(coverage),
            effective_at: self.effective_at,
            page: PageOut {
                next_cursor,
                truncated,
                returned,
                total,
                snapshot_cursor: snapshot,
            },
            cold_entities,
        })
    }
}

/// Coverage assertions recorded by the ingestion (coverage.observed / gap entries).
pub fn coverage_assertions(st: &TenantState) -> Vec<Value> {
    use blackbox_domain::Kind;
    st.ids(Kind::Coverage)
        .iter()
        .filter_map(|id| st.rec(Kind::Coverage, *id))
        .map(|r| blackbox_domain::views::record_view(st, r))
        .collect()
}

/// Runs one intent.
pub fn run(
    st: &TenantState,
    tenant: Uuid,
    intent: &str,
    raw_params: &Map<String, Value>,
    page: &PageIn,
    now: DateTime<Utc>,
    applied: i64,
) -> Result<Envelope, QueryError> {
    let params = validate_params(intent, raw_params)?;
    let now = params.time("now").unwrap_or(now);
    let answer = intents::dispatch(st, intent, &params, now)?;
    answer.finish(tenant, page, applied)
}
