//! Synthetic smoke corpus generator (benchmarks/performance-contract.json "smoke" dataset).
//! Appends valid five-track entries through `append_journal_entries(jsonb)` as the API role with
//! a fixed seed and writes a dataset manifest JSON for the orchestrator (PILOT-09).
//!
//! Usage (environment: PGHOST, PGPORT, PGDATABASE, PGUSER=bb_api, PGPASSWORD or PGPASSWORD_FILE):
//!   corpus --seed 42 --tenants 50 --min-entries 250000 --min-orders 10000 \
//!          --manifest reports/corpus-manifest.json [--batch 100] [--no-derived]

use anyhow::{anyhow, Context, Result};
use blackbox_domain::fixture::{append_json, derived_entries, mutate, payload_hash, source_entry, GoldenEvent, GoldenScenario, ScenarioParams};
use blackbox_domain::{Entry, Track};
use chrono::{DateTime, Duration as ChronoDuration, TimeZone, Utc};
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha20Rng;
use serde_json::{json, Map, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::time::Instant;
use uuid::Uuid;

const GENERATOR_VERSION: &str = "corpus-v1";

struct Args {
    seed: u64,
    tenants: usize,
    min_entries: u64,
    min_orders: usize,
    manifest: String,
    batch: usize,
    derived: bool,
    hot_orders: usize,
}

fn parse_args() -> Result<Args> {
    let mut a = Args {
        seed: 42,
        tenants: 50,
        min_entries: 250_000,
        min_orders: 10_000,
        manifest: "reports/corpus-manifest.json".into(),
        batch: 100,
        derived: true,
        hot_orders: 2000,
    };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < argv.len() {
        let k = argv[i].as_str();
        let mut val = || -> Result<String> {
            i += 1;
            argv.get(i).cloned().ok_or_else(|| anyhow!("missing value for {k}"))
        };
        match k {
            "--seed" => a.seed = val()?.parse()?,
            "--tenants" => a.tenants = val()?.parse()?,
            "--min-entries" => a.min_entries = val()?.parse()?,
            "--min-orders" => a.min_orders = val()?.parse()?,
            "--manifest" => a.manifest = val()?,
            "--batch" => a.batch = val()?.parse()?,
            "--hot-orders" => a.hot_orders = val()?.parse()?,
            "--no-derived" => a.derived = false,
            "--help" | "-h" => {
                println!("corpus --seed N --tenants N --min-entries N --min-orders N --manifest PATH [--batch N] [--hot-orders N] [--no-derived]");
                std::process::exit(0);
            }
            other => return Err(anyhow!("unknown argument {other}")),
        }
        i += 1;
    }
    Ok(a)
}

fn pool() -> Result<PgConnectOptions> {
    let host = std::env::var("PGHOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("PGPORT").ok().and_then(|p| p.parse().ok()).unwrap_or(5432);
    let db = std::env::var("PGDATABASE").unwrap_or_else(|_| "blackbox".into());
    let user = std::env::var("PGUSER").unwrap_or_else(|_| "bb_api".into());
    let password = match std::env::var("PGPASSWORD_FILE") {
        Ok(p) => std::fs::read_to_string(p)?.trim().to_string(),
        Err(_) => std::env::var("PGPASSWORD").unwrap_or_default(),
    };
    Ok(PgConnectOptions::new().host(&host).port(port).database(&db).username(&user).password(&password).application_name("blackbox-corpus"))
}

async fn with_tenant<'a>(pool: &PgPool, tenant: Uuid) -> Result<sqlx::Transaction<'a, sqlx::Postgres>> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.tenant_id', $1, true)")
        .bind(tenant.to_string())
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

async fn create_tenant(pool: &PgPool, tenant: Uuid, name: &str) -> Result<()> {
    let mut tx = with_tenant(pool, tenant).await?;
    sqlx::query("INSERT INTO tenants (tenant_id, display_name) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(tenant)
        .bind(name)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO tenant_sequences (tenant_id, last_sequence) VALUES ($1, 0) ON CONFLICT DO NOTHING")
        .bind(tenant)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

async fn create_connection(pool: &PgPool, tenant: Uuid, provider: &str) -> Result<Uuid> {
    let id = blackbox_domain::fixture::connection_uuid(tenant, provider);
    let mut tx = with_tenant(pool, tenant).await?;
    sqlx::query("INSERT INTO connections (connection_id, tenant_id, provider, display_name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(tenant)
        .bind(provider)
        .bind(format!("{provider} (corpus)"))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(id)
}

async fn append(pool: &PgPool, tenant: Uuid, entries: &[Value]) -> Result<Vec<(Uuid, i64)>> {
    if entries.is_empty() {
        return Ok(vec![]);
    }
    let mut tx = with_tenant(pool, tenant).await?;
    let row = sqlx::query("SELECT append_journal_entries($1::jsonb) AS out")
        .bind(Value::Array(entries.to_vec()))
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    let out: Value = row.get("out");
    Ok(out
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|o| (Uuid::parse_str(o["entry_id"].as_str().unwrap_or("")).unwrap_or_default(), o["journal_sequence"].as_i64().unwrap_or(0)))
        .collect())
}

fn hex(rng: &mut ChaCha20Rng, n: usize) -> String {
    (0..n).map(|_| format!("{:x}", rng.gen_range(0..16))).collect()
}

/// Plans the order count per tenant: the largest tenant holds 50% of all orders.
fn plan_orders(total: usize, tenants: usize, rng: &mut ChaCha20Rng) -> Vec<usize> {
    let largest = total / 2;
    let rest = total - largest;
    let mut weights: Vec<f64> = (0..tenants - 1).map(|_| rng.gen_range(0.2f64..1.8)).collect();
    let sum: f64 = weights.iter().sum();
    for w in weights.iter_mut() {
        *w /= sum;
    }
    let mut counts: Vec<usize> = weights.iter().map(|w| ((rest as f64) * w).floor() as usize).collect();
    let assigned: usize = counts.iter().sum();
    counts[0] += rest - assigned;
    for c in counts.iter_mut() {
        if *c == 0 {
            *c = 1;
        }
    }
    let mut out = vec![largest];
    out.extend(counts);
    out
}

struct OrderPlan {
    params: ScenarioParams,
    /// Number of golden observations to include (short histories stop early).
    events: usize,
    late_fee_correction: bool,
    late_failed_attempt: bool,
    extra_scans: usize,
    customer: String,
    tracking: String,
}

fn make_plan(rng: &mut ChaCha20Rng, tenant_tag: &str, n: usize, skus: &[String], currencies: &[&str]) -> OrderPlan {
    let suffix = format!("-{tenant_tag}-{n}-{}", hex(rng, 6));
    let quantity = rng.gen_range(1..=40);
    let unit = rng.gen_range(99..=99_999);
    let gross = quantity * unit;
    let r: f64 = rng.gen();
    let events = if r < 0.25 { 10 } else if r < 0.4 { 14 } else { 19 };
    let return_quantity = if events >= 11 { rng.gen_range(0..=quantity.min(5)) } else { 0 };
    OrderPlan {
        params: ScenarioParams {
            quantity,
            unit_gross_minor: unit,
            fee_minor: (gross * rng.gen_range(5..=40)) / 1000,
            return_quantity,
            physical_stock: quantity + rng.gen_range(0..500),
            currency: currencies[rng.gen_range(0..currencies.len())].to_string(),
            suffix,
        },
        events,
        late_fee_correction: rng.gen_bool(0.05),
        late_failed_attempt: rng.gen_bool(0.08),
        extra_scans: rng.gen_range(0..4),
        customer: format!("C-{}", hex(rng, 10)),
        tracking: format!("JJD{}", hex(rng, 14).to_uppercase()),
    }
    .with_sku(skus[rng.gen_range(0..skus.len())].clone())
}

impl OrderPlan {
    fn with_sku(mut self, _sku: String) -> OrderPlan {
        self.params.suffix = self.params.suffix.clone();
        self
    }
}

fn rewrite_ids(events: &mut [GoldenEvent], sku: &str, customer: &str, tracking: &str, base_time: DateTime<Utc>) {
    for ev in events.iter_mut() {
        let delta = ev.occurred_at - Utc.with_ymd_and_hms(2026, 10, 31, 9, 0, 0).unwrap();
        ev.occurred_at = base_time + delta;
        for (k, v) in ev.entity.iter_mut() {
            if k == "item" {
                *v = sku.to_string();
            } else if k == "customer" {
                *v = customer.to_string();
            }
        }
        if let Some(Value::String(s)) = ev.payload.get_mut("sku") {
            *s = sku.to_string();
        }
        if ev.kind == "shipment.dispatched" {
            ev.payload.insert("tracking_number".into(), json!(tracking));
            ev.payload.insert("carrier".into(), json!("dhl"));
        }
    }
}

/// Appends pending source entries (one call) and their derived entries (second call referencing
/// the committed source ids). Returns (entries added, last sequence).
async fn flush(pool: &PgPool, tenant: Uuid, derived: bool, pending: &mut Vec<Entry>) -> Result<(u64, i64)> {
    let batch: Vec<Entry> = std::mem::take(pending);
    if batch.is_empty() {
        return Ok((0, 0));
    }
    let vals: Vec<Value> = batch.iter().map(append_json).collect();
    let out = append(pool, tenant, &vals).await?;
    let mut added = out.len() as u64;
    let mut last = out.last().map(|o| o.1).unwrap_or(0);
    if derived {
        let mut d = Vec::new();
        for (mut src, (id, seq)) in batch.into_iter().zip(out.iter()) {
            src.entry_id = *id;
            src.journal_sequence = *seq;
            d.extend(derived_entries(&src, 0));
        }
        if !d.is_empty() {
            let vals: Vec<Value> = d.iter().map(append_json).collect();
            let out2 = append(pool, tenant, &vals).await?;
            added += out2.len() as u64;
            last = out2.last().map(|o| o.1).unwrap_or(last);
        }
    }
    Ok((added, last))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args()?;
    let started = Instant::now();
    let golden = GoldenScenario::load_from_repo().context("GOLDEN-ORDER-TO-CASH.json")?;
    let pool = PgPoolOptions::new().max_connections(8).connect_with(pool()?).await?;
    let mut rng = ChaCha20Rng::seed_from_u64(args.seed);
    // Orders needed: the richest history has 19 observations -> up to ~63 entries with derived
    // tracks; plan with a safety margin and verify the minimum afterwards.
    let avg_entries_per_order = if args.derived { 45.0 } else { 15.0 };
    let orders_for_entries = ((args.min_entries as f64) / avg_entries_per_order).ceil() as usize;
    let total_orders = args.min_orders.max(orders_for_entries);
    let per_tenant = plan_orders(total_orders, args.tenants, &mut rng);
    let currencies = ["EUR", "EUR", "EUR", "USD", "CHF", "GBP"];
    let connections = ["stock", "shop", "invoice", "payment", "carrier", "bank_csv"];
    let mut manifest_tenants = Vec::new();
    let mut total_entries: u64 = 0;
    let mut total_orders_done: usize = 0;
    let mut history_lengths: Vec<usize> = Vec::new();
    let mut hot_set: Vec<Value> = Vec::new();
    let mut cold_set: Vec<Value> = Vec::new();
    let base_day = Utc.with_ymd_and_hms(2026, 8, 1, 9, 0, 0).unwrap();

    for (ti, n_orders) in per_tenant.iter().enumerate() {
        let tenant = Uuid::new_v4();
        let tag = hex(&mut rng, 4);
        create_tenant(&pool, tenant, &format!("Corpus tenant {ti} ({tag})")).await?;
        let mut conn_ids = HashMap::new();
        for c in connections {
            conn_ids.insert(c.to_string(), create_connection(&pool, tenant, c).await?);
        }
        let skus: Vec<String> = (0..(50 + rng.gen_range(0..450))).map(|_| format!("SKU-{}", hex(&mut rng, 8).to_uppercase())).collect();
        let mut tenant_entries: u64 = 0;
        let mut last_seq = 0i64;
        let mut order_ids: Vec<String> = Vec::new();
        let mut pending_sources: Vec<Entry> = Vec::new();
        let mut pending_late: Vec<Entry> = Vec::new();
        for n in 0..*n_orders {
            let plan = make_plan(&mut rng, &tag, n, &skus, &currencies);
            let sku = skus[rng.gen_range(0..skus.len())].clone();
            let mut events: Vec<GoldenEvent> = mutate(&golden, &plan.params).into_iter().take(plan.events).collect();
            let base_time = base_day + ChronoDuration::minutes(rng.gen_range(0..(90 * 24 * 60)));
            rewrite_ids(&mut events, &sku, &plan.customer, &plan.tracking, base_time);
            let order_id = format!("#1001{}", plan.params.suffix);
            order_ids.push(order_id.clone());
            let mut per_order = 0usize;
            for ev in &events {
                let conn = conn_ids[&ev.connection];
                let src = source_entry(tenant, 0, ev, conn, Utc::now());
                per_order += 1 + if args.derived { blackbox_domain::fixture::derived_tracks(&ev.kind).len() } else { 0 };
                pending_sources.push(src);
            }
            // Extra carrier scans (high-cardinality tracking identities, late observations).
            if plan.events >= 10 {
                for s in 0..plan.extra_scans {
                    let at = base_time + ChronoDuration::minutes(9) + ChronoDuration::hours(s as i64 + 1);
                    let ev = GoldenEvent {
                        id: format!("scan{s}"),
                        connection: "carrier".into(),
                        provider_event_id: format!("scan-{}-{}", plan.tracking, s),
                        occurred_at: at,
                        entity: [("order".to_string(), order_id.clone()), ("customer".to_string(), plan.customer.clone())].into_iter().collect(),
                        kind: "carrier.scan_observed".into(),
                        payload: json!({"tracking_number": plan.tracking, "shipment": format!("SHIP-1001{}", plan.params.suffix), "status_code": if s == 0 { "in_transit" } else { "delivered" }, "effective_time": at.to_rfc3339(), "scan_identity": format!("{}-{}", plan.tracking, s)}).as_object().cloned().unwrap(),
                        evidence_refs: vec![],
                    };
                    pending_sources.push(source_entry(tenant, 0, &ev, conn_ids["carrier"], Utc::now()));
                    per_order += 2;
                }
            }
            if plan.late_failed_attempt && plan.events >= 6 {
                let ev = GoldenEvent {
                    id: "latefail".into(),
                    connection: "payment".into(),
                    provider_event_id: format!("fail-{}", plan.params.suffix),
                    occurred_at: base_time + ChronoDuration::minutes(4) + ChronoDuration::seconds(30),
                    entity: [("order".to_string(), order_id.clone()), ("customer".to_string(), plan.customer.clone())].into_iter().collect(),
                    kind: "payment.failed".into(),
                    payload: json!({"transaction": format!("TX-1001{}", plan.params.suffix), "attempt": format!("ATT{}", plan.params.suffix), "amount_minor": plan.params.gross(), "currency": plan.params.currency, "reason": "card_declined"}).as_object().cloned().unwrap(),
                    evidence_refs: vec![],
                };
                pending_late.push(source_entry(tenant, 0, &ev, conn_ids["payment"], Utc::now()));
                per_order += 3;
            }
            if plan.late_fee_correction && plan.events >= 7 {
                // Fee correction appended later as a fact superseding the fee observation.
                let mut corr = source_entry(tenant, 0, &events[6], conn_ids["payment"], Utc::now());
                corr.track = Track::Fact;
                corr.provider_event_id = None;
                corr.correlation_id = Some(format!("review:fee{}", plan.params.suffix));
                corr.payload = json!({"transaction": format!("TX-1001{}", plan.params.suffix), "fee_minor": plan.params.fee_minor + 7, "currency": plan.params.currency, "reason": "statement correction"});
                corr.payload_hash = payload_hash(&corr.payload);
                corr.derivation_rule = Some("review.decision".into());
                corr.record_id = format!("correction:{}", corr.record_id);
                pending_late.push(corr);
                per_order += 1;
            }
            history_lengths.push(per_order);
            if pending_sources.len() >= args.batch * 19 {
                let (added, last) = flush(&pool, tenant, args.derived, &mut pending_sources).await?;
                tenant_entries += added;
                last_seq = last.max(last_seq);
            }
        }
        let (added, last) = flush(&pool, tenant, args.derived, &mut pending_sources).await?;
        tenant_entries += added;
        last_seq = last.max(last_seq);
        // Late corrections: supersedes must point at the committed fee entry; resolve by record id.
        let mut late_vals = Vec::new();
        for mut e in pending_late.drain(..) {
            if e.supersedes_entry_id.is_none() && e.track == Track::Fact {
                let rec = e.record_id.trim_start_matches("correction:").to_string();
                // RLS needs app.tenant_id on the connection: look up inside a tenant transaction.
                let mut tx = with_tenant(&pool, tenant).await?;
                let row = sqlx::query("SELECT entry_id FROM journal_entries WHERE tenant_id = $1 AND record_id = $2 AND event_type = 'payment.fee_booked' AND track = 'source' ORDER BY journal_sequence LIMIT 1")
                    .bind(tenant)
                    .bind(&rec)
                    .fetch_optional(&mut *tx)
                    .await?;
                tx.commit().await?;
                if let Some(r) = row {
                    e.supersedes_entry_id = Some(r.get::<Uuid, _>("entry_id"));
                    e.record_id = rec;
                } else {
                    continue;
                }
            }
            late_vals.push(append_json(&e));
        }
        for chunk in late_vals.chunks(200) {
            let out = append(&pool, tenant, chunk).await?;
            tenant_entries += out.len() as u64;
            last_seq = out.last().map(|o| o.1).unwrap_or(last_seq);
        }
        total_entries += tenant_entries;
        total_orders_done += n_orders;
        if ti == 0 {
            let mut ids = order_ids.clone();
            ids.shuffle(&mut rng);
            hot_set = ids.iter().take(args.hot_orders).map(|o| json!({"tenant_id": tenant, "order_id": o})).collect();
            cold_set = ids.iter().skip(args.hot_orders).take(500).map(|o| json!({"tenant_id": tenant, "order_id": o})).collect();
        } else if cold_set.len() < 1000 {
            cold_set.extend(order_ids.iter().take(10).map(|o| json!({"tenant_id": tenant, "order_id": o})));
        }
        manifest_tenants.push(json!({"tenant_id": tenant, "display_name": format!("Corpus tenant {ti} ({tag})"), "orders": n_orders, "entries": tenant_entries, "last_sequence": last_seq, "skus": skus.len()}));
        eprintln!("tenant {ti}/{}: {} orders, {} entries, {:?} elapsed", per_tenant.len(), n_orders, tenant_entries, started.elapsed());
    }
    history_lengths.sort_unstable();
    let pct = |p: f64| -> usize {
        let idx = ((history_lengths.len() as f64) * p).ceil() as usize;
        history_lengths[idx.saturating_sub(1).min(history_lengths.len() - 1)]
    };
    let largest = manifest_tenants.iter().map(|t| t["orders"].as_u64().unwrap()).max().unwrap_or(0);
    let mut manifest = Map::new();
    manifest.insert("generator".into(), json!(GENERATOR_VERSION));
    manifest.insert("seed".into(), json!(args.seed));
    manifest.insert("generated_at".into(), json!(Utc::now().to_rfc3339()));
    manifest.insert("source_fixture".into(), json!("GOLDEN-ORDER-TO-CASH.json (mutated per order; payload shapes unchanged)"));
    manifest.insert("derived_entries".into(), json!(args.derived));
    manifest.insert("tenants".into(), json!(manifest_tenants));
    manifest.insert("totals".into(), json!({"tenants": per_tenant.len(), "orders": total_orders_done, "journal_entries": total_entries, "largest_tenant_order_fraction": largest as f64 / total_orders_done as f64}));
    manifest.insert("order_history_entries".into(), json!({"p50": pct(0.5), "p95": pct(0.95), "max": history_lengths.last().copied().unwrap_or(0), "min": history_lengths.first().copied().unwrap_or(0)}));
    manifest.insert("features".into(), json!({"five_tracks": args.derived, "late_corrections": "5% fee corrections (supersedes_entry_id) + 8% late failed attempts", "high_cardinality": "random order/customer/SKU/tracking identifiers", "currencies": currencies, "short_histories": "25% stop after delivery, 15% after restock"}));
    manifest.insert("hot_set".into(), json!(hot_set));
    manifest.insert("cold_sample".into(), json!(cold_set));
    manifest.insert("requirements".into(), json!({"minimum_journal_entries": args.min_entries, "minimum_distinct_orders": args.min_orders, "met": total_entries >= args.min_entries && total_orders_done >= args.min_orders && pct(0.95) >= 50}));
    manifest.insert("duration_seconds".into(), json!(started.elapsed().as_secs_f64()));
    if let Some(parent) = std::path::Path::new(&args.manifest).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(&args.manifest, serde_json::to_string_pretty(&Value::Object(manifest.clone()))?)?;
    println!("{}", serde_json::to_string_pretty(&manifest["totals"])?);
    println!("{}", serde_json::to_string_pretty(&manifest["order_history_entries"])?);
    println!("manifest written to {}", args.manifest);
    Ok(())
}
