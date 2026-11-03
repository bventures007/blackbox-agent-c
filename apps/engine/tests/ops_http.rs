//! Operational behaviour: snapshot restart, corrupt snapshot rebuild, projection_behind,
//! admission limits, 1000-entry unapplied tail, eviction/cold reads, concurrent ingestion and a
//! small hot-state load sample (numbers printed and written to target/engine-load-sample.json).

use anyhow::Result;
use blackbox_domain::fixture::{mutate, GoldenScenario, ScenarioParams};
use blackbox_engine_tests::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn golden() -> GoldenScenario {
    GoldenScenario::load_from_repo().unwrap()
}

/// Appends `n` mutated golden scenarios (19 observations each) to a tenant.
async fn seed_orders(db: &TestDb, tenant: uuid::Uuid, n: usize, derived: bool, batch: usize) -> Result<(i64, Vec<String>)> {
    let g = golden();
    let mut app = Appender::new(db, tenant, derived).await?;
    let mut events = Vec::new();
    let mut orders = Vec::new();
    for i in 0..n {
        let p = ScenarioParams {
            quantity: 1 + (i as i64 % 9),
            unit_gross_minor: 500 + (i as i64 * 37) % 5000,
            fee_minor: 10 + (i as i64 % 50),
            return_quantity: (i as i64 % 2),
            physical_stock: 100 + i as i64,
            currency: "EUR".into(),
            suffix: format!("-o{i}"),
        };
        orders.push(format!("#1001-o{i}"));
        events.extend(mutate(&g, &p));
    }
    let last = app.observe_many(&events, batch).await?;
    Ok((last, orders))
}

#[tokio::test]
async fn restart_with_snapshot_then_corrupt_snapshot_rebuild() -> Result<()> {
    let db = TestDb::create("restart").await?;
    let t = db.create_tenant("restart").await?;
    let (last, orders) = seed_orders(&db, t, 20, true, 10).await?;
    let port = free_port();
    let mut engine = Engine::spawn_on(&db, port, &[]).await?;
    engine.wait_applied(t, last, Duration::from_secs(30)).await?;
    let before = engine.order_state(t, &orders[3]).await?;
    let (st, _) = engine.post("/v1/admin/snapshot", json!({"tenant_id": t})).await?;
    assert_eq!(st, 200);
    assert_eq!(db.snapshot_count(t).await?, 1);
    let (cp_seq, cp_hash) = db.checkpoint(t).await?.expect("checkpoint persisted");
    assert_eq!(cp_seq, last);
    engine.kill();

    // Restart: loads the snapshot, state identical, ready quickly.
    let start = Instant::now();
    let mut engine = Engine::spawn_on(&db, port, &[]).await?;
    let ready = engine.wait_applied(t, last, Duration::from_secs(30)).await?;
    let h = engine.health().await?;
    assert_eq!(h["tenants"][t.to_string()]["loaded_from_snapshot"], true, "{h}");
    let after = engine.order_state(t, &orders[3]).await?;
    assert_eq!(after["state"], before["state"]);
    assert_eq!(after["tracks"], before["tracks"]);
    assert_eq!(db.checkpoint(t).await?.unwrap().1, cp_hash, "chain hash unchanged across restart");
    println!("snapshot restart ready in {:?} (spawn+health {:?})", ready, start.elapsed());
    engine.kill();

    // Corrupt the snapshot: it must be rejected and the tenant rebuilt from the journal.
    db.corrupt_snapshot(t).await?;
    let mut engine = Engine::spawn_on(&db, port, &[]).await?;
    engine.wait_applied(t, last, Duration::from_secs(60)).await?;
    let h = engine.health().await?;
    assert_eq!(h["tenants"][t.to_string()]["loaded_from_snapshot"], false, "{h}");
    assert_eq!(h["tenants"][t.to_string()]["snapshot_rejections"], 1);
    assert!(engine.log().contains("engine.snapshot_rejected"));
    let rebuilt = engine.order_state(t, &orders[3]).await?;
    assert_eq!(rebuilt["state"], before["state"]);
    assert_eq!(rebuilt["tracks"], before["tracks"]);
    assert_eq!(db.checkpoint(t).await?.unwrap().1, cp_hash, "rebuild reproduces the identical chain hash");
    // Admin rebuild while serving: identical again.
    let (st, _) = engine.post("/v1/admin/rebuild", json!({"tenant_id": t})).await?;
    assert_eq!(st, 200);
    tokio::time::sleep(Duration::from_millis(300)).await;
    engine.wait_applied(t, last, Duration::from_secs(60)).await?;
    let again = engine.order_state(t, &orders[3]).await?;
    assert_eq!(again["state"], before["state"]);
    engine.kill();
    Ok(())
}

#[tokio::test]
async fn projection_behind_and_admission_limits() -> Result<()> {
    let db = TestDb::create("behind").await?;
    let t = db.create_tenant("behind").await?;
    let (last, orders) = seed_orders(&db, t, 3, false, 10).await?;
    let order0: &str = &orders[0];
    let engine = Engine::spawn(&db, &[]).await?;
    engine.wait_applied(t, last, Duration::from_secs(20)).await?;

    // at_least_cursor beyond what exists: explicit projection_behind with cursors, never a stale answer.
    let (st, e) = engine.state(t, "order", &orders[0], json!({"mode": "at_least_cursor", "cursor": last + 1000, "deadline_ms": 300})).await?;
    assert_eq!(st, 503, "{e}");
    assert_eq!(e["error"]["code"], "projection_behind");
    assert_eq!(e["error"]["retryable"], true);
    assert_eq!(e["error"]["applied_cursor"], last);
    assert_eq!(e["error"]["required_cursor"], last + 1000);

    // Natural lag: pause the engine, append, latest_committed must not serve the old state.
    engine.pause();
    let mut app = Appender::new(&db, t, false).await?;
    let g = golden();
    let p = ScenarioParams { suffix: "-late".into(), ..ScenarioParams::golden() };
    let newer = app.observe_many(&mutate(&g, &p), 10).await?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build()?;
    let probe = client.post(format!("{}/v1/state", engine.base_url)).header("X-Engine-Token", ENGINE_TOKEN)
        .json(&json!({"tenant_id": t, "entity_type": "order", "entity_id": orders[0], "consistency": {"mode": "latest_committed", "deadline_ms": 400}}))
        .send();
    // While paused the process cannot answer at all; resume after the deadline would have passed.
    let (resp, _) = tokio::join!(probe, async { tokio::time::sleep(Duration::from_millis(600)).await; engine.resume(); });
    let resp = resp?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    // Either the deadline/behind error (engine resumed after the deadline) or a current answer
    // that already includes the newer cursor; a stale "current" answer is never acceptable.
    if status == 200 {
        assert!(body["consistency"]["applied_cursor"].as_i64().unwrap() >= newer, "{body}");
    } else {
        assert!(body["error"]["code"] == "projection_behind" || body["error"]["code"] == "deadline_exceeded", "{body}");
    }
    engine.wait_applied(t, newer, Duration::from_secs(20)).await?;
    let (st, v) = engine.state(t, "order", "#1001-late", json!({"mode": "latest_committed"})).await?;
    assert_eq!(st, 200);
    assert_eq!(v["state"]["bank_confirmed_minor"], 9170);
    // stale_explicit is labelled.
    let (st, v) = engine.state(t, "order", "#1001-late", json!({"mode": "stale_explicit"})).await?;
    assert_eq!(st, 200);
    assert_eq!(v["consistency"]["status"], "stale");

    // Admission: 8 concurrent waits per agent; the 9th is rejected with overloaded.
    let mut waiters = Vec::new();
    for _ in 0..8 {
        let e = &engine;
        waiters.push(async move {
            e.post_as("/v1/state", json!({"tenant_id": t, "entity_type": "order", "entity_id": order0, "consistency": {"mode": "at_least_cursor", "cursor": 1_000_000, "deadline_ms": 1500}}), Some("agent-1")).await
        });
    }
    let all = futures_join(waiters);
    let (results, ninth) = tokio::join!(all, async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        engine.post_as("/v1/state", json!({"tenant_id": t, "entity_type": "order", "entity_id": order0, "consistency": {"mode": "latest_committed"}}), Some("agent-1")).await
    });
    for r in results {
        let (st, e) = r?;
        assert_eq!(st, 503);
        assert_eq!(e["error"]["code"], "projection_behind");
    }
    let (st, e) = ninth?;
    assert_eq!(st, 429, "{e}");
    assert_eq!(e["error"]["code"], "overloaded");
    assert_eq!(e["error"]["retryable"], true);
    assert!(e["error"]["retry_after_ms"].as_u64().unwrap() > 0);
    // Another agent is not starved by the flooding principal.
    let waiters2: Vec<_> = (0..8).map(|_| {
        let e = &engine;
        async move { e.post_as("/v1/state", json!({"tenant_id": t, "entity_type": "order", "entity_id": order0, "consistency": {"mode": "at_least_cursor", "cursor": 1_000_000, "deadline_ms": 1500}}), Some("agent-1")).await }
    }).collect();
    let (_, other) = tokio::join!(futures_join(waiters2), async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        engine.post_as("/v1/state", json!({"tenant_id": t, "entity_type": "order", "entity_id": order0, "consistency": {"mode": "latest_committed"}}), Some("agent-2")).await
    });
    let (st, v) = other?;
    assert_eq!(st, 200, "{v}");
    let h = engine.health().await?;
    assert!(h["admission"]["rejected"].as_u64().unwrap() >= 1);
    // Deadline validation and body limits.
    let (st, e) = engine.state(t, "order", &orders[0], json!({"mode": "latest_committed", "deadline_ms": 9000})).await?;
    assert_eq!(st, 400, "{e}");
    Ok(())
}

async fn futures_join<F: std::future::Future>(futs: Vec<F>) -> Vec<F::Output> {
    let mut out = Vec::new();
    let mut handles = Vec::new();
    for f in futs {
        handles.push(Box::pin(f));
    }
    // Poll all concurrently through a simple join of pinned futures.
    let mut pending: Vec<Option<std::pin::Pin<Box<F>>>> = handles.into_iter().map(Some).collect();
    let mut results: Vec<Option<F::Output>> = (0..pending.len()).map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut all_done = true;
        for (i, slot) in pending.iter_mut().enumerate() {
            if let Some(f) = slot {
                match f.as_mut().poll(cx) {
                    std::task::Poll::Ready(v) => {
                        results[i] = Some(v);
                        *slot = None;
                    }
                    std::task::Poll::Pending => all_done = false,
                }
            }
        }
        if all_done {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
    for r in results {
        out.push(r.unwrap());
    }
    out
}

#[tokio::test]
async fn unapplied_tail_of_1000_entries_applies_within_30s_with_concurrent_ingestion() -> Result<()> {
    let db = TestDb::create("tail").await?;
    let t = db.create_tenant("tail").await?;
    // Seed while no engine runs: >= 1000 entries unapplied at start.
    let (last, orders) = seed_orders(&db, t, 20, true, 20).await?;
    assert!(last >= 1000, "seeded {last} entries");
    let start = Instant::now();
    let engine = Engine::spawn(&db, &[]).await?;
    // Concurrent ingestion while catching up.
    let db2 = TestDb { name: db.name.clone(), admin: db.admin.clone(), api: db.api.clone() };
    let ingest = tokio::spawn(async move {
        let g = golden();
        let mut app = Appender::new(&db2, t, true).await.unwrap();
        let p = ScenarioParams { suffix: "-during".into(), ..ScenarioParams::golden() };
        app.observe_many(&mutate(&g, &p), 5).await.unwrap()
    });
    let elapsed = engine.wait_applied(t, last, Duration::from_secs(30)).await?;
    println!("tail of {last} entries applied in {:?} (from spawn {:?})", elapsed, start.elapsed());
    let newest = ingest.await?;
    engine.wait_applied(t, newest, Duration::from_secs(30)).await?;
    let v = engine.order_state(t, "#1001-during").await?;
    assert_eq!(v["state"]["bank_confirmed_minor"], 9170);
    let v = engine.order_state(t, &orders[19]).await?;
    assert_eq!(v["status"], "complete");
    let h = engine.health().await?;
    assert_eq!(h["tenants"][t.to_string()]["lag_entries"], 0);
    assert!(engine.log().contains("\"event_name\":\"engine.batch_applied\""));
    assert!(engine.log().contains("\"committed_cursor\""));
    Ok(())
}

#[tokio::test]
async fn eviction_under_tiny_budget_keeps_answers_correct_with_cold_reads() -> Result<()> {
    let db = TestDb::create("evict").await?;
    let t = db.create_tenant("evict").await?;
    let (last, orders) = seed_orders(&db, t, 40, true, 20).await?;
    // Phase A — 1 MiB hot budget, no memory pressure: the tail-exhausted publication evicts undo logs of
    // the oldest half first; the history locators stay resident (ADR-0009), so every track view is RAM-served.
    let mut engine = Engine::spawn(&db, &[("ENGINE_HOT_BUDGET_MB", "1"), ("ENGINE_COLD_CACHE_MB", "4")]).await?;
    engine.wait_applied(t, last, Duration::from_secs(60)).await?;
    let h = engine.health().await?;
    assert!(h["tenants"][t.to_string()]["evictions"].as_u64().unwrap() >= 1, "{h}");
    assert!(engine.log().contains("engine.evicted"));
    let check = |v: &Value, o: &str| {
        assert_eq!(v["state"]["open_receivable_minor"], 0, "{o}");
        assert_eq!(v["state"]["in_transit_minor"], 0, "{o}");
        let n = |k: &str| v["state"][k].as_i64().unwrap();
        assert_eq!(n("captured_minor") - n("fees_minor") - n("refunded_minor"), n("bank_confirmed_minor"));
    };
    let mut resident = Vec::new();
    for o in &orders {
        let v = engine.order_state(t, o).await?;
        check(&v, o);
        assert_ne!(v["tracks"]["source"]["source"], "postgresql", "history resident without memory pressure: {o}");
        assert_eq!(v["tracks"]["source"]["total"], 19);
        resident.push(v["tracks"].clone());
    }
    let h = engine.health().await?;
    assert_eq!(h["memory"]["summary_cache_entries"], 0, "{h}");
    engine.kill();

    // Phase B — the same journal rebuilt under forced memory pressure (RSS target 1 MiB, tenant budget 1 MiB):
    // history locators are evicted; answers stay correct and the track views come from the payload-free
    // indexed read, cached per exact applied cursor (second lookup of the same order is a cache hit).
    let engine = Engine::spawn(&db, &[("ENGINE_HOT_BUDGET_MB", "1"), ("ENGINE_TENANT_BUDGET_MB", "1"), ("ENGINE_RSS_TARGET_MB", "1"), ("ENGINE_COLD_CACHE_MB", "4")]).await?;
    engine.wait_applied(t, last, Duration::from_secs(60)).await?;
    let mut cold_reads = 0;
    for (i, o) in orders.iter().enumerate() {
        let v = engine.order_state(t, o).await?;
        check(&v, o);
        if v["tracks"]["source"]["source"] == "postgresql" {
            cold_reads += 1;
            assert_eq!(v["tracks"]["source"]["total"], 19);
            // Same entries, same order, same ids as the resident view (summaries only differ in the effect label).
            let ids = |tr: &Value| tr["source"]["entries"].as_array().unwrap().iter().map(|e| e["entry_id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
            assert_eq!(ids(&v["tracks"]), ids(&resident[i]), "{o}");
            let again = engine.order_state(t, o).await?;
            assert_eq!(again["tracks"], v["tracks"]);
        }
    }
    assert!(cold_reads > 0, "some histories were served from the indexed cold path");
    let h = engine.health().await?;
    assert!(h["memory"]["summary_cache_entries"].as_u64().unwrap() >= 1, "{h}");
    assert!(h["memory"]["summary_cache_hits"].as_u64().unwrap() >= 1, "{h}");
    assert!(h["memory"]["summary_cache_bytes"].as_u64().unwrap() <= h["memory"]["summary_cache_budget_bytes"].as_u64().unwrap());
    // as_of still works (replay through the cold LRU).
    let (st, v) = engine.state(t, "order", &orders[0], json!({"mode": "as_of", "as_of_recorded": chrono::Utc::now().to_rfc3339()})).await?;
    assert_eq!(st, 200, "{v}");
    assert_eq!(v["consistency"]["status"], "historical");
    let h = engine.health().await?;
    assert!(h["memory"]["cold_cache_entries"].as_u64().unwrap() >= 1);
    Ok(())
}

#[tokio::test]
async fn load_sample_hot_state_p95() -> Result<()> {
    // Legitimate load is spread across workspaces/principals (per-workspace limit 16): two
    // tenants with eight clients each. Run this test alone (--test-threads=1) for clean numbers.
    let db = TestDb::create("load").await?;
    let t1 = db.create_tenant("load-1").await?;
    let t2 = db.create_tenant("load-2").await?;
    let (last1, orders1) = seed_orders(&db, t1, 120, true, 25).await?;
    let (last2, orders2) = seed_orders(&db, t2, 80, true, 25).await?;
    let engine = Engine::spawn(&db, &[]).await?;
    engine.wait_applied(t1, last1, Duration::from_secs(120)).await?;
    engine.wait_applied(t2, last2, Duration::from_secs(120)).await?;
    let clients = 16usize;
    let per_client = 75usize;
    let start = Instant::now();
    let mut tasks = Vec::new();
    for c in 0..clients {
        let base = engine.base_url.clone();
        let (tenant, orders) = if c % 2 == 0 { (t1, orders1.clone()) } else { (t2, orders2.clone()) };
        tasks.push(tokio::spawn(async move {
            let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap();
            let mut lat = Vec::new();
            let mut errors: Vec<String> = Vec::new();
            for i in 0..per_client {
                let o = &orders[(c * 7 + i * 13) % orders.len()];
                let t0 = Instant::now();
                let r = client.post(format!("{base}/v1/state")).header("X-Engine-Token", ENGINE_TOKEN).header("X-Principal-Id", format!("client-{c}"))
                    .json(&json!({"tenant_id": tenant, "entity_type": "order", "entity_id": o, "consistency": {"mode": "latest_committed"}})).send().await;
                match r {
                    Ok(resp) if resp.status().is_success() => {
                        let v: Value = resp.json().await.unwrap();
                        assert_eq!(v["consistency"]["status"], "current");
                        lat.push(t0.elapsed().as_secs_f64() * 1000.0);
                    }
                    Ok(resp) => {
                        let code = resp.status().as_u16();
                        let v: Value = resp.json().await.unwrap_or(Value::Null);
                        errors.push(format!("{code}:{}", v["error"]["code"]));
                    }
                    Err(e) => errors.push(format!("transport:{e}")),
                }
            }
            (lat, errors)
        }));
    }
    let mut all = Vec::new();
    let mut errors = Vec::new();
    for task in tasks {
        let (l, e) = task.await?;
        all.extend(l);
        errors.extend(e);
    }
    let wall = start.elapsed();
    all.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = percentile(&all, 0.50);
    let p95 = percentile(&all, 0.95);
    let p99 = percentile(&all, 0.99);
    let h = engine.health().await?;
    let binary = engine_binary().display().to_string();
    let sample = json!({
        "class": "hot_current_state_engine_rpc",
        "note": "engine RPC only (no API/MCP layer, no auth/session layer); latest_committed consistency (tenant_sequences point read + barrier per request); 16 concurrent clients over 2 workspaces; orders seeded through append_journal_entries; local macOS host, PostgreSQL 16 in Docker Desktop",
        "engine_binary": binary,
        "orders": orders1.len() + orders2.len(), "entries": last1 + last2, "clients": clients, "requests": all.len() + errors.len(), "errors": errors.len(), "error_samples": errors.iter().take(5).collect::<Vec<_>>(),
        "p50_ms": p50, "p95_ms": p95, "p99_ms": p99, "wall_seconds": wall.as_secs_f64(), "throughput_rps": (all.len() as f64) / wall.as_secs_f64(),
        "rss_bytes": h["rss_bytes"], "approx_resident_bytes": h["memory"]["approx_resident_bytes"],
    });
    println!("LOAD_SAMPLE {sample}");
    let path = repo_root().join("target/engine-load-sample.json");
    std::fs::write(&path, serde_json::to_string_pretty(&sample)?)?;
    assert!(errors.is_empty(), "{errors:?}");
    // The 200 ms smoke target is enforced for an optimized binary (ENGINE_BINARY=target/release/
    // blackbox-engine); a debug build only reports its numbers.
    if binary.contains("/release/") {
        assert!(p95 < 200.0, "hot state p95 {p95} ms exceeds the 200 ms smoke target (engine RPC only)");
    } else {
        eprintln!("debug build: p95 {p95} ms reported, not enforced");
    }
    Ok(())
}
