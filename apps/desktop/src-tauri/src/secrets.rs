//! Installation secrets, generated once on first start and never overwritten (same set and format as
//! `./blackbox setup`): database role passwords, the engine token and the data/anchor keys.
//! Files are private to the OS user: mode 0700/0600 on macOS; on Windows they live in the user's
//! %LOCALAPPDATA%, which is already restricted to that user.

use anyhow::{Context, Result};
use rand::{distributions::Alphanumeric, Rng, RngCore};
use std::path::Path;

use crate::layout::Layout;

pub const ROLES: [&str; 4] = ["migrate", "api", "worker", "engine"];

pub fn create_private_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("cannot create {}", path.display()))?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes).with_context(|| format!("cannot create {}", path.display()))?;
    }
    Ok(())
}

fn password() -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(44).map(char::from).collect()
}

fn hex32() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Creates every missing secret. Existing files are left untouched.
pub fn ensure(layout: &Layout) -> Result<()> {
    let s = |n: &str| layout.secret(n);
    if !s("pg_superuser_password").exists() {
        write_private(&s("pg_superuser_password"), password().as_bytes())?;
    }
    for r in ROLES {
        let f = s(&format!("pg_{r}_password"));
        if !f.exists() {
            write_private(&f, password().as_bytes())?;
        }
    }
    if !s("engine_token").exists() {
        write_private(&s("engine_token"), hex32().as_bytes())?;
    }
    if !s("data.key").exists() {
        let mut k = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut k);
        write_private(&s("data.key"), &k)?;
    }
    if !s("data.key.version").exists() {
        write_private(&s("data.key.version"), b"1\n")?;
    }
    // Generation 1: the PII anchor root equals the first data key (as in ./blackbox ensure_key_files).
    if !s("anchor.key").exists() {
        let version = std::fs::read_to_string(s("data.key.version")).unwrap_or_default();
        if version.trim() != "1" {
            anyhow::bail!("secrets/anchor.key is missing although the data key was rotated; restore the secrets folder from a backup");
        }
        let k = std::fs::read(s("data.key"))?;
        write_private(&s("anchor.key"), &k)?;
    }
    Ok(())
}

pub fn read(layout: &Layout, name: &str) -> Result<String> {
    Ok(std::fs::read_to_string(layout.secret(name))
        .with_context(|| format!("cannot read secret {name}"))?
        .trim()
        .to_string())
}
