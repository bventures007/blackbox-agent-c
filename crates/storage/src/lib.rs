//! PostgreSQL access for the engine role `bb_engine`: journal tail reads, indexed cold entity
//! reads, tenant high-water marks, checkpoints and snapshots. No journal writes.

use blackbox_domain::entry::{Entry, Track};
use chrono::{DateTime, Utc};
use sqlx::postgres::{PgConnectOptions, PgListener, PgPoolOptions, PgRow};
use sqlx::{PgPool, Row};
use std::collections::BTreeMap;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("row decode error: {0}")]
    Decode(String),
}

pub type Result<T> = std::result::Result<T, StorageError>;

#[derive(Clone, Debug)]
pub struct StoreConfig {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    pub max_connections: u32,
    pub application_name: String,
}

impl StoreConfig {
    /// Reads PGHOST/PGPORT/PGDATABASE/PGUSER and PGPASSWORD_FILE (preferred) or PGPASSWORD.
    pub fn from_env() -> anyhow::Result<StoreConfig> {
        let host = std::env::var("PGHOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port: u16 = std::env::var("PGPORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(5432);
        let database = std::env::var("PGDATABASE").unwrap_or_else(|_| "blackbox".into());
        let user = std::env::var("PGUSER").unwrap_or_else(|_| "bb_engine".into());
        let password = match std::env::var("PGPASSWORD_FILE") {
            Ok(path) => std::fs::read_to_string(&path)
                .map_err(|e| anyhow::anyhow!("cannot read PGPASSWORD_FILE {path}: {e}"))?
                .trim()
                .to_string(),
            Err(_) => std::env::var("PGPASSWORD").unwrap_or_default(),
        };
        let max_connections = std::env::var("ENGINE_PG_POOL")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8);
        Ok(StoreConfig {
            host,
            port,
            database,
            user,
            password,
            max_connections,
            application_name: "blackbox-engine".into(),
        })
    }

    pub fn connect_options(&self) -> PgConnectOptions {
        PgConnectOptions::new()
            .host(&self.host)
            .port(self.port)
            .database(&self.database)
            .username(&self.user)
            .password(&self.password)
            .application_name(&self.application_name)
    }
}

#[derive(Clone)]
pub struct Store {
    pool: PgPool,
    options: PgConnectOptions,
}

#[derive(Debug, Clone)]
pub struct CheckpointRow {
    pub applied_sequence: i64,
    pub reducer_version: i32,
    pub state_hash: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct SnapshotRow {
    pub reducer_version: i32,
    pub format_version: i32,
    pub applied_sequence: i64,
    pub checksum: String,
    pub blob: Vec<u8>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct TenantRow {
    pub tenant_id: Uuid,
    pub display_name: String,
}

const ENTRY_COLUMNS: &str = "entry_id, tenant_id, journal_sequence, track::text AS track, record_id, event_type, schema_version, connection_id, provider, account_ref, provider_event_id, occurred_at, recorded_at, source_time, entity_refs, payload, payload_hash, evidence_refs, input_entry_ids, derivation_rule, derivation_version, supersedes_entry_id, correlation_id, causation_id";

fn row_to_entry(row: &PgRow) -> Result<Entry> {
    let track_s: String = row.try_get("track")?;
    let track = Track::parse(&track_s)
        .ok_or_else(|| StorageError::Decode(format!("unknown track {track_s}")))?;
    let entity_refs_v: serde_json::Value = row.try_get("entity_refs")?;
    let mut entity_refs = BTreeMap::new();
    if let serde_json::Value::Object(m) = entity_refs_v {
        for (k, v) in m {
            if let Some(s) = v.as_str() {
                entity_refs.insert(k, s.to_string());
            }
        }
    }
    let evidence_v: serde_json::Value = row.try_get("evidence_refs")?;
    let evidence_refs = match evidence_v {
        serde_json::Value::Array(a) => a
            .into_iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    };
    Ok(Entry {
        entry_id: row.try_get("entry_id")?,
        tenant_id: row.try_get("tenant_id")?,
        journal_sequence: row.try_get("journal_sequence")?,
        track,
        record_id: row.try_get("record_id")?,
        event_type: row.try_get("event_type")?,
        schema_version: row.try_get("schema_version")?,
        connection_id: row.try_get("connection_id")?,
        provider: row.try_get("provider")?,
        account_ref: row.try_get("account_ref")?,
        provider_event_id: row.try_get("provider_event_id")?,
        occurred_at: row.try_get("occurred_at")?,
        recorded_at: row.try_get("recorded_at")?,
        source_time: row.try_get("source_time")?,
        entity_refs,
        payload: row.try_get("payload")?,
        payload_hash: row.try_get("payload_hash")?,
        evidence_refs,
        input_entry_ids: row.try_get("input_entry_ids")?,
        derivation_rule: row.try_get("derivation_rule")?,
        derivation_version: row.try_get("derivation_version")?,
        supersedes_entry_id: row.try_get("supersedes_entry_id")?,
        correlation_id: row.try_get("correlation_id")?,
        causation_id: row.try_get("causation_id")?,
    })
}

impl Store {
    pub async fn connect(cfg: &StoreConfig) -> Result<Store> {
        let options = cfg.connect_options();
        let pool = PgPoolOptions::new()
            .max_connections(cfg.max_connections)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options.clone())
            .await?;
        Ok(Store { pool, options })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn tenants(&self) -> Result<Vec<TenantRow>> {
        let rows = sqlx::query("SELECT tenant_id, display_name FROM tenants ORDER BY created_at, tenant_id")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .iter()
            .map(|r| TenantRow {
                tenant_id: r.get("tenant_id"),
                display_name: r.get("display_name"),
            })
            .collect())
    }

    pub async fn tenant_exists(&self, tenant: Uuid) -> Result<bool> {
        let row = sqlx::query("SELECT 1 FROM tenants WHERE tenant_id = $1")
            .bind(tenant)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    /// Committed high-water mark (`tenant_sequences.last_sequence`).
    pub async fn committed_cursor(&self, tenant: Uuid) -> Result<i64> {
        let row = sqlx::query("SELECT last_sequence FROM tenant_sequences WHERE tenant_id = $1")
            .bind(tenant)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<i64, _>("last_sequence")).unwrap_or(0))
    }

    pub async fn committed_cursors(&self) -> Result<Vec<(Uuid, i64)>> {
        let rows = sqlx::query("SELECT tenant_id, last_sequence FROM tenant_sequences")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .iter()
            .map(|r| (r.get("tenant_id"), r.get("last_sequence")))
            .collect())
    }

    /// Journal tail ordered by (tenant_id, journal_sequence).
    pub async fn read_tail(&self, tenant: Uuid, after: i64, limit: i64) -> Result<Vec<Entry>> {
        let sql = format!(
            "SELECT {ENTRY_COLUMNS} FROM journal_entries WHERE tenant_id = $1 AND journal_sequence > $2 ORDER BY tenant_id, journal_sequence LIMIT $3"
        );
        let rows = sqlx::query(&sql)
            .bind(tenant)
            .bind(after)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(row_to_entry).collect()
    }

    pub async fn entries_by_ids(&self, tenant: Uuid, ids: &[Uuid]) -> Result<Vec<Entry>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT {ENTRY_COLUMNS} FROM journal_entries WHERE tenant_id = $1 AND entry_id = ANY($2) ORDER BY journal_sequence"
        );
        let rows = sqlx::query(&sql)
            .bind(tenant)
            .bind(ids)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(row_to_entry).collect()
    }

    /// Indexed cold read: entries referencing an entity (GIN on entity_refs), keyset-paged by
    /// sequence within a fixed snapshot boundary `upto` (inclusive).
    pub async fn entity_entries(
        &self,
        tenant: Uuid,
        entity_type: &str,
        entity_id: &str,
        after: i64,
        upto: i64,
        recorded_cutoff: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<Entry>> {
        let filter = serde_json::json!({ entity_type: entity_id });
        let sql = format!(
            "SELECT {ENTRY_COLUMNS} FROM journal_entries WHERE tenant_id = $1 AND entity_refs @> $2::jsonb AND journal_sequence > $3 AND journal_sequence <= $4 AND ($5::timestamptz IS NULL OR recorded_at <= $5) ORDER BY journal_sequence LIMIT $6"
        );
        let rows = sqlx::query(&sql)
            .bind(tenant)
            .bind(filter)
            .bind(after)
            .bind(upto)
            .bind(recorded_cutoff)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(row_to_entry).collect()
    }

    pub async fn count_entity_entries(
        &self,
        tenant: Uuid,
        entity_type: &str,
        entity_id: &str,
        upto: i64,
    ) -> Result<i64> {
        let filter = serde_json::json!({ entity_type: entity_id });
        let row = sqlx::query(
            "SELECT count(*) AS n FROM journal_entries WHERE tenant_id = $1 AND entity_refs @> $2::jsonb AND journal_sequence <= $3",
        )
        .bind(tenant)
        .bind(filter)
        .bind(upto)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get::<i64, _>("n"))
    }

    /// Entries of a tenant up to a recorded-time cutoff (bounded; for as_of replays of
    /// tenant-wide intents).
    pub async fn tenant_entries_until(
        &self,
        tenant: Uuid,
        recorded_cutoff: DateTime<Utc>,
        after: i64,
        limit: i64,
    ) -> Result<Vec<Entry>> {
        let sql = format!(
            "SELECT {ENTRY_COLUMNS} FROM journal_entries WHERE tenant_id = $1 AND recorded_at <= $2 AND journal_sequence > $3 ORDER BY journal_sequence LIMIT $4"
        );
        let rows = sqlx::query(&sql)
            .bind(tenant)
            .bind(recorded_cutoff)
            .bind(after)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(row_to_entry).collect()
    }

    pub async fn max_sequence_recorded_until(
        &self,
        tenant: Uuid,
        recorded_cutoff: DateTime<Utc>,
    ) -> Result<i64> {
        let row = sqlx::query(
            "SELECT coalesce(max(journal_sequence), 0) AS s FROM journal_entries WHERE tenant_id = $1 AND recorded_at <= $2",
        )
        .bind(tenant)
        .bind(recorded_cutoff)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get::<i64, _>("s"))
    }

    pub async fn load_checkpoint(&self, tenant: Uuid) -> Result<Option<CheckpointRow>> {
        let row = sqlx::query(
            "SELECT applied_sequence, reducer_version, state_hash, updated_at FROM engine_checkpoints WHERE tenant_id = $1",
        )
        .bind(tenant)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| CheckpointRow {
            applied_sequence: r.get("applied_sequence"),
            reducer_version: r.get("reducer_version"),
            state_hash: r.get("state_hash"),
            updated_at: r.get("updated_at"),
        }))
    }

    /// Durable checkpoint commit (before RAM publication).
    pub async fn save_checkpoint(
        &self,
        tenant: Uuid,
        applied_sequence: i64,
        reducer_version: i32,
        state_hash: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO engine_checkpoints (tenant_id, applied_sequence, reducer_version, state_hash, updated_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (tenant_id) DO UPDATE SET applied_sequence = EXCLUDED.applied_sequence, reducer_version = EXCLUDED.reducer_version, state_hash = EXCLUDED.state_hash, updated_at = now()",
        )
        .bind(tenant)
        .bind(applied_sequence)
        .bind(reducer_version)
        .bind(state_hash)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn load_snapshot(&self, tenant: Uuid, reducer_version: i32) -> Result<Option<SnapshotRow>> {
        let row = sqlx::query(
            "SELECT reducer_version, format_version, applied_sequence, checksum, blob, created_at FROM engine_snapshots WHERE tenant_id = $1 AND reducer_version = $2",
        )
        .bind(tenant)
        .bind(reducer_version)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| SnapshotRow {
            reducer_version: r.get("reducer_version"),
            format_version: r.get("format_version"),
            applied_sequence: r.get("applied_sequence"),
            checksum: r.get("checksum"),
            blob: r.get("blob"),
            created_at: r.get("created_at"),
        }))
    }

    pub async fn save_snapshot(
        &self,
        tenant: Uuid,
        reducer_version: i32,
        format_version: i32,
        applied_sequence: i64,
        checksum: &str,
        blob: &[u8],
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO engine_snapshots (tenant_id, reducer_version, format_version, applied_sequence, checksum, blob, created_at) VALUES ($1, $2, $3, $4, $5, $6, now()) ON CONFLICT (tenant_id, reducer_version) DO UPDATE SET format_version = EXCLUDED.format_version, applied_sequence = EXCLUDED.applied_sequence, checksum = EXCLUDED.checksum, blob = EXCLUDED.blob, created_at = now()",
        )
        .bind(tenant)
        .bind(reducer_version)
        .bind(format_version)
        .bind(applied_sequence)
        .bind(checksum)
        .bind(blob)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_snapshot(&self, tenant: Uuid) -> Result<()> {
        sqlx::query("DELETE FROM engine_snapshots WHERE tenant_id = $1")
            .bind(tenant)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_checkpoint(&self, tenant: Uuid) -> Result<()> {
        sqlx::query("DELETE FROM engine_checkpoints WHERE tenant_id = $1")
            .bind(tenant)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Dedicated LISTEN connection for the `journal_appended` wake hint.
    pub async fn listener(&self) -> Result<PgListener> {
        let mut l = PgListener::connect_with(&self.pool).await?;
        l.listen("journal_appended").await?;
        Ok(l)
    }

    pub fn options(&self) -> &PgConnectOptions {
        &self.options
    }
}

/// Parses a `journal_appended` payload ("<tenant>:<sequence>").
pub fn parse_wake_hint(payload: &str) -> Option<(Uuid, i64)> {
    let (t, s) = payload.split_once(':')?;
    Some((Uuid::parse_str(t).ok()?, s.parse().ok()?))
}
