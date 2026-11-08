//! Where everything lives on disk.
//!
//! * `runtime/` (read-only, inside the app bundle): PostgreSQL, Node.js, the engine binary and the
//!   staged JavaScript services, contracts and migrations (see apps/desktop/scripts/stage-app.mjs).
//! * data directory (per OS user, writable): the PostgreSQL cluster, secrets, logs, evidence,
//!   snapshots and state. macOS: ~/Library/Application Support/app.blackbox.desktop,
//!   Windows: %LOCALAPPDATA%\app.blackbox.desktop.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::{Path, PathBuf};

pub const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

#[derive(Clone, Debug)]
pub struct Layout {
    pub runtime: PathBuf,
    pub data: PathBuf,
}

/// Loopback ports, chosen once on first start and then kept: the browser session cookie and any
/// configured MCP client depend on the API port staying the same.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Ports {
    pub api: u16,
    pub postgres: u16,
    pub engine: u16,
}

impl Layout {
    pub fn new(runtime: PathBuf, data: PathBuf) -> Self {
        Self { runtime, data }
    }

    pub fn pg_bin(&self, name: &str) -> PathBuf {
        self.runtime.join("postgres").join("bin").join(format!("{name}{EXE}"))
    }
    pub fn node(&self) -> PathBuf {
        self.runtime.join("node").join(format!("node{EXE}"))
    }
    pub fn engine(&self) -> PathBuf {
        self.runtime.join("engine").join(format!("blackbox-engine{EXE}"))
    }
    pub fn app(&self) -> PathBuf {
        self.runtime.join("app")
    }
    pub fn service(&self, name: &str) -> PathBuf {
        self.app().join("services").join(format!("{name}.mjs"))
    }
    pub fn migrations(&self) -> PathBuf {
        self.app().join("migrations")
    }

    pub fn pgdata(&self) -> PathBuf {
        self.data.join("pgdata")
    }
    pub fn secrets(&self) -> PathBuf {
        self.data.join("secrets")
    }
    pub fn secret(&self, name: &str) -> PathBuf {
        self.secrets().join(name)
    }
    pub fn logs(&self) -> PathBuf {
        self.data.join("logs")
    }
    /// stdout/stderr of the supervised processes (the services' structured logs go to `logs/`).
    pub fn process_logs(&self) -> PathBuf {
        self.logs().join("desktop")
    }
    pub fn evidence(&self) -> PathBuf {
        self.data.join("evidence")
    }
    pub fn snapshots(&self) -> PathBuf {
        self.data.join("snapshots")
    }
    pub fn backups(&self) -> PathBuf {
        self.data.join("backups")
    }
    pub fn state(&self) -> PathBuf {
        self.data.join("state")
    }

    /// Checks that the bundle carries everything the supervisor starts.
    pub fn check_runtime(&self) -> Result<()> {
        for p in [
            self.pg_bin("initdb"),
            self.pg_bin("pg_ctl"),
            self.pg_bin("postgres"),
            self.pg_bin("psql"),
            self.node(),
            self.engine(),
            self.service("api-server"),
            self.service("api-cli"),
            self.service("worker"),
            self.migrations().join("0000_roles.sql"),
        ] {
            if !p.exists() {
                bail!("the app bundle is incomplete: {} is missing", p.display());
            }
        }
        Ok(())
    }

    pub fn create_dirs(&self) -> Result<()> {
        for d in [
            self.data.clone(),
            self.logs(),
            self.process_logs(),
            self.evidence(),
            self.snapshots(),
            self.backups(),
            self.state(),
            self.data.join("restore"),
        ] {
            std::fs::create_dir_all(&d).with_context(|| format!("cannot create {}", d.display()))?;
        }
        crate::secrets::create_private_dir(&self.secrets())?;
        Ok(())
    }

    /// Ports from state/desktop-ports.json, or free ones near the defaults on first start.
    pub fn ports(&self) -> Result<Ports> {
        let file = self.state().join("desktop-ports.json");
        if let Ok(raw) = std::fs::read_to_string(&file) {
            if let Ok(p) = serde_json::from_str::<Ports>(&raw) {
                return Ok(p);
            }
        }
        // Defaults sit next to (not on) the Docker install's 19180 so both can run side by side.
        let mut taken = Vec::new();
        let api = free_port(19280, &mut taken)?;
        let postgres = free_port(19281, &mut taken)?;
        let engine = free_port(19282, &mut taken)?;
        let p = Ports { api, postgres, engine };
        std::fs::write(&file, serde_json::to_string_pretty(&p)? + "\n")?;
        Ok(p)
    }
}

fn free_port(preferred: u16, taken: &mut Vec<u16>) -> Result<u16> {
    for port in (preferred..preferred.saturating_add(200)).step_by(3) {
        if taken.contains(&port) {
            continue;
        }
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            taken.push(port);
            return Ok(port);
        }
    }
    bail!("no free loopback port near {preferred}")
}

pub fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(300),
    )
    .is_ok()
}

pub fn display(p: &Path) -> String {
    p.display().to_string()
}
