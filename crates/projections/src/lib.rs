//! Per-tenant in-memory projections: atomic publication (ArcSwap, left-right double buffer),
//! persisted checkpoints and snapshots, journal tail apply loop, memory budget and a bounded LRU
//! for cold-hydrated/as-of entity replays. See docs/engine.md.

pub mod cold;
pub mod engine;
pub mod evict;
pub mod snapshot;

use arc_swap::ArcSwap;
use blackbox_domain::TenantState;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use uuid::Uuid;

pub const PHASE_LOADING: u8 = 0;
pub const PHASE_READY: u8 = 1;
pub const PHASE_REBUILDING: u8 = 2;
pub const PHASE_CATCHING_UP: u8 = 3;

pub fn phase_str(p: u8) -> &'static str {
    match p {
        PHASE_LOADING => "loading",
        PHASE_READY => "ready",
        PHASE_REBUILDING => "rebuilding",
        PHASE_CATCHING_UP => "catching_up",
        _ => "unknown",
    }
}

#[derive(Clone, Debug)]
pub struct EngineConfig {
    /// Total hot budget in bytes (ENGINE_HOT_BUDGET_MB, default 512). Each tenant holds two
    /// copies (published + write), so the structural per-copy budget is half of the per-tenant
    /// share.
    pub hot_budget_bytes: usize,
    /// Optional per-tenant cap in bytes (ENGINE_TENANT_BUDGET_MB); 0 = derived from global.
    pub tenant_budget_bytes: usize,
    pub batch_size: i64,
    pub poll_interval: Duration,
    pub snapshot_interval: Duration,
    pub snapshot_min_entries: u64,
    pub tenant_discovery_interval: Duration,
    /// Cold-hydration LRU budget (ENGINE_COLD_CACHE_MB, default 64).
    pub cold_cache_bytes: usize,
    /// Maximum entries replayed for one as_of/cold request (ENGINE_REPLAY_MAX_ENTRIES).
    pub replay_max_entries: i64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            hot_budget_bytes: 512 * 1024 * 1024,
            tenant_budget_bytes: 0,
            batch_size: 1000,
            poll_interval: Duration::from_millis(250),
            snapshot_interval: Duration::from_secs(60),
            snapshot_min_entries: 200,
            tenant_discovery_interval: Duration::from_secs(5),
            cold_cache_bytes: 64 * 1024 * 1024,
            replay_max_entries: 200_000,
        }
    }
}

impl EngineConfig {
    pub fn from_env() -> EngineConfig {
        let mut c = EngineConfig::default();
        let mb = |k: &str| -> Option<usize> {
            std::env::var(k).ok().and_then(|v| v.parse::<usize>().ok()).map(|m| m * 1024 * 1024)
        };
        if let Some(b) = mb("ENGINE_HOT_BUDGET_MB") {
            c.hot_budget_bytes = b;
        }
        if let Some(b) = mb("ENGINE_TENANT_BUDGET_MB") {
            c.tenant_budget_bytes = b;
        }
        if let Some(b) = mb("ENGINE_COLD_CACHE_MB") {
            c.cold_cache_bytes = b;
        }
        if let Some(v) = std::env::var("ENGINE_BATCH_SIZE").ok().and_then(|v| v.parse().ok()) {
            c.batch_size = v;
        }
        if let Some(v) = std::env::var("ENGINE_POLL_MS").ok().and_then(|v| v.parse().ok()) {
            c.poll_interval = Duration::from_millis(v);
        }
        if let Some(v) = std::env::var("ENGINE_SNAPSHOT_SECONDS").ok().and_then(|v| v.parse().ok()) {
            c.snapshot_interval = Duration::from_secs(v);
        }
        if let Some(v) = std::env::var("ENGINE_SNAPSHOT_MIN_ENTRIES").ok().and_then(|v| v.parse().ok()) {
            c.snapshot_min_entries = v;
        }
        if let Some(v) = std::env::var("ENGINE_REPLAY_MAX_ENTRIES").ok().and_then(|v| v.parse().ok()) {
            c.replay_max_entries = v;
        }
        c
    }
}

/// One tenant's published state and status counters.
pub struct TenantSlot {
    pub tenant_id: Uuid,
    pub published: ArcSwap<TenantState>,
    pub phase: AtomicU8,
    pub committed: AtomicI64,
    pub applied: AtomicI64,
    /// Signalled after every publication.
    pub applied_notify: Notify,
    /// Wake hint from LISTEN journal_appended or admin.
    pub wake: Notify,
    pub rebuild_requested: AtomicBool,
    pub approx_bytes: AtomicUsize,
    pub budget_bytes: AtomicUsize,
    pub evictions: AtomicU64,
    pub batches_applied: AtomicU64,
    pub entries_applied: AtomicU64,
    pub snapshots_written: AtomicU64,
    pub snapshot_rejections: AtomicU64,
    pub last_publication: Mutex<Option<Instant>>,
    pub last_error: Mutex<Option<String>>,
    pub loaded_from_snapshot: AtomicBool,
}

impl TenantSlot {
    pub fn new(tenant_id: Uuid) -> TenantSlot {
        TenantSlot {
            tenant_id,
            published: ArcSwap::from_pointee(TenantState::new(tenant_id)),
            phase: AtomicU8::new(PHASE_LOADING),
            committed: AtomicI64::new(0),
            applied: AtomicI64::new(0),
            applied_notify: Notify::new(),
            wake: Notify::new(),
            rebuild_requested: AtomicBool::new(false),
            approx_bytes: AtomicUsize::new(0),
            budget_bytes: AtomicUsize::new(0),
            evictions: AtomicU64::new(0),
            batches_applied: AtomicU64::new(0),
            entries_applied: AtomicU64::new(0),
            snapshots_written: AtomicU64::new(0),
            snapshot_rejections: AtomicU64::new(0),
            last_publication: Mutex::new(None),
            last_error: Mutex::new(None),
            loaded_from_snapshot: AtomicBool::new(false),
        }
    }

    pub fn phase(&self) -> u8 {
        self.phase.load(Ordering::Acquire)
    }

    pub fn applied(&self) -> i64 {
        self.applied.load(Ordering::Acquire)
    }

    pub fn committed(&self) -> i64 {
        self.committed.load(Ordering::Acquire)
    }

    /// Current published state (never a cursor ahead of publication).
    pub fn state(&self) -> Arc<TenantState> {
        self.published.load_full()
    }

    /// Waits until `applied >= required` or the deadline passes. Returns the applied cursor.
    pub async fn wait_applied(&self, required: i64, deadline: Instant) -> i64 {
        loop {
            let a = self.applied();
            if a >= required {
                return a;
            }
            let now = Instant::now();
            if now >= deadline {
                return a;
            }
            let notified = self.applied_notify.notified();
            tokio::pin!(notified);
            // Re-check after registering interest to avoid a lost wake-up.
            if self.applied() >= required {
                return self.applied();
            }
            let _ = tokio::time::timeout(deadline - now, &mut notified).await;
        }
    }
}

/// All tenants known to this engine process.
pub struct Registry {
    tenants: RwLock<HashMap<Uuid, Arc<TenantSlot>>>,
    pub config: EngineConfig,
    pub cold: cold::ColdCache,
    pub started_at: Instant,
}

impl Registry {
    pub fn new(config: EngineConfig) -> Registry {
        let cold = cold::ColdCache::new(config.cold_cache_bytes);
        Registry {
            tenants: RwLock::new(HashMap::new()),
            config,
            cold,
            started_at: Instant::now(),
        }
    }

    pub fn get(&self, tenant: Uuid) -> Option<Arc<TenantSlot>> {
        self.tenants.read().unwrap().get(&tenant).cloned()
    }

    pub fn get_or_insert(&self, tenant: Uuid) -> (Arc<TenantSlot>, bool) {
        if let Some(s) = self.get(tenant) {
            return (s, false);
        }
        let mut w = self.tenants.write().unwrap();
        if let Some(s) = w.get(&tenant) {
            return (s.clone(), false);
        }
        let slot = Arc::new(TenantSlot::new(tenant));
        w.insert(tenant, slot.clone());
        (slot, true)
    }

    pub fn all(&self) -> Vec<Arc<TenantSlot>> {
        self.tenants.read().unwrap().values().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.tenants.read().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Structural per-copy budget for one tenant.
    pub fn tenant_budget(&self) -> usize {
        let n = self.len().max(1);
        let share = self.config.hot_budget_bytes / 2 / n;
        if self.config.tenant_budget_bytes > 0 {
            share.min(self.config.tenant_budget_bytes / 2)
        } else {
            share
        }
    }

    pub fn total_approx_bytes(&self) -> usize {
        self.all().iter().map(|s| s.approx_bytes.load(Ordering::Relaxed) * 2).sum::<usize>()
            + self.cold.bytes()
    }
}
