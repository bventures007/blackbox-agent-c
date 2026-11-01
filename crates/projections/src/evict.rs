//! Deterministic memory eviction. Both state copies apply the same decision, so the published
//! and write copies stay identical. Business values are never evicted: only undo logs of old
//! entries and per-record history locators (which PostgreSQL serves through the entity index).

use blackbox_domain::state::RecKey;
use blackbox_domain::TenantState;

#[derive(Debug, Default, Clone, Copy)]
pub struct EvictionReport {
    pub undo_logs_dropped: usize,
    pub history_records_dropped: usize,
    pub bytes_before: usize,
    pub bytes_after: usize,
}

/// Evicts until the structural estimate is at or below `target_bytes` (best effort).
pub fn evict_to_budget(state: &mut TenantState, target_bytes: usize) -> EvictionReport {
    let mut report = EvictionReport {
        bytes_before: state.approx_bytes(),
        ..Default::default()
    };
    report.bytes_after = report.bytes_before;
    if report.bytes_before <= target_bytes {
        return report;
    }
    // Step 1: drop undo logs of the oldest half of resident entries (keep recent corrections cheap).
    let mut seqs: Vec<i64> = state
        .entries
        .values()
        .filter(|m| !m.undo.is_empty())
        .map(|m| m.seq)
        .collect();
    if !seqs.is_empty() {
        seqs.sort_unstable();
        let cut = seqs[seqs.len() / 2];
        for m in state.entries.values_mut() {
            if m.seq <= cut && !m.undo.is_empty() {
                m.undo = Vec::new();
                report.undo_logs_dropped += 1;
            }
        }
        if cut > state.undo_evicted_through {
            state.undo_evicted_through = cut;
        }
        report.bytes_after = state.approx_bytes();
        if report.bytes_after <= target_bytes {
            return report;
        }
    }
    // Step 2: drop history locators of the least recently touched records (oldest last_seq first).
    let mut candidates: Vec<(i64, RecKey)> = state
        .history
        .keys()
        .filter_map(|k| state.recs.get(k).map(|r| (r.last_seq, *k)))
        .collect();
    candidates.sort_unstable_by_key(|(seq, k)| (*seq, k.kind as u8, k.id));
    for (_, key) in candidates {
        if report.bytes_after <= target_bytes {
            break;
        }
        if let Some(v) = state.history.remove(&key) {
            report.bytes_after = report
                .bytes_after
                .saturating_sub(v.capacity() * std::mem::size_of::<blackbox_domain::state::EntryLoc>() + 32);
            state.cold_history.insert(key);
            report.history_records_dropped += 1;
        }
    }
    report.bytes_after = state.approx_bytes();
    report
}
