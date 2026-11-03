//! ADR-0008: entity reads must be able to use the GIN index on `entity_refs` under row-level security.
//! PostgreSQL pushes an operator into an index condition below the RLS barrier only when its function is
//! LEAKPROOF; `0000_roles.sql` marks `jsonb_contains` accordingly. Measured without it (PILOT-09, 552k-entry
//! corpus): the API history query scanned the whole tenant journal (276k rows per request) as `bb_api`.

use anyhow::Result;
use blackbox_domain::fixture::{mutate, GoldenScenario, ScenarioParams};
use blackbox_engine_tests::*;
use serde_json::json;
use sqlx::Row;

/// Seeds enough entries (120 mutated golden scenarios, ~9k entries) that the ordered tenant/sequence btree walk is
/// clearly more expensive than the GIN lookup, then refreshes the statistics; on a near-empty table the planner
/// would prefer the btree walk regardless of the leakproof flag.
async fn seed(db: &TestDb, tenant: uuid::Uuid) -> Result<(i64, String)> {
    let g = GoldenScenario::load_from_repo().unwrap();
    let mut app = Appender::new(db, tenant, true).await?;
    let mut events = Vec::new();
    for i in 0..120 {
        let p = ScenarioParams {
            quantity: 1 + i,
            unit_gross_minor: 500 + i * 37,
            fee_minor: 10 + i,
            return_quantity: 0,
            physical_stock: 100,
            currency: "EUR".into(),
            suffix: format!("-g{i}"),
        };
        events.extend(mutate(&g, &p));
    }
    let last = app.observe_many(&events, 20).await?;
    sqlx::query("ANALYZE journal_entries").execute(&db.admin).await?;
    Ok((last, "#1001-g1".to_string()))
}

/// Plan of the API entity-history query (packages/application/src/journal.ts entityHistory) as bb_api with the
/// tenant context set; `enable_seqscan` is switched off so the only question is whether the GIN index is permitted.
async fn api_history_plan(db: &TestDb, tenant: uuid::Uuid, last: i64, order: &str) -> Result<String> {
    let mut tx = db.api.begin().await?;
    sqlx::query("SELECT set_config('app.tenant_id', $1, true)").bind(tenant.to_string()).execute(&mut *tx).await?;
    sqlx::query("SET LOCAL enable_seqscan = off").execute(&mut *tx).await?;
    let rows = sqlx::query(
        "EXPLAIN (FORMAT TEXT) SELECT * FROM journal_entries WHERE journal_sequence > $1 AND journal_sequence <= $2 AND (entity_refs @> $3::jsonb OR record_id = $4) ORDER BY journal_sequence ASC LIMIT $5",
    )
    .bind(0i64)
    .bind(last)
    .bind(json!({ "order": order }))
    .bind(format!("order:{order}"))
    .bind(101i64)
    .fetch_all(&mut *tx)
    .await?;
    tx.rollback().await?;
    Ok(rows.iter().map(|r| r.get::<String, _>(0)).collect::<Vec<_>>().join("\n"))
}

/// Plan of the engine's entity read (crates/storage entity_entries) as bb_engine.
async fn engine_entity_plan(db: &TestDb, tenant: uuid::Uuid, last: i64, order: &str) -> Result<String> {
    let mut tx = db.admin.begin().await?;
    sqlx::query("SET LOCAL ROLE bb_engine").execute(&mut *tx).await?;
    sqlx::query("SET LOCAL enable_seqscan = off").execute(&mut *tx).await?;
    let rows = sqlx::query(
        "EXPLAIN (FORMAT TEXT) SELECT entry_id FROM journal_entries WHERE tenant_id = $1 AND entity_refs @> $2::jsonb AND journal_sequence > $3 AND journal_sequence <= $4 ORDER BY journal_sequence LIMIT $5",
    )
    .bind(tenant)
    .bind(json!({ "order": order }))
    .bind(0i64)
    .bind(last)
    .bind(500i64)
    .fetch_all(&mut *tx)
    .await?;
    tx.rollback().await?;
    Ok(rows.iter().map(|r| r.get::<String, _>(0)).collect::<Vec<_>>().join("\n"))
}

#[tokio::test]
async fn entity_reads_use_the_gin_index_under_rls() -> Result<()> {
    let db = TestDb::create("rlsgin").await?;
    let t = db.create_tenant("rls gin").await?;
    let (last, order) = seed(&db, t).await?;

    let leakproof: bool = sqlx::query_scalar("SELECT proleakproof FROM pg_proc WHERE proname = 'jsonb_contains' AND pronamespace = 'pg_catalog'::regnamespace")
        .fetch_one(&db.admin)
        .await?;
    assert!(leakproof, "0000_roles.sql must mark pg_catalog.jsonb_contains LEAKPROOF");

    let api_plan = api_history_plan(&db, t, last, &order).await?;
    assert!(api_plan.contains("journal_entries_entity_idx"), "bb_api history plan must use the GIN index:\n{api_plan}");
    let engine_plan = engine_entity_plan(&db, t, last, &order).await?;
    assert!(engine_plan.contains("journal_entries_entity_idx"), "bb_engine entity read must use the GIN index:\n{engine_plan}");

    // Negative control: without the flag the same bb_api plan cannot use the GIN index (the measured PILOT-09
    // behaviour), which proves the assertion above is about leakproofness and not about table size.
    sqlx::query("ALTER FUNCTION pg_catalog.jsonb_contains(jsonb, jsonb) NOT LEAKPROOF").execute(&db.admin).await?;
    let leaky_plan = api_history_plan(&db, t, last, &order).await;
    sqlx::query("ALTER FUNCTION pg_catalog.jsonb_contains(jsonb, jsonb) LEAKPROOF").execute(&db.admin).await?;
    let leaky_plan = leaky_plan?;
    assert!(!leaky_plan.contains("journal_entries_entity_idx"), "control: a leaky jsonb_contains must not be an index condition under RLS:\n{leaky_plan}");
    Ok(())
}
