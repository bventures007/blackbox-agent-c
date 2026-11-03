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

/// Structural bytes of the history locators alone (the part evicted in history-only mode).
pub fn history_bytes(state: &TenantState) -> usize {
    state
        .history
        .values()
        .map(|v| v.capacity() * std::mem::size_of::<blackbox_domain::state::EntryLoc>() + 32)
        .sum()
}

/// True when a history-only pass would evict anything for this budget (same hysteresis as `evict`).
pub fn history_over_budget(state: &TenantState, target_bytes: usize) -> bool {
    let hysteresis = (target_bytes / 8).min(4 * 1024 * 1024);
    history_bytes(state) > target_bytes.saturating_add(hysteresis)
}

/// Evicts until the structural estimate is at or below `target_bytes` (best effort).
pub fn evict_to_budget(state: &mut TenantState, target_bytes: usize) -> EvictionReport {
    evict(state, target_bytes, false)
}

/// Eviction while a tenant is still catching up or rebuilding from the journal: history locators
/// only. Undo logs stay resident until every journal correction (`supersedes_entry_id`) behind the
/// committed cursor has been applied; dropping them earlier would either double count the corrected
/// effect (rebuild path) or schedule one full rebuild per correction (observed: 507 rebuilds in one
/// catch-up of the smoke corpus on 0.1.4).
pub fn evict_history_to_budget(state: &mut TenantState, target_bytes: usize) -> EvictionReport {
    evict(state, target_bytes, true)
}

/// `target_bytes` is the budget for the EVICTABLE part of the state (`TenantState::evictable_bytes`:
/// history locators + undo logs). The structural floor (records, entry metadata, interner) cannot be
/// reclaimed by eviction, so comparing the whole estimate against a per-tenant share evicted every
/// history locator of a large tenant as soon as its floor exceeded the share (observed on the smoke
/// corpus: every hot lookup became a PostgreSQL entity read). Process memory is bounded separately by
/// the measured-RSS target.
fn evict(state: &mut TenantState, target_bytes: usize, keep_undo: bool) -> EvictionReport {
    let evictable = state.evictable_bytes();
    // History-only mode (catching up / rebuilding): the retained undo logs are a deliberate floor of
    // that phase, so the budget applies to the history locators alone. Comparing history + undo with
    // the budget made the target unreachable for any large tenant and dropped every history locator
    // (observed on the smoke corpus: 29k records of the largest tenant and nearly all records of the
    // small tenants went cold during the initial catch-up and stayed cold through every snapshot).
    let in_scope = if keep_undo { history_bytes(state) } else { evictable };
    let floor = state.approx_bytes().saturating_sub(in_scope);
    let mut report = EvictionReport {
        bytes_before: state.approx_bytes(),
        ..Default::default()
    };
    report.bytes_after = report.bytes_before;
    // Hysteresis: an eviction pass walks every entry and sorts every history key; do not pay that for
    // an excess below 4 MiB (the publication loop would otherwise evict a few locators per batch).
    let hysteresis = (target_bytes / 8).min(4 * 1024 * 1024);
    if in_scope <= target_bytes.saturating_add(hysteresis) {
        return report;
    }
    let target_bytes = target_bytes.saturating_add(floor); // absolute estimate to reach
    // Step 1: drop undo logs of the oldest half of resident entries (keep recent corrections cheap).
    let mut seqs: Vec<i64> = if keep_undo { Vec::new() } else { state
        .entries
        .values()
        .filter(|m| !m.undo.is_empty())
        .map(|m| m.seq)
        .collect() };
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

#[cfg(test)]
mod tests {
    use super::*;
    use blackbox_domain::fixture::{connection_uuid, derived_entries, source_entry, GoldenScenario};
    use blackbox_domain::apply;

    fn golden_state() -> TenantState {
        let g = GoldenScenario::load_from_repo().unwrap();
        let tenant = uuid::Uuid::new_v4();
        let mut st = TenantState::new(tenant);
        let mut seq = 0;
        for ev in &g.events {
            seq += 1;
            let src = source_entry(tenant, seq, ev, connection_uuid(tenant, &ev.connection), chrono::Utc::now());
            apply(&mut st, &src);
            for d in derived_entries(&src, seq + 1) {
                seq += 1;
                apply(&mut st, &d);
            }
        }
        st
    }

    #[test]
    fn history_only_eviction_budgets_the_history_part_not_the_retained_undo_logs() {
        let st = golden_state();
        let hist = history_bytes(&st);
        let undo = st.evictable_bytes() - hist;
        assert!(hist > 0 && undo > 0, "fixture has history and undo logs");
        // Budget above the history bytes but below history + undo: nothing may be evicted while the
        // undo logs are deliberately retained (catch-up), even though the total exceeds the budget.
        let budget = hist + undo / 2;
        assert!(st.evictable_bytes() > budget);
        let mut a = st.clone();
        let r = evict_history_to_budget(&mut a, budget);
        assert_eq!(r.history_records_dropped, 0);
        assert_eq!(r.undo_logs_dropped, 0);
        assert!(a.cold_history.is_empty());
        assert!(!history_over_budget(&st, budget));
        // A budget below the history bytes (minus hysteresis) does evict locators, never undo logs.
        let mut b = st.clone();
        let r = evict_history_to_budget(&mut b, 0);
        assert!(r.history_records_dropped > 0);
        assert_eq!(r.undo_logs_dropped, 0);
        assert_eq!(b.cold_history.len(), r.history_records_dropped);
        assert!(history_over_budget(&st, 0));
        // Full mode drops undo logs of the oldest half first.
        let mut c = st.clone();
        let r = evict_to_budget(&mut c, 0);
        assert!(r.undo_logs_dropped > 0);
    }
}
