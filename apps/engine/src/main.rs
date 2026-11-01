//! blackbox-engine: axum HTTP service implementing packages/contracts/engine-rpc.json on the
//! private Compose network. See docs/engine.md.

mod admission;
mod logging;
mod rss;

use admission::{Admission, Limits, Rejected};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use blackbox_domain::{Kind, TenantState, REDUCER_VERSION};
use blackbox_projections::cold::ColdKey;
use blackbox_projections::engine::{replay_entity, replay_tenant};
use blackbox_projections::{EngineConfig, Registry, TenantSlot, PHASE_CATCHING_UP, PHASE_LOADING, PHASE_READY, PHASE_REBUILDING};
use blackbox_query::state::{entity_state, summary};
use blackbox_query::{PageIn, QueryError};
use blackbox_storage::{Store, StoreConfig};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tracing::{info, warn};
use tracing_subscriber::prelude::*;
use uuid::Uuid;

const DEFAULT_DEADLINE_MS: u64 = 5000;
const MAX_DEADLINE_MS: u64 = 5000;
const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_SUMMARY_DAYS: i64 = 92;

#[derive(Clone)]
struct App {
    store: Store,
    registry: Arc<Registry>,
    admission: Arc<Admission>,
    token: Arc<String>,
    version: String,
    shutdown: watch::Receiver<bool>,
}

// ------------------------------------------------------------------ errors

struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    retryable: bool,
    retry_after_ms: Option<u64>,
    extra: Map<String, Value>,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> ApiError {
        ApiError {
            status,
            code,
            message: message.into(),
            retryable: false,
            retry_after_ms: None,
            extra: Map::new(),
        }
    }

    fn unauthorized() -> ApiError {
        ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized", "missing or invalid X-Engine-Token")
    }

    fn invalid(msg: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::BAD_REQUEST, "invalid_params", msg)
    }

    fn tenant_unknown(t: Uuid) -> ApiError {
        ApiError::new(StatusCode::NOT_FOUND, "tenant_unknown", format!("tenant {t} is not known to this engine"))
    }

    fn overloaded(which: Rejected) -> ApiError {
        let mut e = ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "overloaded",
            match which {
                Rejected::Global => "engine concurrency limit reached",
                Rejected::Workspace => "workspace concurrency limit reached",
                Rejected::Agent => "agent concurrency limit reached",
            },
        );
        e.retryable = true;
        e.retry_after_ms = Some(200);
        e
    }

    fn deadline() -> ApiError {
        let mut e = ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "deadline_exceeded", "request deadline exceeded; underlying work was cancelled");
        e.retryable = true;
        e.retry_after_ms = Some(250);
        e
    }

    fn behind(applied: i64, required: i64) -> ApiError {
        let mut e = ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "projection_behind", format!("projection applied cursor {applied} is behind required cursor {required}"));
        e.retryable = true;
        e.retry_after_ms = Some(250);
        e.extra.insert("applied_cursor".into(), json!(applied));
        e.extra.insert("required_cursor".into(), json!(required));
        e
    }

    fn db(err: impl std::fmt::Display) -> ApiError {
        let mut e = ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "deadline_exceeded", format!("storage error: {err}"));
        e.retryable = true;
        e.retry_after_ms = Some(500);
        e
    }

    fn too_large(msg: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", msg)
    }
}

impl From<QueryError> for ApiError {
    fn from(e: QueryError) -> ApiError {
        match e {
            QueryError::UnsupportedIntent(s) => ApiError::new(StatusCode::BAD_REQUEST, "unsupported_intent", format!("unsupported intent: {s}")),
            QueryError::InvalidParams(s) => ApiError::invalid(s),
            QueryError::TooLarge(s) => ApiError::too_large(s),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut err = Map::new();
        err.insert("code".into(), json!(self.code));
        err.insert("message".into(), json!(self.message));
        err.insert("retryable".into(), json!(self.retryable));
        err.insert("retry_after_ms".into(), json!(self.retry_after_ms));
        for (k, v) in self.extra {
            err.insert(k, v);
        }
        let body = json!({"error": Value::Object(err)});
        let mut resp = (self.status, Json(body)).into_response();
        if let Some(ms) = self.retry_after_ms {
            if let Ok(v) = axum::http::HeaderValue::from_str(&format!("{}", ms.div_ceil(1000).max(1))) {
                resp.headers_mut().insert(axum::http::header::RETRY_AFTER, v);
            }
        }
        resp
    }
}

// ------------------------------------------------------------------ consistency

#[derive(Debug, Clone, Deserialize, Default)]
struct ConsistencyRequest {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    cursor: Option<i64>,
    #[serde(default)]
    as_of_recorded: Option<DateTime<Utc>>,
    #[serde(default)]
    as_of_effective: Option<DateTime<Utc>>,
    #[serde(default)]
    deadline_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct ConsistencyResponse {
    applied_cursor: i64,
    required_cursor: Option<i64>,
    reducer_version: u32,
    status: &'static str,
    recorded_cutoff: String,
    effective_cutoff: Option<String>,
    mode: String,
}

enum Resolved {
    Published(Arc<TenantState>),
    Scratch(Arc<TenantState>),
}

impl Resolved {
    fn state(&self) -> &TenantState {
        match self {
            Resolved::Published(s) | Resolved::Scratch(s) => s,
        }
    }
}

struct Cutoff {
    upto_sequence: i64,
    recorded: Option<DateTime<Utc>>,
    effective: Option<DateTime<Utc>>,
}

fn deadline_of(c: &ConsistencyRequest) -> Result<Duration, ApiError> {
    let ms = c.deadline_ms.unwrap_or(DEFAULT_DEADLINE_MS);
    if ms == 0 || ms > MAX_DEADLINE_MS {
        return Err(ApiError::invalid(format!("deadline_ms must be 1..={MAX_DEADLINE_MS}")));
    }
    Ok(Duration::from_millis(ms))
}

fn ms_rfc(ms: i64) -> String {
    blackbox_domain::state::ms_to_time(ms)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Resolves the state copy to serve and the consistency response for non-as_of modes;
/// for as_of returns the cutoff so the caller can replay the bounded scope.
async fn resolve_current(
    app: &App,
    slot: &TenantSlot,
    c: &ConsistencyRequest,
    deadline: Instant,
) -> Result<(Arc<TenantState>, ConsistencyResponse), ApiError> {
    let mode = c.mode.clone().unwrap_or_else(|| "latest_committed".into());
    match mode.as_str() {
        "latest_committed" | "at_least_cursor" => {
            let required = if mode == "at_least_cursor" {
                c.cursor.ok_or_else(|| ApiError::invalid("at_least_cursor requires consistency.cursor"))?
            } else {
                let committed = app.store.committed_cursor(slot.tenant_id).await.map_err(ApiError::db)?;
                let prev = slot.committed.load(Ordering::Acquire);
                if committed > prev {
                    slot.committed.store(committed, Ordering::Release);
                }
                committed
            };
            let applied = slot.wait_applied(required, deadline).await;
            if applied < required {
                return Err(ApiError::behind(applied, required));
            }
            let state = slot.state();
            if state.applied_sequence < required {
                return Err(ApiError::behind(state.applied_sequence, required));
            }
            Ok((
                state.clone(),
                ConsistencyResponse {
                    applied_cursor: state.applied_sequence,
                    required_cursor: Some(required),
                    reducer_version: REDUCER_VERSION,
                    status: "current",
                    recorded_cutoff: ms_rfc(state.last_recorded_ms),
                    effective_cutoff: None,
                    mode,
                },
            ))
        }
        "stale_explicit" => {
            let state = slot.state();
            Ok((
                state.clone(),
                ConsistencyResponse {
                    applied_cursor: state.applied_sequence,
                    required_cursor: None,
                    reducer_version: REDUCER_VERSION,
                    status: "stale",
                    recorded_cutoff: ms_rfc(state.last_recorded_ms),
                    effective_cutoff: None,
                    mode,
                },
            ))
        }
        "as_of" => Err(ApiError::invalid("internal: as_of handled separately")),
        other => Err(ApiError::invalid(format!("unknown consistency mode '{other}'"))),
    }
}

async fn as_of_cutoff(app: &App, tenant: Uuid, c: &ConsistencyRequest) -> Result<Cutoff, ApiError> {
    let recorded = c
        .as_of_recorded
        .ok_or_else(|| ApiError::invalid("as_of requires consistency.as_of_recorded (RFC3339)"))?;
    let upto = app
        .store
        .max_sequence_recorded_until(tenant, recorded)
        .await
        .map_err(ApiError::db)?;
    Ok(Cutoff {
        upto_sequence: upto,
        recorded: Some(recorded),
        effective: c.as_of_effective,
    })
}

fn historical_response(cut: &Cutoff, mode: &str) -> ConsistencyResponse {
    ConsistencyResponse {
        applied_cursor: cut.upto_sequence,
        required_cursor: Some(cut.upto_sequence),
        reducer_version: REDUCER_VERSION,
        status: "historical",
        recorded_cutoff: cut.recorded.unwrap_or(DateTime::<Utc>::UNIX_EPOCH).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        effective_cutoff: cut.effective.map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        mode: mode.to_string(),
    }
}

fn is_as_of(c: &ConsistencyRequest) -> bool {
    c.mode.as_deref() == Some("as_of")
}

/// Replays an entity (and, for orders, its linked items) at a recorded cutoff; cached in the
/// cold LRU.
async fn replay_scoped(app: &App, tenant: Uuid, kind: Kind, id: &str, cut: &Cutoff) -> Result<Arc<TenantState>, ApiError> {
    let key = ColdKey {
        tenant,
        entity_type: kind.as_str().to_string(),
        entity_id: id.to_string(),
        upto_sequence: cut.upto_sequence,
        effective_cutoff_ms: cut.effective.map(blackbox_domain::state::time_to_ms).unwrap_or(0),
    };
    if let Some(s) = app.registry.cold.get(&key) {
        return Ok(s);
    }
    let max = app.registry.config.replay_max_entries;
    let (mut st, n) = replay_entity(&app.store, tenant, kind.as_str(), id, cut.upto_sequence, cut.recorded, cut.effective, max)
        .await
        .map_err(ApiError::db)?;
    if n >= max {
        return Err(ApiError::too_large(format!("entity history exceeds the replay bound of {max} entries; use /v1/history pages")));
    }
    if kind == Kind::Order {
        // Stock lives on the item: merge the linked items' entries (sequence order) so the
        // historical order view carries stock figures at the same cutoff.
        let items: Vec<String> = st
            .rec_by_str(Kind::Order, id)
            .map(|o| o.linked(Kind::Item).map(|i| st.sym(i).to_string()).collect())
            .unwrap_or_default();
        if !items.is_empty() {
            let mut all = app
                .store
                .entity_entries(tenant, kind.as_str(), id, 0, cut.upto_sequence, cut.recorded, max)
                .await
                .map_err(ApiError::db)?;
            for item in &items {
                let more = app
                    .store
                    .entity_entries(tenant, "item", item, 0, cut.upto_sequence, cut.recorded, max)
                    .await
                    .map_err(ApiError::db)?;
                all.extend(more);
            }
            all.sort_by_key(|e| e.journal_sequence);
            all.dedup_by_key(|e| e.entry_id);
            if all.len() as i64 >= max {
                return Err(ApiError::too_large(format!("entity history exceeds the replay bound of {max} entries; use /v1/history pages")));
            }
            let mut merged = TenantState::new(tenant);
            for e in &all {
                if cut.effective.map(|eff| e.occurred_at <= eff).unwrap_or(true) {
                    blackbox_domain::apply(&mut merged, e);
                }
            }
            st = merged;
        }
    }
    let arc = Arc::new(st);
    app.registry.cold.insert(key, arc.clone());
    Ok(arc)
}

async fn replay_whole_tenant(app: &App, tenant: Uuid, cut: &Cutoff) -> Result<Arc<TenantState>, ApiError> {
    let key = ColdKey {
        tenant,
        entity_type: "*tenant*".into(),
        entity_id: String::new(),
        upto_sequence: cut.upto_sequence,
        effective_cutoff_ms: cut.effective.map(blackbox_domain::state::time_to_ms).unwrap_or(0),
    };
    if let Some(s) = app.registry.cold.get(&key) {
        return Ok(s);
    }
    let recorded = cut.recorded.unwrap_or(DateTime::<Utc>::UNIX_EPOCH);
    let max = app.registry.config.replay_max_entries;
    let (st, _n, truncated) = replay_tenant(&app.store, tenant, recorded, cut.effective, max)
        .await
        .map_err(ApiError::db)?;
    if truncated {
        return Err(ApiError::too_large(format!("tenant-wide as_of replay exceeds the bound of {max} entries")));
    }
    let arc = Arc::new(st);
    app.registry.cold.insert(key, arc.clone());
    Ok(arc)
}

// ------------------------------------------------------------------ request plumbing

fn check_token(app: &App, headers: &HeaderMap) -> Result<(), ApiError> {
    let given = headers.get("x-engine-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    let expected = app.token.as_bytes();
    let g = given.as_bytes();
    if expected.is_empty() || g.len() != expected.len() {
        return Err(ApiError::unauthorized());
    }
    let mut diff = 0u8;
    for (a, b) in g.iter().zip(expected.iter()) {
        diff |= a ^ b;
    }
    if diff != 0 {
        return Err(ApiError::unauthorized());
    }
    Ok(())
}

fn parse_body<T: for<'de> Deserialize<'de>>(body: &Bytes) -> Result<T, ApiError> {
    if body.len() > MAX_BODY_BYTES {
        return Err(ApiError::too_large(format!("request body exceeds {MAX_BODY_BYTES} bytes")));
    }
    serde_json::from_slice(body).map_err(|e| ApiError::invalid(format!("invalid JSON body: {e}")))
}

fn principal(headers: &HeaderMap) -> Option<String> {
    headers.get("x-principal-id").and_then(|v| v.to_str().ok()).map(|s| s.to_string())
}

async fn slot_for(app: &App, tenant: Uuid) -> Result<Arc<TenantSlot>, ApiError> {
    if let Some(s) = app.registry.get(tenant) {
        return Ok(s);
    }
    // Possibly a tenant created after the last discovery: check once.
    if app.store.tenant_exists(tenant).await.map_err(ApiError::db)? {
        let (slot, created) = app.registry.get_or_insert(tenant);
        if created {
            let store = app.store.clone();
            let registry = app.registry.clone();
            let rx = app.shutdown.clone();
            let s = slot.clone();
            tokio::spawn(async move { blackbox_projections::engine::tenant_loop(store, registry, s, rx).await });
        }
        return Ok(slot);
    }
    Err(ApiError::tenant_unknown(tenant))
}

/// Runs `fut` under admission control and the request deadline (cancelling the work).
async fn guarded<F, T>(app: &App, tenant: Uuid, headers: &HeaderMap, deadline: Duration, fut: F) -> Result<T, ApiError>
where
    F: std::future::Future<Output = Result<T, ApiError>>,
{
    let _permits = app
        .admission
        .try_admit(tenant, principal(headers).as_deref())
        .map_err(|r| {
            app.admission.rejected.fetch_add(1, Ordering::Relaxed);
            ApiError::overloaded(r)
        })?;
    match tokio::time::timeout(deadline, fut).await {
        Ok(r) => r,
        Err(_) => Err(ApiError::deadline()),
    }
}

// ------------------------------------------------------------------ handlers

#[derive(Deserialize)]
struct StateRequest {
    tenant_id: Uuid,
    entity_type: String,
    entity_id: String,
    #[serde(default)]
    consistency: ConsistencyRequest,
}

async fn state_handler(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    check_token(&app, &headers)?;
    let req: StateRequest = parse_body(&body)?;
    let deadline = deadline_of(&req.consistency)?;
    let kind = Kind::parse(&req.entity_type).ok_or_else(|| ApiError::invalid(format!("unknown entity_type '{}'", req.entity_type)))?;
    if req.entity_id.is_empty() || req.entity_id.len() > 200 {
        return Err(ApiError::invalid("entity_id must be 1..=200 characters"));
    }
    let started = Instant::now();
    let tenant = req.tenant_id;
    guarded(&app, tenant, &headers, deadline, async {
        let slot = slot_for(&app, tenant).await?;
        let (resolved, consistency) = if is_as_of(&req.consistency) {
            let cut = as_of_cutoff(&app, tenant, &req.consistency).await?;
            let st = replay_scoped(&app, tenant, kind, &req.entity_id, &cut).await?;
            (Resolved::Scratch(st), historical_response(&cut, "as_of"))
        } else {
            let (st, c) = resolve_current(&app, &slot, &req.consistency, started + deadline).await?;
            (Resolved::Published(st), c)
        };
        let st = resolved.state();
        let mut resp = match entity_state(st, kind, &req.entity_id) {
            Some(r) => r,
            None => {
                // Hot miss: the entity may be cold (evicted) or simply unknown. Try the cold path.
                let cut = Cutoff {
                    upto_sequence: st.applied_sequence,
                    recorded: None,
                    effective: None,
                };
                let cold = replay_scoped(&app, tenant, kind, &req.entity_id, &cut).await?;
                match entity_state(&cold, kind, &req.entity_id) {
                    Some(r) => r,
                    None => {
                        return Err(ApiError::new(StatusCode::NOT_FOUND, "invalid_params", format!("{} '{}' is not known in this tenant", kind.as_str(), req.entity_id)));
                    }
                }
            }
        };
        // Evicted history: serve track summaries from PostgreSQL (indexed cold read).
        if resp.missing_inputs.iter().any(|m| m == "history.evicted_use_cold_read") {
            let entries = app
                .store
                .entity_entries(tenant, kind.as_str(), &req.entity_id, 0, st.applied_sequence, None, 500)
                .await
                .map_err(ApiError::db)?;
            let mut tracks: Map<String, Value> = Map::new();
            for t in blackbox_domain::Track::ALL {
                let list: Vec<Value> = entries
                    .iter()
                    .filter(|e| e.track == t)
                    .map(|e| json!({"entry_id": e.entry_id, "journal_sequence": e.journal_sequence, "track": e.track, "record_id": e.record_id, "event_type": e.event_type, "occurred_at": e.occurred_at, "recorded_at": e.recorded_at, "supersedes_entry_id": e.supersedes_entry_id, "superseded_by": null, "effect": "cold_read"}))
                    .collect();
                tracks.insert(t.as_str().into(), json!({"entries": list, "total": list.len(), "truncated": entries.len() >= 500, "source": "postgresql"}));
            }
            resp.tracks = tracks;
            resp.entry_ids = entries.iter().map(|e| e.entry_id).collect();
            resp.evidence_refs = entries.iter().flat_map(|e| e.evidence_refs.clone()).collect();
        }
        let mut out = serde_json::to_value(&resp).unwrap_or(Value::Null);
        out["consistency"] = serde_json::to_value(&consistency).unwrap_or(Value::Null);
        out["duration_ms"] = json!(started.elapsed().as_millis() as u64);
        Ok(Json(out).into_response())
    })
    .await
}

#[derive(Deserialize)]
struct QueryRequest {
    tenant_id: Uuid,
    intent: String,
    #[serde(default)]
    params: Map<String, Value>,
    #[serde(default)]
    consistency: ConsistencyRequest,
    #[serde(default)]
    page: PageIn,
}

/// Parameters that scope an intent to one entity (as_of replays stay bounded).
fn scoped_entity(intent: &str, params: &Map<String, Value>) -> Option<(Kind, String)> {
    let s = |k: &str| params.get(k).and_then(|v| v.as_str()).map(|v| v.to_string());
    match intent {
        "inventory.available_to_sell" => s("item_id").map(|i| (Kind::Item, i)),
        "payouts.gross_to_net" => s("payout_id").map(|i| (Kind::Payout, i)),
        _ => s("order_id").map(|i| (Kind::Order, i)),
    }
}

async fn query_handler(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    check_token(&app, &headers)?;
    let req: QueryRequest = parse_body(&body)?;
    let deadline = deadline_of(&req.consistency)?;
    if !blackbox_query::intents::INTENTS.contains(&req.intent.as_str()) {
        return Err(QueryError::UnsupportedIntent(req.intent.clone()).into());
    }
    blackbox_query::validate_params(&req.intent, &req.params)?;
    let started = Instant::now();
    let tenant = req.tenant_id;
    let now = Utc::now();
    guarded(&app, tenant, &headers, deadline, async {
        let slot = slot_for(&app, tenant).await?;
        let (resolved, consistency) = if is_as_of(&req.consistency) {
            let cut = as_of_cutoff(&app, tenant, &req.consistency).await?;
            let st = match scoped_entity(&req.intent, &req.params) {
                Some((kind, id)) => replay_scoped(&app, tenant, kind, &id, &cut).await?,
                None => replay_whole_tenant(&app, tenant, &cut).await?,
            };
            (Resolved::Scratch(st), historical_response(&cut, "as_of"))
        } else {
            let (st, c) = resolve_current(&app, &slot, &req.consistency, started + deadline).await?;
            (Resolved::Published(st), c)
        };
        let st = resolved.state();
        let env = blackbox_query::run(st, tenant, &req.intent, &req.params, &req.page, now, consistency.applied_cursor)?;
        let mut out = serde_json::to_value(&env).unwrap_or(Value::Null);
        out["consistency"] = serde_json::to_value(&consistency).unwrap_or(Value::Null);
        out["duration_ms"] = json!(started.elapsed().as_millis() as u64);
        Ok(Json(out).into_response())
    })
    .await
}

#[derive(Deserialize)]
struct HistoryRequest {
    tenant_id: Uuid,
    entity_type: String,
    entity_id: String,
    #[serde(default)]
    page: PageIn,
    #[serde(default)]
    consistency: ConsistencyRequest,
}

async fn history_handler(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    check_token(&app, &headers)?;
    let req: HistoryRequest = parse_body(&body)?;
    let deadline = deadline_of(&req.consistency)?;
    let kind = Kind::parse(&req.entity_type).ok_or_else(|| ApiError::invalid(format!("unknown entity_type '{}'", req.entity_type)))?;
    let limit = req.page.limit.unwrap_or(blackbox_query::DEFAULT_PAGE_ROWS);
    if limit == 0 || limit > blackbox_query::MAX_PAGE_ROWS {
        return Err(ApiError::invalid(format!("page.limit must be 1..={}", blackbox_query::MAX_PAGE_ROWS)));
    }
    let started = Instant::now();
    let tenant = req.tenant_id;
    guarded(&app, tenant, &headers, deadline, async {
        let slot = slot_for(&app, tenant).await?;
        // Snapshot boundary: first page fixes it at the resolved cursor; later pages reuse it.
        let (snapshot, after, consistency, recorded_cutoff) = match &req.page.cursor {
            Some(c) => {
                let (snap, last) = blackbox_query::parse_cursor(tenant, c)?;
                let cons = if is_as_of(&req.consistency) {
                    let cut = as_of_cutoff(&app, tenant, &req.consistency).await?;
                    historical_response(&Cutoff { upto_sequence: snap, ..cut }, "as_of")
                } else {
                    let (_st, mut cns) = resolve_current(&app, &slot, &req.consistency, started + deadline).await?;
                    cns.required_cursor = Some(snap);
                    cns
                };
                (snap, last as i64, cons, req.consistency.as_of_recorded)
            }
            None => {
                if is_as_of(&req.consistency) {
                    let cut = as_of_cutoff(&app, tenant, &req.consistency).await?;
                    let cons = historical_response(&cut, "as_of");
                    (cut.upto_sequence, 0, cons, cut.recorded)
                } else {
                    let (st, cns) = resolve_current(&app, &slot, &req.consistency, started + deadline).await?;
                    (st.applied_sequence, 0, cns, None)
                }
            }
        };
        let mut entries = app
            .store
            .entity_entries(tenant, kind.as_str(), &req.entity_id, after, snapshot, recorded_cutoff, limit as i64 + 1)
            .await
            .map_err(ApiError::db)?;
        let truncated = entries.len() > limit;
        entries.truncate(limit);
        let last = entries.last().map(|e| e.journal_sequence).unwrap_or(after);
        let next_cursor = if truncated { Some(blackbox_query::make_cursor(tenant, snapshot, last as usize)) } else { None };
        let committed = slot.committed.load(Ordering::Acquire).max(slot.applied());
        let total = app
            .store
            .count_entity_entries(tenant, kind.as_str(), &req.entity_id, snapshot)
            .await
            .map_err(ApiError::db)?;
        let out = json!({
            "entity": {"type": kind.as_str(), "id": req.entity_id},
            "entries": entries,
            "page": {"next_cursor": next_cursor, "truncated": truncated, "returned": entries.len(), "total_in_snapshot": total, "snapshot_cursor": snapshot, "newer_available": committed > snapshot},
            "consistency": consistency,
            "duration_ms": started.elapsed().as_millis() as u64,
        });
        Ok(Json(out).into_response())
    })
    .await
}

#[derive(Deserialize)]
struct SummaryRequest {
    tenant_id: Uuid,
    kind: String,
    #[serde(default)]
    from: Option<DateTime<Utc>>,
    #[serde(default)]
    to: Option<DateTime<Utc>>,
    #[serde(default)]
    currency: Option<String>,
    #[serde(default)]
    consistency: ConsistencyRequest,
}

async fn summary_handler(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    check_token(&app, &headers)?;
    let req: SummaryRequest = parse_body(&body)?;
    if req.kind != "thirty_day_summary" {
        return Err(ApiError::invalid("kind must be thirty_day_summary"));
    }
    let deadline = deadline_of(&req.consistency)?;
    let to = req.to.unwrap_or_else(Utc::now);
    let from = req.from.unwrap_or(to - ChronoDuration::days(30));
    if from > to {
        return Err(ApiError::invalid("from must be <= to"));
    }
    if (to - from).num_days() > MAX_SUMMARY_DAYS {
        return Err(ApiError::too_large(format!("summary interval exceeds {MAX_SUMMARY_DAYS} days")));
    }
    let started = Instant::now();
    let tenant = req.tenant_id;
    guarded(&app, tenant, &headers, deadline, async {
        let slot = slot_for(&app, tenant).await?;
        let (resolved, consistency) = if is_as_of(&req.consistency) {
            let cut = as_of_cutoff(&app, tenant, &req.consistency).await?;
            let st = replay_whole_tenant(&app, tenant, &cut).await?;
            (Resolved::Scratch(st), historical_response(&cut, "as_of"))
        } else {
            let (st, c) = resolve_current(&app, &slot, &req.consistency, started + deadline).await?;
            (Resolved::Published(st), c)
        };
        let s = summary(resolved.state(), from, to, req.currency.as_deref());
        let mut out = serde_json::to_value(&s).unwrap_or(Value::Null);
        out["consistency"] = serde_json::to_value(&consistency).unwrap_or(Value::Null);
        out["duration_ms"] = json!(started.elapsed().as_millis() as u64);
        Ok(Json(out).into_response())
    })
    .await
}

#[derive(Deserialize)]
struct RebuildRequest {
    #[serde(default)]
    tenant_id: Option<Uuid>,
}

async fn rebuild_handler(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    check_token(&app, &headers)?;
    let req: RebuildRequest = parse_body(&body)?;
    let slots = match req.tenant_id {
        Some(t) => vec![slot_for(&app, t).await?],
        None => app.registry.all(),
    };
    for s in &slots {
        s.rebuild_requested.store(true, Ordering::Release);
        s.wake.notify_one();
    }
    info!(event_name = "engine.rebuild_accepted", record_count = slots.len() as i64, message = "rebuild requested");
    Ok(Json(json!({"accepted": true, "tenants": slots.len()})).into_response())
}

async fn snapshot_handler(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    check_token(&app, &headers)?;
    let req: RebuildRequest = parse_body(&body)?;
    let slots = match req.tenant_id {
        Some(t) => vec![slot_for(&app, t).await?],
        None => app.registry.all(),
    };
    let mut written = 0;
    for s in &slots {
        if s.phase() == PHASE_READY {
            let st = s.state();
            blackbox_projections::engine::write_snapshot(&app.store, s, st).await;
            written += 1;
        }
    }
    Ok(Json(json!({"accepted": true, "snapshots_written": written})).into_response())
}

async fn schema_handler(State(app): State<App>, headers: HeaderMap) -> Result<Response, ApiError> {
    check_token(&app, &headers)?;
    Ok(Json(blackbox_query::schema::describe()).into_response())
}

fn health_json(app: &App, db_ok: bool) -> (Value, bool) {
    let mut tenants = Map::new();
    let mut any_loading = false;
    let mut any_rebuilding = false;
    let mut any_error = false;
    for s in app.registry.all() {
        let phase = s.phase();
        match phase {
            PHASE_LOADING | PHASE_CATCHING_UP => any_loading = true,
            PHASE_REBUILDING => any_rebuilding = true,
            _ => {}
        }
        if s.last_error.lock().unwrap().is_some() {
            any_error = true;
        }
        let applied = s.applied();
        let committed = s.committed().max(applied);
        tenants.insert(
            s.tenant_id.to_string(),
            json!({
                "applied_cursor": applied,
                "committed_cursor": committed,
                "lag_entries": committed - applied,
                "phase": blackbox_projections::phase_str(phase),
                "approx_resident_bytes": s.approx_bytes.load(Ordering::Relaxed) * 2,
                "budget_bytes_per_copy": s.budget_bytes.load(Ordering::Relaxed),
                "evictions": s.evictions.load(Ordering::Relaxed),
                "batches_applied": s.batches_applied.load(Ordering::Relaxed),
                "entries_applied": s.entries_applied.load(Ordering::Relaxed),
                "snapshots_written": s.snapshots_written.load(Ordering::Relaxed),
                "snapshot_rejections": s.snapshot_rejections.load(Ordering::Relaxed),
                "loaded_from_snapshot": s.loaded_from_snapshot.load(Ordering::Relaxed),
                "last_publication_age_ms": s.last_publication.lock().unwrap().map(|t| t.elapsed().as_millis() as u64),
            }),
        );
    }
    let status = if !db_ok || any_error {
        "degraded"
    } else if any_rebuilding {
        "rebuilding"
    } else if any_loading {
        "catching_up"
    } else {
        "healthy"
    };
    let r = rss::rss();
    let v = json!({
        "status": status,
        "reducer_version": REDUCER_VERSION,
        "snapshot_format_version": blackbox_projections::snapshot::SNAPSHOT_FORMAT_VERSION,
        "service_version": app.version,
        "tenants": tenants,
        "rss_bytes": r.bytes,
        "rss_note": r.note,
        "uptime_seconds": app.registry.started_at.elapsed().as_secs(),
        "heartbeat_at": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "memory": {
            "hot_budget_bytes": app.registry.config.hot_budget_bytes,
            "approx_resident_bytes": app.registry.total_approx_bytes(),
            "cold_cache_bytes": app.registry.cold.bytes(),
            "cold_cache_budget_bytes": app.registry.cold.budget(),
            "cold_cache_entries": app.registry.cold.len(),
            "cold_cache_hits": app.registry.cold.hits.load(Ordering::Relaxed),
            "cold_cache_misses": app.registry.cold.misses.load(Ordering::Relaxed),
        },
        "admission": {
            "in_flight": app.admission.in_flight_global(),
            "admitted": app.admission.admitted.load(Ordering::Relaxed),
            "rejected": app.admission.rejected.load(Ordering::Relaxed),
            "limits": {"global": app.admission.limits.global, "per_workspace": app.admission.limits.per_workspace, "per_agent": app.admission.limits.per_agent},
        },
        "database": {"reachable": db_ok},
    });
    (v, status == "healthy")
}

async fn health_handler(State(app): State<App>, headers: HeaderMap) -> Result<Response, ApiError> {
    check_token(&app, &headers)?;
    let db_ok = tokio::time::timeout(Duration::from_secs(2), app.store.ping()).await.map(|r| r.is_ok()).unwrap_or(false);
    let (v, _) = health_json(&app, db_ok);
    Ok(Json(v).into_response())
}

// ------------------------------------------------------------------ main

fn load_token() -> anyhow::Result<String> {
    if let Ok(path) = std::env::var("ENGINE_TOKEN_FILE") {
        let t = std::fs::read_to_string(&path).map_err(|e| anyhow::anyhow!("cannot read ENGINE_TOKEN_FILE {path}: {e}"))?;
        return Ok(t.trim().to_string());
    }
    if let Ok(t) = std::env::var("ENGINE_TOKEN") {
        if !t.trim().is_empty() {
            return Ok(t.trim().to_string());
        }
    }
    anyhow::bail!("ENGINE_TOKEN or ENGINE_TOKEN_FILE must be set")
}

fn bind_address() -> String {
    std::env::var("ENGINE_LISTEN")
        .or_else(|_| std::env::var("ENGINE_BIND"))
        .unwrap_or_else(|_| "0.0.0.0:7070".into())
}

async fn healthcheck() -> i32 {
    let token = match load_token() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("healthcheck: {e}");
            return 2;
        }
    };
    let bind = bind_address();
    let port = bind.rsplit(':').next().unwrap_or("7070");
    let url = format!("http://127.0.0.1:{port}/health");
    let client = reqwest::Client::builder().timeout(Duration::from_secs(3)).build().unwrap();
    match client.get(&url).header("X-Engine-Token", token).send().await {
        Ok(r) if r.status().is_success() => {
            let v: Value = r.json().await.unwrap_or(Value::Null);
            let status = v["status"].as_str().unwrap_or("");
            if status == "healthy" || status == "catching_up" || status == "rebuilding" {
                0
            } else {
                eprintln!("healthcheck: status {status}");
                1
            }
        }
        Ok(r) => {
            eprintln!("healthcheck: http {}", r.status());
            1
        }
        Err(e) => {
            eprintln!("healthcheck: {e}");
            1
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--healthcheck") {
        std::process::exit(healthcheck().await);
    }
    let version = std::env::var("BLACKBOX_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());
    let instance_id = format!("engine-{}", &Uuid::new_v4().to_string()[..8]);
    let level = match std::env::var("LOG_LEVEL").or_else(|_| std::env::var("RUST_LOG")).unwrap_or_else(|_| "info".into()).to_ascii_lowercase().as_str() {
        "debug" | "trace" => tracing::Level::DEBUG,
        "warn" | "warning" => tracing::Level::WARN,
        "error" => tracing::Level::ERROR,
        _ => tracing::Level::INFO,
    };
    tracing_subscriber::registry()
        .with(logging::JsonLayer::new(version.clone(), instance_id.clone(), level))
        .init();

    let token = load_token()?;
    let cfg = StoreConfig::from_env()?;
    let store = Store::connect(&cfg).await?;
    store.ping().await?;
    let engine_cfg = EngineConfig::from_env();
    let registry = Arc::new(Registry::new(engine_cfg.clone()));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    blackbox_projections::engine::start(store.clone(), registry.clone(), shutdown_rx.clone()).await;

    let app = App {
        store,
        registry,
        admission: Arc::new(Admission::new(Limits {
            global: 32,
            per_workspace: 16,
            per_agent: 8,
        })),
        token: Arc::new(token),
        version: version.clone(),
        shutdown: shutdown_rx.clone(),
    };
    let router = Router::new()
        .route("/health", get(health_handler))
        .route("/v1/state", post(state_handler))
        .route("/v1/query", post(query_handler))
        .route("/v1/history", post(history_handler))
        .route("/v1/summary", post(summary_handler))
        .route("/v1/admin/rebuild", post(rebuild_handler))
        .route("/v1/admin/snapshot", post(snapshot_handler))
        .route("/v1/schema", get(schema_handler))
        .with_state(app.clone());
    let bind = bind_address();
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    info!(event_name = "engine.started", message = format!("blackbox-engine {version} listening on {bind} (private network only; hot budget {} MiB)", engine_cfg.hot_budget_bytes / 1024 / 1024));
    let serve = axum::serve(listener, router).with_graceful_shutdown(async move {
        let ctrl_c = tokio::signal::ctrl_c();
        #[cfg(unix)]
        {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
            tokio::select! {
                _ = ctrl_c => {},
                _ = term.recv() => {},
            }
        }
        #[cfg(not(unix))]
        {
            let _ = ctrl_c.await;
        }
        let _ = shutdown_tx.send(true);
        warn!(event_name = "engine.stopping", termination = "signal", message = "shutdown signal received");
    });
    serve.await?;
    Ok(())
}
