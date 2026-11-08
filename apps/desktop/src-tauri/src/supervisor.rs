//! Supervisor: does natively what Docker Compose and `./blackbox` do for the container install.
//!
//! Start: check the bundle → create folders and secrets → initdb on first start → start PostgreSQL on
//! 127.0.0.1 → create the database and the non-owner roles (0000_roles.sql) → run migrations → start
//! engine, API and worker → wait for API health → create the owner on first start.
//! While running: restart a crashed service (at most 5 times in 2 minutes), restart PostgreSQL if it
//! stops. Stop: worker → API → engine (SIGTERM, then kill), then `pg_ctl stop -m fast`.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::layout::{display, port_open, Layout, Ports};
use crate::proc;
use crate::secrets;

const DB: &str = "blackbox";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Starting,
    Database,
    Migrating,
    Services,
    OwnerKey,
    OwnerKeyMissing,
    Ready,
    Restarting,
    Stopping,
    Stopped,
    Error,
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub phase: Phase,
    pub message: String,
    pub api_url: Option<String>,
    /// Shown once on first start; held in memory only until the user confirms it is saved.
    pub owner_key: Option<String>,
    pub error: Option<String>,
    pub data_dir: String,
    pub logs_dir: String,
    pub version: String,
}

struct Service {
    name: &'static str,
    child: Child,
    restarts: Vec<Instant>,
}

pub struct Supervisor {
    pub layout: Layout,
    status: Mutex<Status>,
    services: Mutex<Vec<Service>>,
    ports: Mutex<Option<Ports>>,
    stopping: AtomicBool,
    /// Incremented on every start so a monitor from an earlier start exits.
    generation: AtomicU64,
    busy: Mutex<()>,
    on_change: Mutex<Option<Box<dyn Fn(&Status) + Send + Sync>>>,
}

impl Supervisor {
    pub fn new(layout: Layout, version: String) -> Arc<Self> {
        let status = Status {
            phase: Phase::Starting,
            message: "Starting Blackbox…".into(),
            api_url: None,
            owner_key: None,
            error: None,
            data_dir: display(&layout.data),
            logs_dir: display(&layout.process_logs()),
            version,
        };
        Arc::new(Self {
            layout,
            status: Mutex::new(status),
            services: Mutex::new(Vec::new()),
            ports: Mutex::new(None),
            stopping: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            busy: Mutex::new(()),
            on_change: Mutex::new(None),
        })
    }

    pub fn set_on_change(&self, f: impl Fn(&Status) + Send + Sync + 'static) {
        *self.on_change.lock().unwrap() = Some(Box::new(f));
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    fn set(&self, phase: Phase, message: &str) {
        let snapshot = {
            let mut s = self.status.lock().unwrap();
            s.phase = phase;
            s.message = message.to_string();
            if phase != Phase::Error {
                s.error = None;
            }
            s.clone()
        };
        proc::note(&self.layout, &format!("{phase:?}: {message}"));
        if let Some(f) = self.on_change.lock().unwrap().as_ref() {
            f(&snapshot);
        }
    }

    fn fail(&self, e: &anyhow::Error) {
        {
            let mut s = self.status.lock().unwrap();
            s.error = Some(format!("{e:#}"));
        }
        self.set(Phase::Error, "Blackbox could not start.");
    }

    /// Starts everything in the background. Safe to call again after an error.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        std::thread::spawn(move || {
            let _guard = me.busy.lock().unwrap();
            me.stopping.store(false, Ordering::SeqCst);
            let generation = me.generation.fetch_add(1, Ordering::SeqCst) + 1;
            if let Err(e) = me.start_inner() {
                proc::note(&me.layout, &format!("start failed: {e:#}"));
                me.stop_services();
                me.fail(&e);
                return;
            }
            let monitor = me.clone();
            std::thread::spawn(move || monitor.monitor(generation));
        });
    }

    fn start_inner(&self) -> Result<()> {
        let l = &self.layout;
        self.set(Phase::Starting, "Checking the installation…");
        l.check_runtime()?;
        l.create_dirs()?;
        proc::stop_leftovers(l);
        secrets::ensure(l)?;
        let ports = l.ports()?;
        *self.ports.lock().unwrap() = Some(ports);
        let status_file = l.backups().join("status.json");
        if !status_file.exists() {
            std::fs::write(&status_file, "{\"status\":\"not_configured\",\"configured\":false}\n")?;
        }

        self.set(Phase::Database, "Starting the database…");
        self.init_cluster()?;
        self.start_postgres(ports)?;
        self.bootstrap_roles(ports)?;

        self.set(Phase::Migrating, "Updating the database schema…");
        proc::run(l, "migrate", self.node("api-cli", ports, &["migrate"]), None)?;

        self.start_services(ports)?;
        self.owner(ports)
    }

    // ------------------------------------------------------------------ PostgreSQL

    fn pg_ctl(&self) -> std::process::Command {
        proc::command(&self.layout.pg_bin("pg_ctl"))
    }

    fn init_cluster(&self) -> Result<()> {
        let l = &self.layout;
        let pgdata = l.pgdata();
        if pgdata.join("PG_VERSION").exists() {
            return Ok(());
        }
        // A folder without PG_VERSION is an interrupted first start: nothing was ever stored in it.
        if pgdata.exists() {
            std::fs::remove_dir_all(&pgdata).with_context(|| format!("cannot reset {}", pgdata.display()))?;
        }
        self.set(Phase::Database, "Creating the database (first start)…");
        let mut cmd = proc::command(&l.pg_bin("initdb"));
        cmd.arg("-D").arg(&pgdata)
            .args(["-U", "postgres", "-A", "scram-sha-256", "--data-checksums", "-E", "UTF8", "--locale=C", "--no-instructions"])
            .arg(format!("--pwfile={}", l.secret("pg_superuser_password").display()));
        proc::run(l, "initdb", cmd, None)?;
        Ok(())
    }

    fn start_postgres(&self, ports: Ports) -> Result<()> {
        let l = &self.layout;
        let mut status = self.pg_ctl();
        status.arg("status").arg("-D").arg(l.pgdata());
        let running = status.output().map(|o| o.status.success()).unwrap_or(false);
        if running && port_open(ports.postgres) {
            return Ok(());
        }
        if port_open(ports.postgres) {
            bail!("port {} is already used by another program; quit it or remove {} to choose new ports", ports.postgres, l.state().join("desktop-ports.json").display());
        }
        let opts = format!(
            "-p {} -c listen_addresses=127.0.0.1 -c shared_buffers=256MB -c max_connections=80 -c jit=off -c log_min_messages=warning -c log_statement=none",
            ports.postgres
        );
        let mut cmd = self.pg_ctl();
        cmd.arg("start").arg("-D").arg(l.pgdata())
            .arg("-l").arg(l.process_logs().join("postgres.log"))
            .args(["-w", "-t", "120", "-o", &opts]);
        proc::run(l, "pg_ctl", cmd, None)?;
        Ok(())
    }

    fn psql(&self, ports: Ports, db: &str) -> Result<std::process::Command> {
        let mut cmd = proc::command(&self.layout.pg_bin("psql"));
        cmd.args(["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", &ports.postgres.to_string(), "-U", "postgres", "-d", db])
            .env("PGPASSWORD", secrets::read(&self.layout, "pg_superuser_password")?);
        Ok(cmd)
    }

    /// Database, roles and role passwords. Idempotent; runs on every start like `./blackbox`.
    fn bootstrap_roles(&self, ports: Ports) -> Result<()> {
        let l = &self.layout;
        let mut exists = self.psql(ports, "postgres")?;
        exists.args(["-At", "-c", &format!("SELECT 1 FROM pg_database WHERE datname = '{DB}'")]);
        let out = proc::run(l, "bootstrap", exists, None)?;
        if String::from_utf8_lossy(&out.stdout).trim() != "1" {
            let mut create = self.psql(ports, "postgres")?;
            create.args(["-c", &format!("CREATE DATABASE {DB}")]);
            proc::run(l, "bootstrap", create, None)?;
        }
        let mut roles = self.psql(ports, DB)?;
        roles.arg("-f").arg(l.migrations().join("0000_roles.sql"));
        proc::run(l, "bootstrap", roles, None)?;
        // Generated passwords are alphanumeric, so they need no quoting. Sent on stdin, never as arguments.
        let mut sql = String::new();
        for r in secrets::ROLES {
            sql.push_str(&format!("ALTER ROLE bb_{r} PASSWORD '{}';\n", secrets::read(l, &format!("pg_{r}_password"))?));
        }
        sql.push_str(&format!("GRANT CONNECT ON DATABASE {DB} TO bb_migrate, bb_api, bb_worker, bb_engine;\n"));
        sql.push_str(&format!("ALTER DATABASE {DB} OWNER TO bb_migrate;\n"));
        proc::run(l, "bootstrap", self.psql(ports, DB)?, Some(&sql))?;
        Ok(())
    }

    // ------------------------------------------------------------------ services

    fn common_env(&self, cmd: &mut std::process::Command, ports: Ports) {
        let l = &self.layout;
        let version = self.status.lock().unwrap().version.clone();
        let sep = if cfg!(windows) { ";" } else { ":" };
        cmd.env("BLACKBOX_VERSION", version)
            .env("PGHOST", "127.0.0.1")
            .env("PGPORT", ports.postgres.to_string())
            .env("PGDATABASE", DB)
            .env("ENGINE_URL", format!("http://127.0.0.1:{}", ports.engine))
            .env("ENGINE_TOKEN_FILE", l.secret("engine_token"))
            .env("DATA_KEY_FILE", l.secret("data.key"))
            .env("SECRETS_DIR", l.secrets())
            .env("LOG_DIR", l.logs())
            .env("LOGS_DIR", l.logs())
            .env("EVIDENCE_DIR", l.evidence())
            .env("SNAPSHOT_DIR", l.snapshots())
            .env("BACKUP_STATUS_FILE", l.backups().join("status.json"))
            .env("FENCE_DIR", l.state())
            .env("BLACKBOX_REPO_ROOT", l.app())
            .env("STORAGE_PATHS", format!("{}{sep}{}", l.evidence().display(), l.logs().display()))
            .env("LOG_LEVEL", "info")
            .env("TZ", "UTC")
            .env("NODE_ENV", "production");
    }

    fn role(&self, cmd: &mut std::process::Command, role: &str) {
        cmd.env("PGUSER", format!("bb_{role}"))
            .env("PGPASSWORD_FILE", self.layout.secret(&format!("pg_{role}_password")));
    }

    /// `node <service>.mjs args…` with the API's environment (the CLI shares the API configuration).
    fn node(&self, service: &str, ports: Ports, args: &[&str]) -> std::process::Command {
        let l = &self.layout;
        let mut cmd = proc::command(&l.node());
        cmd.arg(l.service(service)).args(args).current_dir(l.app());
        self.common_env(&mut cmd, ports);
        if service == "worker" {
            self.role(&mut cmd, "worker");
        } else {
            self.role(&mut cmd, "api");
            cmd.env("HOST", "127.0.0.1")
                .env("PORT", ports.api.to_string())
                .env("BLACKBOX_PUBLIC_PORT", ports.api.to_string())
                .env("PGMIGRATE_USER", "bb_migrate")
                .env("PGMIGRATE_PASSWORD_FILE", l.secret("pg_migrate_password"))
                .env("MIGRATIONS_DIR", l.migrations())
                .env("WEB_DIST_DIR", l.app().join("web"))
                .env("LANDING_DIST_DIR", l.app().join("landing"));
        }
        cmd
    }

    fn spawn(&self, name: &'static str, ports: Ports) -> Result<Child> {
        let l = &self.layout;
        let mut cmd = match name {
            "engine" => {
                let mut c = proc::command(&l.engine());
                self.common_env(&mut c, ports);
                self.role(&mut c, "engine");
                c.env("ENGINE_LISTEN", format!("127.0.0.1:{}", ports.engine))
                    .env("ENGINE_RSS_TARGET_MB", "1024")
                    .current_dir(&l.data);
                c
            }
            "api" => self.node("api-server", ports, &[]),
            "worker" => self.node("worker", ports, &[]),
            _ => unreachable!(),
        };
        proc::log_to(l, name, &mut cmd)?;
        cmd.spawn().with_context(|| format!("cannot start the {name}"))
    }

    fn start_services(&self, ports: Ports) -> Result<()> {
        self.set(Phase::Services, "Starting the engine, API and worker…");
        for (name, port) in [("engine", Some(ports.engine)), ("api", Some(ports.api)), ("worker", None)] {
            if let Some(p) = port {
                if port_open(p) {
                    bail!("port {p} for the {name} is already used by another program");
                }
            }
            let child = self.spawn(name, ports)?;
            self.services.lock().unwrap().push(Service { name, child, restarts: Vec::new() });
        }
        self.save_pids();
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if proc::http_status(ports.api, "/api/health") == Some(200) {
                break;
            }
            for s in self.services.lock().unwrap().iter_mut() {
                if let Ok(Some(code)) = s.child.try_wait() {
                    bail!("the {} stopped during start ({code}); see {}", s.name, self.layout.process_logs().join(format!("{}.log", s.name)).display());
                }
            }
            if Instant::now() > deadline {
                bail!("the API did not become ready within 2 minutes; see {}", self.layout.process_logs().display());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        self.status.lock().unwrap().api_url = Some(format!("http://127.0.0.1:{}/", ports.api));
        Ok(())
    }

    fn save_pids(&self) {
        let pids: Vec<u32> = self.services.lock().unwrap().iter().map(|s| s.child.id()).collect();
        proc::save_pids(&self.layout, &pids);
    }

    fn owner_marker(&self) -> PathBuf {
        self.layout.state().join("desktop-owner.json")
    }

    /// First start: creates the workspace and owner and shows the key once. Later starts go straight on.
    fn owner(&self, ports: Ports) -> Result<()> {
        if self.owner_marker().exists() {
            self.set(Phase::Ready, "Blackbox is running.");
            return Ok(());
        }
        let out = proc::run(&self.layout, "setup", self.node("api-cli", ports, &["setup", "--json"]), None)?;
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).context("unexpected output from setup")?;
        match v["status"].as_str() {
            Some("created") => {
                self.status.lock().unwrap().owner_key = v["key"].as_str().map(str::to_string);
                self.set(Phase::OwnerKey, "Save your personal access key.");
            }
            // The owner exists but this app never confirmed that its key was saved (e.g. closed early).
            _ => self.set(Phase::OwnerKeyMissing, "Your workspace exists, but the access key was not confirmed as saved."),
        }
        Ok(())
    }

    /// The user confirmed the key is saved: forget it and continue.
    pub fn owner_key_saved(&self) -> Result<()> {
        std::fs::write(self.owner_marker(), "{\"confirmed\":true}\n")?;
        self.status.lock().unwrap().owner_key = None;
        self.set(Phase::Ready, "Blackbox is running.");
        Ok(())
    }

    /// Issues a new owner key and revokes all sessions and agent keys (`reset-access`). Business data stays.
    pub fn reset_access(&self) -> Result<()> {
        let ports = self.ports.lock().unwrap().context("Blackbox is not running")?;
        let out = proc::run(&self.layout, "reset-access", self.node("api-cli", ports, &["reset-access", "--yes", "--json"]), None)?;
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).context("unexpected output from reset-access")?;
        let key = v["key"].as_str().context("reset-access returned no key")?.to_string();
        let _ = std::fs::remove_file(self.owner_marker());
        self.status.lock().unwrap().owner_key = Some(key);
        self.set(Phase::OwnerKey, "Save your new personal access key.");
        Ok(())
    }

    // ------------------------------------------------------------------ running

    fn monitor(self: Arc<Self>, generation: u64) {
        let mut last_pg_check = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if self.stopping.load(Ordering::SeqCst) || self.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let Some(ports) = *self.ports.lock().unwrap() else { return };
            let mut failed: Option<String> = None;
            {
                let mut services = self.services.lock().unwrap();
                for s in services.iter_mut() {
                    let Ok(Some(code)) = s.child.try_wait() else { continue };
                    s.restarts.retain(|t| t.elapsed() < Duration::from_secs(120));
                    proc::note(&self.layout, &format!("{} exited ({code}); restarts in the last 2 min: {}", s.name, s.restarts.len()));
                    if s.restarts.len() >= 5 {
                        failed = Some(format!("the {} keeps stopping; see {}", s.name, self.layout.process_logs().join(format!("{}.log", s.name)).display()));
                        break;
                    }
                    std::thread::sleep(Duration::from_secs(2));
                    match self.spawn(s.name, ports) {
                        Ok(child) => {
                            s.child = child;
                            s.restarts.push(Instant::now());
                        }
                        Err(e) => {
                            failed = Some(format!("{e:#}"));
                            break;
                        }
                    }
                }
            }
            self.save_pids();
            if failed.is_none() && last_pg_check.elapsed() > Duration::from_secs(5) {
                last_pg_check = Instant::now();
                if !port_open(ports.postgres) {
                    proc::note(&self.layout, "PostgreSQL is not reachable; restarting it");
                    if let Err(e) = self.start_postgres(ports) {
                        failed = Some(format!("the database stopped and could not be restarted: {e:#}"));
                    }
                }
            }
            if let Some(msg) = failed {
                self.stop_services();
                self.fail(&anyhow::anyhow!(msg));
                return;
            }
        }
    }

    fn stop_services(&self) {
        let mut services = std::mem::take(&mut *self.services.lock().unwrap());
        // Reverse start order: worker, API, engine.
        for s in services.iter_mut().rev() {
            proc::terminate(&mut s.child, Duration::from_secs(if s.name == "worker" { 30 } else { 15 }));
        }
        proc::save_pids(&self.layout, &[]);
    }

    /// Stops services and the database. Blocks until done (used on quit).
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let _guard = self.busy.lock().unwrap();
        if self.status().phase == Phase::Stopped {
            return;
        }
        self.set(Phase::Stopping, "Stopping Blackbox…");
        self.stop_services();
        if self.layout.pgdata().join("postmaster.pid").exists() {
            let mut cmd = self.pg_ctl();
            cmd.arg("stop").arg("-D").arg(self.layout.pgdata()).args(["-m", "fast", "-w", "-t", "60"]);
            if let Err(e) = proc::run(&self.layout, "pg_ctl", cmd, None) {
                proc::note(&self.layout, &format!("pg_ctl stop: {e:#}"));
            }
        }
        self.set(Phase::Stopped, "Blackbox is stopped.");
    }

    /// Restarts engine, API and worker (the database keeps running).
    pub fn restart(self: &Arc<Self>) {
        let me = self.clone();
        std::thread::spawn(move || {
            me.stopping.store(true, Ordering::SeqCst);
            let _guard = me.busy.lock().unwrap();
            me.set(Phase::Restarting, "Restarting services…");
            me.stop_services();
            drop(_guard);
            me.start();
        });
    }
}
