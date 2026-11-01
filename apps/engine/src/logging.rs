//! JSON log records on stderr following packages/contracts/log-record.json: allowlisted fields,
//! clipped strings (512 chars), 16 KiB cap, control characters escaped by the JSON encoder.
//! When `LOG_DIR` is set the same records are appended to
//! `<LOG_DIR>/records-YYYYMMDD-HH-engine.jsonl` so the shared diagnostics query
//! (`./blackbox logs`) correlates engine, api and worker records (ADR-0006).

use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

const ALLOWED: &[&str] = &[
    "tenant_id",
    "connection_id",
    "capability_id",
    "run_id",
    "operation_id",
    "attempt",
    "trace_id",
    "span_id",
    "parent_span_id",
    "duration_ms",
    "record_count",
    "error_code",
    "retryable",
    "next_retry_at",
    "action_code",
    "journal_batch_id",
    "committed_cursor",
    "applied_cursor",
    "truncated",
    "termination",
];

const MAX_STRING: usize = 512;
const MAX_RECORD: usize = 16384;

pub struct JsonLayer {
    pub service_version: String,
    pub instance_id: String,
    pub min_level: Level,
    counter: AtomicU64,
    /// Optional shared logs directory (LOG_DIR); hourly files, append-only, never rotated by the engine
    /// (the api collector enforces the 7-day / 100 MiB bound over the directory).
    log_dir: Option<PathBuf>,
    file: Mutex<Option<(String, std::fs::File)>>,
}

impl JsonLayer {
    pub fn new(service_version: String, instance_id: String, min_level: Level) -> JsonLayer {
        let log_dir = std::env::var("LOG_DIR")
            .ok()
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .filter(|d| d.is_dir());
        JsonLayer {
            service_version,
            instance_id,
            min_level,
            counter: AtomicU64::new(0),
            log_dir,
            file: Mutex::new(None),
        }
    }

    fn append_file(&self, now: &chrono::DateTime<chrono::Utc>, line: &str) {
        let Some(dir) = &self.log_dir else { return };
        let name = format!("records-{}-engine.jsonl", now.format("%Y%m%d-%H"));
        if let Ok(mut guard) = self.file.lock() {
            let reopen = match &*guard {
                Some((current, _)) => current != &name,
                None => true,
            };
            if reopen {
                match std::fs::OpenOptions::new().create(true).append(true).open(dir.join(&name)) {
                    Ok(f) => *guard = Some((name, f)),
                    Err(_) => {
                        *guard = None;
                        return;
                    }
                }
            }
            if let Some((_, f)) = guard.as_mut() {
                let _ = f.write_all(line.as_bytes());
                let _ = f.write_all(b"\n");
            }
        }
    }
}

#[derive(Default)]
struct Collector {
    event_name: Option<String>,
    message: Option<String>,
    fields: BTreeMap<String, serde_json::Value>,
    truncated: bool,
}

impl Collector {
    fn clip(&mut self, s: &str) -> String {
        if s.chars().count() > MAX_STRING {
            self.truncated = true;
            s.chars().take(MAX_STRING).collect()
        } else {
            s.to_string()
        }
    }

    fn put(&mut self, name: &str, v: serde_json::Value) {
        match name {
            "event_name" => self.event_name = v.as_str().map(|s| s.to_string()),
            "message" => {
                let s = match &v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                self.message = Some(self.clip(&s));
            }
            n if ALLOWED.contains(&n) => {
                let v = match v {
                    serde_json::Value::String(s) => serde_json::Value::String(self.clip(&s)),
                    o => o,
                };
                self.fields.insert(n.to_string(), v);
            }
            _ => {}
        }
    }
}

impl Visit for Collector {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let s = format!("{value:?}");
        let s = s.trim_matches('"').to_string();
        self.put(field.name(), serde_json::Value::String(s));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field.name(), serde_json::Value::String(value.to_string()));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field.name(), serde_json::Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field.name(), serde_json::Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field.name(), serde_json::Value::from(value));
    }
}

impl<S: Subscriber> Layer<S> for JsonLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let level = *event.metadata().level();
        if level > self.min_level {
            return;
        }
        let mut c = Collector::default();
        event.record(&mut c);
        let now_dt = chrono::Utc::now();
        let now = now_dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let level_s = match level {
            Level::ERROR => "ERROR",
            Level::WARN => "WARN",
            Level::INFO => "INFO",
            _ => "DEBUG",
        };
        let event_name = c
            .event_name
            .clone()
            .unwrap_or_else(|| format!("engine.{}", event.metadata().target().replace("::", ".")));
        let scope = if c.fields.contains_key("tenant_id") { "workspace" } else { "installation" };
        let mut rec = serde_json::Map::new();
        rec.insert("schema_version".into(), serde_json::json!(1));
        rec.insert("record_id".into(), serde_json::json!(format!("{}-{}", self.instance_id, n)));
        rec.insert("occurred_at".into(), serde_json::json!(now));
        rec.insert("observed_at".into(), serde_json::json!(now));
        rec.insert("level".into(), serde_json::json!(level_s));
        rec.insert("event_name".into(), serde_json::json!(event_name));
        rec.insert("message".into(), serde_json::json!(c.message.clone().unwrap_or_default()));
        rec.insert("component".into(), serde_json::json!("engine"));
        rec.insert("service_version".into(), serde_json::json!(self.service_version));
        rec.insert("instance_id".into(), serde_json::json!(self.instance_id));
        rec.insert("scope".into(), serde_json::json!(scope));
        for (k, v) in c.fields {
            rec.insert(k, v);
        }
        if c.truncated {
            rec.insert("truncated".into(), serde_json::json!(true));
        }
        let mut line = serde_json::Value::Object(rec).to_string();
        if line.len() > MAX_RECORD {
            // Drop the message to fit the cap; keep the structural fields.
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&line) {
                v["message"] = serde_json::json!("");
                v["truncated"] = serde_json::json!(true);
                line = v.to_string();
            }
            if line.len() > MAX_RECORD {
                line.truncate(MAX_RECORD);
            }
        }
        let stderr = std::io::stderr();
        let mut h = stderr.lock();
        let _ = h.write_all(line.as_bytes());
        let _ = h.write_all(b"\n");
        drop(h);
        self.append_file(&now_dt, &line);
    }
}
