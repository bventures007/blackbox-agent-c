//! Journal tail apply loop per tenant: poll `journal_entries` after the applied cursor in
//! batches, apply through the reducers into the write copy, commit the checkpoint, publish
//! atomically (ArcSwap), then bring the second copy up to date (left-right double buffer).

use crate::evict::evict_to_budget;
use crate::snapshot::{self, SNAPSHOT_FORMAT_VERSION};
use crate::{Registry, TenantSlot, PHASE_CATCHING_UP, PHASE_LOADING, PHASE_READY, PHASE_REBUILDING};
use blackbox_domain::reducer::Outcome;
use blackbox_domain::{apply, Entry, TenantState, REDUCER_VERSION};
use blackbox_storage::Store;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tracing::{error, info, warn};
use uuid::Uuid;

/// Spawns tenant discovery, the LISTEN wake task and one apply loop per tenant.
pub async fn start(store: Store, registry: Arc<Registry>, shutdown: watch::Receiver<bool>) {
    let r = registry.clone();
    let s = store.clone();
    let sd = shutdown.clone();
    tokio::spawn(async move { discovery_loop(s, r, sd).await });
    let r = registry.clone();
    let s = store.clone();
    let sd = shutdown.clone();
    tokio::spawn(async move { listen_loop(s, r, sd).await });
}

async fn discovery_loop(store: Store, registry: Arc<Registry>, shutdown: watch::Receiver<bool>) {
    loop {
        if *shutdown.borrow() {
            return;
        }
        match store.tenants().await {
            Ok(rows) => {
                for t in rows {
                    let (slot, created) = registry.get_or_insert(t.tenant_id);
                    if created {
                        let s = store.clone();
                        let r = registry.clone();
                        let sd = shutdown.clone();
                        tokio::spawn(async move { tenant_loop(s, r, slot, sd).await });
                    }
                }
            }
            Err(e) => warn!(event_name = "engine.discovery_failed", error_code = "db", message = %e),
        }
        tokio::time::sleep(registry.config.tenant_discovery_interval).await;
    }
}

async fn listen_loop(store: Store, registry: Arc<Registry>, shutdown: watch::Receiver<bool>) {
    loop {
        if *shutdown.borrow() {
            return;
        }
        match store.listener().await {
            Ok(mut l) => loop {
                match l.recv().await {
                    Ok(n) => {
                        if let Some((tenant, seq)) = blackbox_storage::parse_wake_hint(n.payload()) {
                            let (slot, created) = registry.get_or_insert(tenant);
                            if created {
                                let s = store.clone();
                                let r = registry.clone();
                                let sd = shutdown.clone();
                                let sl = slot.clone();
                                tokio::spawn(async move { tenant_loop(s, r, sl, sd).await });
                            }
                            let prev = slot.committed.load(Ordering::Acquire);
                            if seq > prev {
                                slot.committed.store(seq, Ordering::Release);
                            }
                            slot.wake.notify_one();
                        }
                    }
                    Err(e) => {
                        warn!(event_name = "engine.listen_lost", error_code = "db", message = %e);
                        break;
                    }
                }
            },
            Err(e) => warn!(event_name = "engine.listen_failed", error_code = "db", message = %e),
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

struct Loaded {
    state: TenantState,
    from_snapshot: bool,
}

async fn load_initial(store: &Store, slot: &TenantSlot) -> Loaded {
    let tenant = slot.tenant_id;
    let checkpoint = match store.load_checkpoint(tenant).await {
        Ok(c) => c,
        Err(e) => {
            warn!(event_name = "engine.checkpoint_read_failed", tenant_id = %tenant, message = %e);
            None
        }
    };
    let checkpoint_ok = checkpoint
        .as_ref()
        .map(|c| c.reducer_version == REDUCER_VERSION as i32)
        .unwrap_or(false);
    if let Some(c) = &checkpoint {
        if !checkpoint_ok {
            info!(event_name = "engine.checkpoint_incompatible", tenant_id = %tenant, message = format!("checkpoint reducer_version {} != {}; rebuilding", c.reducer_version, REDUCER_VERSION));
        }
    }
    match store.load_snapshot(tenant, REDUCER_VERSION as i32).await {
        Ok(Some(row)) => {
            match snapshot::decode(
                tenant,
                row.format_version,
                row.reducer_version,
                row.applied_sequence,
                &row.checksum,
                &row.blob,
            ) {
                Ok(state) if checkpoint_ok => {
                    let cp = checkpoint.as_ref().map(|c| c.applied_sequence).unwrap_or(0);
                    if state.applied_sequence <= cp {
                        info!(event_name = "engine.snapshot_loaded", tenant_id = %tenant, applied_cursor = state.applied_sequence, committed_cursor = cp, message = "snapshot accepted");
                        return Loaded {
                            state,
                            from_snapshot: true,
                        };
                    }
                    warn!(event_name = "engine.snapshot_rejected", tenant_id = %tenant, message = format!("snapshot applied {} ahead of checkpoint {}; rebuilding", state.applied_sequence, cp));
                }
                Ok(_) => {
                    warn!(event_name = "engine.snapshot_rejected", tenant_id = %tenant, message = "snapshot without compatible checkpoint; rebuilding");
                }
                Err(e) => {
                    slot.snapshot_rejections.fetch_add(1, Ordering::Relaxed);
                    warn!(event_name = "engine.snapshot_rejected", tenant_id = %tenant, error_code = "snapshot_invalid", message = %e);
                }
            }
            if let Err(e) = store.delete_snapshot(tenant).await {
                warn!(event_name = "engine.snapshot_delete_failed", tenant_id = %tenant, message = %e);
            }
        }
        Ok(None) => {}
        Err(e) => warn!(event_name = "engine.snapshot_read_failed", tenant_id = %tenant, message = %e),
    }
    Loaded {
        state: TenantState::new(tenant),
        from_snapshot: false,
    }
}

/// Waits until no reader holds the retired copy, then returns it for mutation.
async fn reclaim(mut arc: Arc<TenantState>) -> Arc<TenantState> {
    let mut waited = 0u32;
    loop {
        if Arc::get_mut(&mut arc).is_some() {
            return arc;
        }
        waited += 1;
        if waited % 1000 == 0 {
            warn!(event_name = "engine.reclaim_slow", message = "retired state copy still referenced by readers");
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

fn apply_batch(state: &mut TenantState, batch: &[Entry]) -> (usize, bool) {
    let mut applied = 0usize;
    let mut needs_rebuild = false;
    for e in batch {
        if let Some(t) = e.supersedes_entry_id {
            if e.journal_sequence > 0 && !state.entries.contains_key(&t) && state.applied_sequence > 0 {
                needs_rebuild = true;
            }
            if let Some(meta) = state.entries.get(&t) {
                if meta.undo.is_empty() && meta.superseded_by.is_none() && meta.seq <= state.undo_evicted_through {
                    needs_rebuild = true;
                }
            }
        }
        match apply(state, e) {
            Outcome::AlreadyApplied => {}
            Outcome::AppliedSupersedesUnknown => {
                applied += 1;
                needs_rebuild = true;
            }
            _ => applied += 1,
        }
    }
    (applied, needs_rebuild)
}

pub async fn tenant_loop(
    store: Store,
    registry: Arc<Registry>,
    slot: Arc<TenantSlot>,
    shutdown: watch::Receiver<bool>,
) {
    let tenant = slot.tenant_id;
    let cfg = registry.config.clone();
    slot.phase.store(PHASE_LOADING, Ordering::Release);
    let loaded = load_initial(&store, &slot).await;
    slot.loaded_from_snapshot
        .store(loaded.from_snapshot, Ordering::Relaxed);
    let mut write: Arc<TenantState> = Arc::new(loaded.state);
    // Publish the snapshot state (cursor = its applied sequence, never ahead).
    let initial_applied = write.applied_sequence;
    slot.published.store(write.clone());
    slot.applied.store(initial_applied, Ordering::Release);
    slot.approx_bytes.store(write.approx_bytes(), Ordering::Relaxed);
    // `write` is now also the published copy; the private write copy is a clone of it.
    write = Arc::new((*write).clone());
    slot.phase.store(PHASE_CATCHING_UP, Ordering::Release);
    if let Ok(c) = store.committed_cursor(tenant).await {
        slot.committed.store(c, Ordering::Release);
    }
    let mut last_snapshot = Instant::now();
    let mut entries_since_snapshot: u64 = if loaded.from_snapshot { 0 } else { u64::MAX / 2 };
    let mut caught_up = false;

    loop {
        if *shutdown.borrow() {
            return;
        }
        if slot.rebuild_requested.swap(false, Ordering::AcqRel) {
            info!(event_name = "engine.rebuild_started", tenant_id = %tenant, message = "rebuilding tenant state from the journal");
            slot.phase.store(PHASE_REBUILDING, Ordering::Release);
            let _ = store.delete_snapshot(tenant).await;
            let _ = store.delete_checkpoint(tenant).await;
            registry.cold.invalidate_tenant(tenant);
            let fresh = Arc::new(TenantState::new(tenant));
            // Keep serving the old published state (labelled rebuilding) until the rebuild
            // reaches the previously applied cursor; cursors never move backwards for readers.
            let target = slot.applied.load(Ordering::Acquire);
            let mut rebuilt = reclaim(fresh).await;
            let mut after = 0i64;
            loop {
                let batch = match store.read_tail(tenant, after, cfg.batch_size).await {
                    Ok(b) => b,
                    Err(e) => {
                        error!(event_name = "engine.rebuild_failed", tenant_id = %tenant, message = %e);
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        continue;
                    }
                };
                if batch.is_empty() {
                    break;
                }
                let st = Arc::get_mut(&mut rebuilt).expect("unique");
                apply_batch(st, &batch);
                after = batch.last().unwrap().journal_sequence;
                if after >= target {
                    break;
                }
            }
            let st = Arc::get_mut(&mut rebuilt).expect("unique");
            let budget = registry.tenant_budget();
            if st.approx_bytes() > budget {
                evict_to_budget(st, budget);
            }
            if let Err(e) = store
                .save_checkpoint(tenant, st.applied_sequence, REDUCER_VERSION as i32, &st.state_hash_hex())
                .await
            {
                error!(event_name = "engine.checkpoint_failed", tenant_id = %tenant, message = %e);
            }
            let applied_now = st.applied_sequence;
            let old = slot.published.swap(rebuilt.clone());
            slot.applied.store(applied_now, Ordering::Release);
            slot.applied_notify.notify_waiters();
            drop(reclaim(old).await);
            write = Arc::new((*rebuilt).clone());
            entries_since_snapshot = u64::MAX / 2;
            slot.phase.store(PHASE_READY, Ordering::Release);
            info!(event_name = "engine.rebuild_finished", tenant_id = %tenant, applied_cursor = applied_now, message = "rebuild complete");
            continue;
        }

        let applied = slot.applied.load(Ordering::Acquire);
        let batch = match store.read_tail(tenant, applied, cfg.batch_size).await {
            Ok(b) => b,
            Err(e) => {
                *slot.last_error.lock().unwrap() = Some(e.to_string());
                warn!(event_name = "engine.tail_read_failed", tenant_id = %tenant, error_code = "db", retryable = true, message = %e);
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        if batch.is_empty() {
            if !caught_up {
                caught_up = true;
                slot.phase.store(PHASE_READY, Ordering::Release);
                info!(event_name = "engine.tenant_ready", tenant_id = %tenant, applied_cursor = applied, message = "tenant caught up");
            }
            // Refresh committed cursor occasionally and maybe snapshot while idle.
            if let Ok(c) = store.committed_cursor(tenant).await {
                let prev = slot.committed.load(Ordering::Acquire);
                if c > prev {
                    slot.committed.store(c, Ordering::Release);
                    continue; // new entries committed since the read
                }
            }
            if entries_since_snapshot >= cfg.snapshot_min_entries
                && last_snapshot.elapsed() >= cfg.snapshot_interval
            {
                let published = slot.published.load_full();
                write_snapshot(&store, &slot, published).await;
                last_snapshot = Instant::now();
                entries_since_snapshot = 0;
            }
            let _ = tokio::time::timeout(cfg.poll_interval, slot.wake.notified()).await;
            continue;
        }

        let started = Instant::now();
        let st = Arc::get_mut(&mut write).expect("write copy is unique");
        let (applied_n, needs_rebuild) = apply_batch(st, &batch);
        let budget = registry.tenant_budget();
        slot.budget_bytes.store(budget, Ordering::Relaxed);
        let mut evicted = false;
        if st.approx_bytes() > budget {
            let r = evict_to_budget(st, budget);
            evicted = true;
            slot.evictions.fetch_add(1, Ordering::Relaxed);
            info!(event_name = "engine.evicted", tenant_id = %tenant, record_count = r.history_records_dropped as i64, message = format!("evicted {} undo logs and {} history locators ({} -> {} bytes)", r.undo_logs_dropped, r.history_records_dropped, r.bytes_before, r.bytes_after));
        }
        let new_applied = st.applied_sequence;
        let hash = st.state_hash_hex();
        // Durable checkpoint first, then publication.
        if let Err(e) = store
            .save_checkpoint(tenant, new_applied, REDUCER_VERSION as i32, &hash)
            .await
        {
            error!(event_name = "engine.checkpoint_failed", tenant_id = %tenant, error_code = "db", retryable = true, message = %e);
            // Do not publish; bring the write copy back in line with the published copy.
            let published = slot.published.load_full();
            write = Arc::new((*published).clone());
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }
        let bytes = st.approx_bytes();
        let old = slot.published.swap(write.clone());
        slot.applied.store(new_applied, Ordering::Release);
        slot.approx_bytes.store(bytes, Ordering::Relaxed);
        slot.batches_applied.fetch_add(1, Ordering::Relaxed);
        slot.entries_applied.fetch_add(batch.len() as u64, Ordering::Relaxed);
        *slot.last_publication.lock().unwrap() = Some(Instant::now());
        slot.applied_notify.notify_waiters();
        if let Ok(c) = store.committed_cursor(tenant).await {
            let prev = slot.committed.load(Ordering::Acquire);
            if c > prev {
                slot.committed.store(c, Ordering::Release);
            }
        }
        let committed = slot.committed.load(Ordering::Acquire).max(new_applied);
        info!(
            event_name = "engine.batch_applied",
            tenant_id = %tenant,
            committed_cursor = committed,
            applied_cursor = new_applied,
            record_count = batch.len() as i64,
            duration_ms = started.elapsed().as_millis() as i64,
            message = format!("applied {} entries ({} with effect)", batch.len(), applied_n)
        );
        entries_since_snapshot = entries_since_snapshot.saturating_add(batch.len() as u64);
        // Now `write` is published; reclaim the retired copy and replay the same batch.
        let mut retired = reclaim(old).await;
        {
            let st2 = Arc::get_mut(&mut retired).expect("unique after reclaim");
            if evicted || st2.applied_sequence + (batch.len() as i64) < new_applied {
                // Eviction decisions or a gap: resync by cloning the published copy.
                *st2 = (*write).clone();
            } else {
                apply_batch(st2, &batch);
                if st2.state_hash != write.state_hash {
                    warn!(event_name = "engine.copy_divergence", tenant_id = %tenant, message = "write copies diverged; resyncing from published copy");
                    *st2 = (*write).clone();
                }
            }
        }
        write = retired;
        if needs_rebuild {
            warn!(event_name = "engine.rebuild_requested", tenant_id = %tenant, message = "correction of a non-resident entry; scheduling rebuild");
            slot.rebuild_requested.store(true, Ordering::Release);
        }
        if entries_since_snapshot >= cfg.snapshot_min_entries
            && last_snapshot.elapsed() >= cfg.snapshot_interval
        {
            let published = slot.published.load_full();
            write_snapshot(&store, &slot, published).await;
            last_snapshot = Instant::now();
            entries_since_snapshot = 0;
        }
    }
}

/// Serializes the published copy off the async runtime and persists it.
pub async fn write_snapshot(store: &Store, slot: &TenantSlot, state: Arc<TenantState>) {
    let tenant = slot.tenant_id;
    let encoded = match tokio::task::spawn_blocking(move || snapshot::encode(&state)).await {
        Ok(Ok(e)) => e,
        Ok(Err(e)) => {
            warn!(event_name = "engine.snapshot_encode_failed", tenant_id = %tenant, message = %e);
            return;
        }
        Err(e) => {
            warn!(event_name = "engine.snapshot_encode_failed", tenant_id = %tenant, message = %e);
            return;
        }
    };
    match store
        .save_snapshot(
            tenant,
            REDUCER_VERSION as i32,
            SNAPSHOT_FORMAT_VERSION,
            encoded.applied_sequence,
            &encoded.checksum,
            &encoded.blob,
        )
        .await
    {
        Ok(()) => {
            slot.snapshots_written.fetch_add(1, Ordering::Relaxed);
            info!(event_name = "engine.snapshot_written", tenant_id = %tenant, applied_cursor = encoded.applied_sequence, record_count = encoded.blob.len() as i64, message = "snapshot persisted");
        }
        Err(e) => warn!(event_name = "engine.snapshot_write_failed", tenant_id = %tenant, message = %e),
    }
}

/// Forces a snapshot of every ready tenant (admin/testing hook).
pub async fn snapshot_all(store: &Store, registry: &Registry) {
    for slot in registry.all() {
        if slot.phase() == PHASE_READY {
            let st = slot.published.load_full();
            write_snapshot(store, &slot, st).await;
        }
    }
}

/// Replays an entity's entries from PostgreSQL through the same reducers into a scratch state
/// (cold hydration and `as_of`). Bounded by `max_entries`.
pub async fn replay_entity(
    store: &Store,
    tenant: Uuid,
    entity_type: &str,
    entity_id: &str,
    upto_sequence: i64,
    recorded_cutoff: Option<chrono::DateTime<chrono::Utc>>,
    effective_cutoff: Option<chrono::DateTime<chrono::Utc>>,
    max_entries: i64,
) -> Result<(TenantState, i64), blackbox_storage::StorageError> {
    let mut st = TenantState::new(tenant);
    let mut after = 0i64;
    let mut total = 0i64;
    loop {
        let batch = store
            .entity_entries(tenant, entity_type, entity_id, after, upto_sequence, recorded_cutoff, 1000)
            .await?;
        if batch.is_empty() {
            break;
        }
        for e in &batch {
            if let Some(eff) = effective_cutoff {
                if e.occurred_at > eff {
                    continue;
                }
            }
            apply(&mut st, e);
        }
        after = batch.last().unwrap().journal_sequence;
        total += batch.len() as i64;
        if total >= max_entries {
            break;
        }
    }
    Ok((st, total))
}

/// Replays the whole tenant up to a recorded cutoff (tenant-wide as_of intents). Bounded.
pub async fn replay_tenant(
    store: &Store,
    tenant: Uuid,
    recorded_cutoff: chrono::DateTime<chrono::Utc>,
    effective_cutoff: Option<chrono::DateTime<chrono::Utc>>,
    max_entries: i64,
) -> Result<(TenantState, i64, bool), blackbox_storage::StorageError> {
    let mut st = TenantState::new(tenant);
    let mut after = 0i64;
    let mut total = 0i64;
    let mut truncated = false;
    loop {
        let batch = store
            .tenant_entries_until(tenant, recorded_cutoff, after, 1000)
            .await?;
        if batch.is_empty() {
            break;
        }
        for e in &batch {
            if let Some(eff) = effective_cutoff {
                if e.occurred_at > eff {
                    continue;
                }
            }
            apply(&mut st, e);
        }
        after = batch.last().unwrap().journal_sequence;
        total += batch.len() as i64;
        if total >= max_entries {
            truncated = true;
            break;
        }
    }
    Ok((st, total, truncated))
}
