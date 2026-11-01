//! Integration test harness for the engine: throwaway PostgreSQL database per test (on the
//! container started by the test runner, see docs/engine.md), migrations from
//! packages/database/migrations, appends through `append_journal_entries(jsonb)` as `bb_api`,
//! engine process spawn and HTTP helpers.

use anyhow::{anyhow, Context, Result};
use blackbox_domain::fixture::{append_json, derived_entries, source_entry, GoldenEvent};
use blackbox_domain::Entry;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const PG_HOST: &str = "127.0.0.1";
pub const PG_PORT: u16 = 19184;
pub const PG_SUPERUSER: &str = "postgres";
pub const PG_SUPERPASS: &str = "enginepg";
pub const API_PASSWORD: &str = "bb_api_test";
pub const ENGINE_PASSWORD: &str = "bb_engine_test";
pub const ENGINE_TOKEN: &str = "test-engine-token-0123456789";

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn pg_env(var: &str, default: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| default.to_string())
}

pub fn pg_host() -> String {
    pg_env("ENGINE_TEST_PGHOST", PG_HOST)
}

pub fn pg_port() -> u16 {
    pg_env("ENGINE_TEST_PGPORT", &PG_PORT.to_string()).parse().unwrap_or(PG_PORT)
}

fn options(db: &str, user: &str, password: &str) -> PgConnectOptions {
    PgConnectOptions::new()
        .host(&pg_host())
        .port(pg_port())
        .database(db)
        .username(user)
        .password(password)
}

pub struct TestDb {
    pub name: String,
    pub admin: PgPool,
    pub api: PgPool,
}

impl TestDb {
    /// Creates `engine_test_<name>_<rand>` with roles, migrations and test passwords.
    pub async fn create(name: &str) -> Result<TestDb> {
        let db_name = format!("engine_test_{}_{}", name, &Uuid::new_v4().to_string()[..8]);
        let root = PgPoolOptions::new()
            .max_connections(2)
            .connect_with(options("postgres", PG_SUPERUSER, PG_SUPERPASS))
            .await
            .context("connect to the throwaway PostgreSQL (docker run ... postgres:16-alpine on 127.0.0.1:19184)")?;
        sqlx::query(&format!("CREATE DATABASE \"{db_name}\""))
            .execute(&root)
            .await?;
        let admin = PgPoolOptions::new()
            .max_connections(4)
            .connect_with(options(&db_name, PG_SUPERUSER, PG_SUPERPASS))
            .await?;
        let roles = std::fs::read_to_string(repo_root().join("packages/database/migrations/0000_roles.sql"))?;
        let journal = std::fs::read_to_string(repo_root().join("packages/database/migrations/0001_journal.sql"))?;
        // Roles are cluster-global: serialize their idempotent creation across parallel tests.
        let mut lock_conn = root.acquire().await?;
        sqlx::query("SELECT pg_advisory_lock(4242)").execute(&mut *lock_conn).await?;
        let r = sqlx::raw_sql(&roles).execute(&admin).await;
        let r2 = sqlx::raw_sql(&format!(
            "ALTER ROLE bb_api PASSWORD '{API_PASSWORD}'; ALTER ROLE bb_engine PASSWORD '{ENGINE_PASSWORD}'; ALTER ROLE bb_worker PASSWORD '{API_PASSWORD}';"
        ))
        .execute(&admin)
        .await;
        sqlx::query("SELECT pg_advisory_unlock(4242)").execute(&mut *lock_conn).await?;
        drop(lock_conn);
        r?;
        r2?;
        sqlx::raw_sql(&journal).execute(&admin).await?;
        let api = PgPoolOptions::new()
            .max_connections(8)
            .connect_with(options(&db_name, "bb_api", API_PASSWORD))
            .await?;
        Ok(TestDb {
            name: db_name,
            admin,
            api,
        })
    }

    /// Creates a tenant row and its sequence row (as the migration role would).
    pub async fn create_tenant(&self, display_name: &str) -> Result<Uuid> {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO tenants (tenant_id, display_name) VALUES ($1, $2)")
            .bind(id)
            .bind(display_name)
            .execute(&self.admin)
            .await?;
        sqlx::query("INSERT INTO tenant_sequences (tenant_id, last_sequence) VALUES ($1, 0)")
            .bind(id)
            .execute(&self.admin)
            .await?;
        Ok(id)
    }

    /// Creates a connection row for a tenant (RLS-scoped insert as bb_api).
    pub async fn create_connection(&self, tenant: Uuid, provider: &str) -> Result<Uuid> {
        let id = blackbox_domain::fixture::connection_uuid(tenant, provider);
        let mut tx = self.api.begin().await?;
        sqlx::query("SELECT set_config('app.tenant_id', $1, true)")
            .bind(tenant.to_string())
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO connections (connection_id, tenant_id, provider, display_name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING")
            .bind(id)
            .bind(tenant)
            .bind(provider)
            .bind(format!("{provider} (test)"))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(id)
    }

    /// Appends entries through the single append boundary as bb_api. Returns (entry_id, seq).
    pub async fn append(&self, tenant: Uuid, entries: &[Value]) -> Result<Vec<(Uuid, i64)>> {
        if entries.is_empty() {
            return Ok(Vec::new());
        }
        let mut tx = self.api.begin().await?;
        sqlx::query("SELECT set_config('app.tenant_id', $1, true)")
            .bind(tenant.to_string())
            .execute(&mut *tx)
            .await?;
        let row = sqlx::query("SELECT append_journal_entries($1::jsonb) AS out")
            .bind(Value::Array(entries.to_vec()))
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        let out: Value = row.get("out");
        let mut res = Vec::new();
        for o in out.as_array().cloned().unwrap_or_default() {
            let id = Uuid::parse_str(o["entry_id"].as_str().unwrap_or(""))?;
            let seq = o["journal_sequence"].as_i64().unwrap_or(0);
            res.push((id, seq));
        }
        Ok(res)
    }

    pub async fn committed_cursor(&self, tenant: Uuid) -> Result<i64> {
        let row = sqlx::query("SELECT last_sequence FROM tenant_sequences WHERE tenant_id = $1")
            .bind(tenant)
            .fetch_one(&self.admin)
            .await?;
        Ok(row.get::<i64, _>("last_sequence"))
    }

    pub async fn snapshot_count(&self, tenant: Uuid) -> Result<i64> {
        let row = sqlx::query("SELECT count(*) AS n FROM engine_snapshots WHERE tenant_id = $1")
            .bind(tenant)
            .fetch_one(&self.admin)
            .await?;
        Ok(row.get::<i64, _>("n"))
    }

    pub async fn corrupt_snapshot(&self, tenant: Uuid) -> Result<()> {
        sqlx::query("UPDATE engine_snapshots SET blob = substring(blob from 1 for 64) || '\\x00ff'::bytea WHERE tenant_id = $1")
            .bind(tenant)
            .execute(&self.admin)
            .await?;
        Ok(())
    }

    pub async fn checkpoint(&self, tenant: Uuid) -> Result<Option<(i64, String)>> {
        let row = sqlx::query("SELECT applied_sequence, state_hash FROM engine_checkpoints WHERE tenant_id = $1")
            .bind(tenant)
            .fetch_optional(&self.admin)
            .await?;
        Ok(row.map(|r| (r.get::<i64, _>("applied_sequence"), r.get::<Option<String>, _>("state_hash").unwrap_or_default())))
    }
}

/// Appends a golden/synthetic observation: the source entry, then (optionally) its derived
/// entries referencing the committed source entry id. Returns the appended entries with ids.
pub struct Appender<'a> {
    pub db: &'a TestDb,
    pub tenant: Uuid,
    pub connections: HashMap<String, Uuid>,
    pub derived: bool,
}

impl<'a> Appender<'a> {
    pub async fn new(db: &'a TestDb, tenant: Uuid, derived: bool) -> Result<Appender<'a>> {
        Ok(Appender {
            db,
            tenant,
            connections: HashMap::new(),
            derived,
        })
    }

    pub async fn connection(&mut self, name: &str) -> Result<Uuid> {
        if let Some(c) = self.connections.get(name) {
            return Ok(*c);
        }
        let id = self.db.create_connection(self.tenant, name).await?;
        self.connections.insert(name.to_string(), id);
        Ok(id)
    }

    /// Builds the source entry for an event (sequence placeholders; the DB assigns real ones).
    pub async fn source(&mut self, ev: &GoldenEvent) -> Result<Entry> {
        let conn = self.connection(&ev.connection).await?;
        Ok(source_entry(self.tenant, 0, ev, conn, Utc::now()))
    }

    /// Appends one observation. Returns (source entry id, source seq, last seq).
    pub async fn observe(&mut self, ev: &GoldenEvent) -> Result<(Uuid, i64, i64)> {
        let src = self.source(ev).await?;
        self.observe_entry(src).await
    }

    pub async fn observe_entry(&mut self, mut src: Entry) -> Result<(Uuid, i64, i64)> {
        let out = self.db.append(self.tenant, &[append_json(&src)]).await?;
        let (id, seq) = out[0];
        src.entry_id = id;
        src.journal_sequence = seq;
        let mut last = seq;
        if self.derived {
            let d = derived_entries(&src, seq + 1);
            if !d.is_empty() {
                let vals: Vec<Value> = d.iter().map(append_json).collect();
                let out = self.db.append(self.tenant, &vals).await?;
                last = out.last().map(|o| o.1).unwrap_or(seq);
            }
        }
        Ok((id, seq, last))
    }

    /// Appends many observations in batches (sources first, then derived entries referencing
    /// the committed ids). Returns the last sequence.
    pub async fn observe_many(&mut self, events: &[GoldenEvent], batch: usize) -> Result<i64> {
        let mut last = 0;
        for chunk in events.chunks(batch.max(1)) {
            let mut sources = Vec::new();
            for ev in chunk {
                sources.push(self.source(ev).await?);
            }
            let vals: Vec<Value> = sources.iter().map(append_json).collect();
            let out = self.db.append(self.tenant, &vals).await?;
            last = out.last().map(|o| o.1).unwrap_or(last);
            if self.derived {
                let mut derived = Vec::new();
                for (src, (id, seq)) in sources.iter_mut().zip(out.iter()) {
                    src.entry_id = *id;
                    src.journal_sequence = *seq;
                    derived.extend(derived_entries(src, 0));
                }
                if !derived.is_empty() {
                    let vals: Vec<Value> = derived.iter().map(append_json).collect();
                    let out = self.db.append(self.tenant, &vals).await?;
                    last = out.last().map(|o| o.1).unwrap_or(last);
                }
            }
        }
        Ok(last)
    }
}

/// A running engine process bound to a test database.
pub struct Engine {
    child: Child,
    pub base_url: String,
    pub port: u16,
    pub client: reqwest::Client,
    pub stderr_path: PathBuf,
}

pub fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

pub fn engine_binary() -> PathBuf {
    if let Ok(p) = std::env::var("ENGINE_BINARY") {
        return PathBuf::from(p);
    }
    // target/debug/blackbox-engine relative to the workspace target dir.
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../../target/debug/blackbox-engine");
    p
}

impl Engine {
    pub async fn spawn(db: &TestDb, extra_env: &[(&str, &str)]) -> Result<Engine> {
        let port = free_port();
        Engine::spawn_on(db, port, extra_env).await
    }

    pub async fn spawn_on(db: &TestDb, port: u16, extra_env: &[(&str, &str)]) -> Result<Engine> {
        let bin = engine_binary();
        if !bin.exists() {
            return Err(anyhow!("engine binary not found at {} (run cargo build -p blackbox-engine first)", bin.display()));
        }
        let stderr_path = std::env::temp_dir().join(format!("blackbox-engine-test-{port}.log"));
        let stderr = std::fs::File::create(&stderr_path)?;
        let mut cmd = Command::new(&bin);
        cmd.env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("PGHOST", pg_host())
            .env("PGPORT", pg_port().to_string())
            .env("PGDATABASE", &db.name)
            .env("PGUSER", "bb_engine")
            .env("PGPASSWORD", ENGINE_PASSWORD)
            .env("ENGINE_TOKEN", ENGINE_TOKEN)
            .env("ENGINE_LISTEN", format!("127.0.0.1:{port}"))
            .env("ENGINE_POLL_MS", "50")
            .env("ENGINE_SNAPSHOT_SECONDS", "1")
            .env("ENGINE_SNAPSHOT_MIN_ENTRIES", "1")
            .env("LOG_LEVEL", "info")
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr));
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        let child = cmd.spawn()?;
        let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build()?;
        let e = Engine {
            child,
            base_url: format!("http://127.0.0.1:{port}"),
            port,
            client,
            stderr_path,
        };
        e.wait_health(Duration::from_secs(20)).await?;
        Ok(e)
    }

    pub async fn wait_health(&self, timeout: Duration) -> Result<Value> {
        let start = Instant::now();
        loop {
            if let Ok(r) = self.client.get(format!("{}/health", self.base_url)).header("X-Engine-Token", ENGINE_TOKEN).send().await {
                if r.status().is_success() {
                    return Ok(r.json().await?);
                }
            }
            if start.elapsed() > timeout {
                let log = std::fs::read_to_string(&self.stderr_path).unwrap_or_default();
                return Err(anyhow!("engine did not become healthy in time; log tail:\n{}", log.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>()));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Waits until the tenant's applied cursor reaches `seq` (per /health).
    pub async fn wait_applied(&self, tenant: Uuid, seq: i64, timeout: Duration) -> Result<Duration> {
        let start = Instant::now();
        loop {
            let h = self.health().await?;
            let applied = h["tenants"][tenant.to_string()]["applied_cursor"].as_i64().unwrap_or(-1);
            let phase = h["tenants"][tenant.to_string()]["phase"].as_str().unwrap_or("");
            if applied >= seq && phase == "ready" {
                return Ok(start.elapsed());
            }
            if start.elapsed() > timeout {
                return Err(anyhow!("tenant {tenant} applied {applied} (phase {phase}) did not reach {seq} within {timeout:?}"));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    pub async fn health(&self) -> Result<Value> {
        let r = self.client.get(format!("{}/health", self.base_url)).header("X-Engine-Token", ENGINE_TOKEN).send().await?;
        Ok(r.json().await?)
    }

    pub async fn post(&self, path: &str, body: Value) -> Result<(u16, Value)> {
        self.post_as(path, body, None).await
    }

    pub async fn post_as(&self, path: &str, body: Value, principal: Option<&str>) -> Result<(u16, Value)> {
        let mut req = self.client.post(format!("{}{}", self.base_url, path)).header("X-Engine-Token", ENGINE_TOKEN).json(&body);
        if let Some(p) = principal {
            req = req.header("X-Principal-Id", p);
        }
        let r = req.send().await?;
        let status = r.status().as_u16();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        Ok((status, v))
    }

    pub async fn state(&self, tenant: Uuid, entity_type: &str, entity_id: &str, consistency: Value) -> Result<(u16, Value)> {
        self.post("/v1/state", json!({"tenant_id": tenant, "entity_type": entity_type, "entity_id": entity_id, "consistency": consistency})).await
    }

    pub async fn order_state(&self, tenant: Uuid, order: &str) -> Result<Value> {
        let (status, v) = self.state(tenant, "order", order, json!({"mode": "latest_committed"})).await?;
        if status != 200 {
            return Err(anyhow!("state {status}: {v}"));
        }
        Ok(v)
    }

    pub async fn query(&self, tenant: Uuid, intent: &str, params: Value) -> Result<(u16, Value)> {
        self.post("/v1/query", json!({"tenant_id": tenant, "intent": intent, "params": params, "consistency": {"mode": "latest_committed"}})).await
    }

    pub async fn query_ok(&self, tenant: Uuid, intent: &str, params: Value) -> Result<Value> {
        let (status, v) = self.query(tenant, intent, params).await?;
        if status != 200 {
            return Err(anyhow!("query {intent} {status}: {v}"));
        }
        Ok(v)
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    pub fn pause(&self) {
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGSTOP);
        }
    }

    pub fn resume(&self) {
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGCONT);
        }
    }

    pub fn log(&self) -> String {
        std::fs::read_to_string(&self.stderr_path).unwrap_or_default()
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Synthetic event builder for non-golden families.
pub fn event(id: &str, connection: &str, kind: &str, occurred_at: DateTime<Utc>, entity: &[(&str, &str)], payload: Value) -> GoldenEvent {
    GoldenEvent {
        id: id.to_string(),
        connection: connection.to_string(),
        provider_event_id: format!("ev-{id}"),
        occurred_at,
        entity: entity.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        kind: kind.to_string(),
        payload: payload.as_object().cloned().unwrap_or_default(),
        evidence_refs: vec![],
    }
}

pub fn percentile(sorted_ms: &[f64], p: f64) -> f64 {
    if sorted_ms.is_empty() {
        return 0.0;
    }
    let idx = ((sorted_ms.len() as f64) * p).ceil() as usize;
    sorted_ms[idx.saturating_sub(1).min(sorted_ms.len() - 1)]
}
