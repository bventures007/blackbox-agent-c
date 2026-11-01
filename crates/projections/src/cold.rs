//! Bounded LRU of cold-hydrated / as-of replays. Keyed by (tenant, entity_type, entity_id,
//! recorded cutoff sequence, effective cutoff). Replays are scratch `TenantState`s built from
//! indexed PostgreSQL reads through the same reducers.

use blackbox_domain::TenantState;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ColdKey {
    pub tenant: Uuid,
    pub entity_type: String,
    pub entity_id: String,
    pub upto_sequence: i64,
    pub effective_cutoff_ms: i64,
}

struct Slot {
    state: Arc<TenantState>,
    bytes: usize,
    tick: u64,
}

pub struct ColdCache {
    inner: Mutex<Inner>,
    budget: usize,
    tick: AtomicU64,
    pub hits: AtomicU64,
    pub misses: AtomicU64,
    pub evictions: AtomicU64,
}

struct Inner {
    map: HashMap<ColdKey, Slot>,
    bytes: usize,
}

impl ColdCache {
    pub fn new(budget: usize) -> ColdCache {
        ColdCache {
            inner: Mutex::new(Inner {
                map: HashMap::new(),
                bytes: 0,
            }),
            budget,
            tick: AtomicU64::new(0),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            evictions: AtomicU64::new(0),
        }
    }

    pub fn get(&self, key: &ColdKey) -> Option<Arc<TenantState>> {
        let mut g = self.inner.lock().unwrap();
        let tick = self.tick.fetch_add(1, Ordering::Relaxed);
        match g.map.get_mut(key) {
            Some(s) => {
                s.tick = tick;
                self.hits.fetch_add(1, Ordering::Relaxed);
                Some(s.state.clone())
            }
            None => {
                self.misses.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }

    pub fn insert(&self, key: ColdKey, state: Arc<TenantState>) {
        let bytes = state.approx_bytes().max(1024);
        if bytes > self.budget {
            return;
        }
        let mut g = self.inner.lock().unwrap();
        let tick = self.tick.fetch_add(1, Ordering::Relaxed);
        if let Some(old) = g.map.remove(&key) {
            g.bytes -= old.bytes;
        }
        while g.bytes + bytes > self.budget && !g.map.is_empty() {
            let victim = g
                .map
                .iter()
                .min_by_key(|(_, s)| s.tick)
                .map(|(k, _)| k.clone())
                .expect("non-empty");
            if let Some(s) = g.map.remove(&victim) {
                g.bytes -= s.bytes;
                self.evictions.fetch_add(1, Ordering::Relaxed);
            }
        }
        g.bytes += bytes;
        g.map.insert(key, Slot { state, bytes, tick });
    }

    /// Drops every cached replay of a tenant (after rebuild requests).
    pub fn invalidate_tenant(&self, tenant: Uuid) {
        let mut g = self.inner.lock().unwrap();
        let keys: Vec<ColdKey> = g.map.keys().filter(|k| k.tenant == tenant).cloned().collect();
        for k in keys {
            if let Some(s) = g.map.remove(&k) {
                g.bytes -= s.bytes;
            }
        }
    }

    pub fn bytes(&self) -> usize {
        self.inner.lock().unwrap().bytes
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn budget(&self) -> usize {
        self.budget
    }
}
