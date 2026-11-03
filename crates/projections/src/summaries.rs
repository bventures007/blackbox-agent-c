//! Bounded LRU of payload-free entry summaries for records whose history locators were evicted
//! from RAM. Keyed by (tenant, entity type, entity id, applied cursor): the key names the exact
//! published cursor the rows were read at, so a hit can never serve rows for a different cursor
//! (a later publication of the tenant changes the key; a rebuild invalidates the tenant).

use blackbox_storage::EntrySummaryRow;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SummaryKey {
    pub tenant: Uuid,
    pub entity_type: String,
    pub entity_id: String,
    pub upto_sequence: i64,
}

struct Slot {
    rows: Arc<Vec<EntrySummaryRow>>,
    bytes: usize,
    tick: u64,
}

pub struct SummaryCache {
    inner: Mutex<Inner>,
    budget: usize,
    tick: AtomicU64,
    pub hits: AtomicU64,
    pub misses: AtomicU64,
    pub evictions: AtomicU64,
}

struct Inner {
    map: HashMap<SummaryKey, Slot>,
    bytes: usize,
}

fn rows_bytes(rows: &[EntrySummaryRow]) -> usize {
    rows.iter().map(|r| r.approx_bytes()).sum::<usize>() + 128
}

impl SummaryCache {
    pub fn new(budget: usize) -> SummaryCache {
        SummaryCache {
            inner: Mutex::new(Inner { map: HashMap::new(), bytes: 0 }),
            budget,
            tick: AtomicU64::new(0),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            evictions: AtomicU64::new(0),
        }
    }

    pub fn get(&self, key: &SummaryKey) -> Option<Arc<Vec<EntrySummaryRow>>> {
        let mut g = self.inner.lock().unwrap();
        let tick = self.tick.fetch_add(1, Ordering::Relaxed);
        match g.map.get_mut(key) {
            Some(s) => {
                s.tick = tick;
                self.hits.fetch_add(1, Ordering::Relaxed);
                Some(s.rows.clone())
            }
            None => {
                self.misses.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }

    /// Inserts (or replaces) the rows for a key; evicts least recently used keys to stay within budget.
    pub fn insert(&self, key: SummaryKey, rows: Arc<Vec<EntrySummaryRow>>) {
        let bytes = rows_bytes(&rows);
        if bytes > self.budget || self.budget == 0 {
            return;
        }
        let mut g = self.inner.lock().unwrap();
        let tick = self.tick.fetch_add(1, Ordering::Relaxed);
        if let Some(old) = g.map.remove(&key) {
            g.bytes -= old.bytes;
        }
        while g.bytes + bytes > self.budget && !g.map.is_empty() {
            let victim = g.map.iter().min_by_key(|(_, s)| s.tick).map(|(k, _)| k.clone()).expect("non-empty");
            if let Some(s) = g.map.remove(&victim) {
                g.bytes -= s.bytes;
                self.evictions.fetch_add(1, Ordering::Relaxed);
            }
        }
        g.bytes += bytes;
        g.map.insert(key, Slot { rows, bytes, tick });
    }

    /// Drops every cached summary of a tenant (rebuild).
    pub fn invalidate_tenant(&self, tenant: Uuid) {
        let mut g = self.inner.lock().unwrap();
        let keys: Vec<SummaryKey> = g.map.keys().filter(|k| k.tenant == tenant).cloned().collect();
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

#[cfg(test)]
mod tests {
    use super::*;
    use blackbox_domain::entry::Track;
    use chrono::Utc;

    fn row(seq: i64) -> EntrySummaryRow {
        EntrySummaryRow {
            entry_id: Uuid::new_v4(),
            journal_sequence: seq,
            track: Track::Source,
            record_id: format!("order:#{seq}"),
            event_type: "order.accepted".into(),
            occurred_at: Utc::now(),
            recorded_at: Utc::now(),
            supersedes_entry_id: None,
            evidence_refs: vec!["journal:x".into()],
        }
    }

    fn key(tenant: Uuid, id: &str, upto: i64) -> SummaryKey {
        SummaryKey { tenant, entity_type: "order".into(), entity_id: id.into(), upto_sequence: upto }
    }

    #[test]
    fn exact_cursor_keys_lru_eviction_and_tenant_invalidation() {
        let t = Uuid::new_v4();
        let rows = Arc::new(vec![row(1), row(2)]);
        let per = rows_bytes(&rows);
        let cache = SummaryCache::new(per * 3 + 10);
        cache.insert(key(t, "a", 10), rows.clone());
        assert!(cache.get(&key(t, "a", 10)).is_some());
        // A different applied cursor is a different key: never served from the old rows.
        assert!(cache.get(&key(t, "a", 11)).is_none());
        cache.insert(key(t, "b", 10), rows.clone());
        cache.insert(key(t, "c", 10), rows.clone());
        assert_eq!(cache.len(), 3);
        // Touch "a" so "b" is the least recently used, then overflow by one.
        assert!(cache.get(&key(t, "a", 10)).is_some());
        cache.insert(key(t, "d", 10), rows.clone());
        assert_eq!(cache.len(), 3);
        assert!(cache.get(&key(t, "b", 10)).is_none(), "LRU victim evicted");
        assert!(cache.get(&key(t, "a", 10)).is_some());
        assert!(cache.bytes() <= cache.budget());
        assert_eq!(cache.evictions.load(Ordering::Relaxed), 1);
        // Rows above budget are never cached; a rebuild drops the tenant.
        let huge = Arc::new((0..10_000).map(row).collect::<Vec<_>>());
        cache.insert(key(t, "huge", 10), huge);
        assert!(cache.get(&key(t, "huge", 10)).is_none());
        let other = Uuid::new_v4();
        cache.insert(key(other, "z", 1), rows.clone());
        cache.invalidate_tenant(t);
        assert_eq!(cache.len(), 1);
        assert!(cache.get(&key(other, "z", 1)).is_some());
    }
}
