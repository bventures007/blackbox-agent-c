//! Process helpers shared by the supervisor: a clean environment for every child, log files,
//! graceful termination and cleanup of children left behind by a crashed app.

use anyhow::{bail, Context, Result};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use crate::layout::Layout;

/// Variables passed through from the user's environment. Everything else is dropped so that a
/// DATABASE_URL, PGPASSWORD or NODE_OPTIONS in the user's shell can never leak into the services.
const PASS_THROUGH: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
    "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
];

pub fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.env_clear();
    for k in PASS_THROUGH {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
    // Stable, locale-independent output from the PostgreSQL tools.
    cmd.env("LC_ALL", "C").env("LANG", "C");
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Appends a child's stdout and stderr to `logs/desktop/<name>.log` (truncated above 10 MiB at start).
pub fn log_to(layout: &Layout, name: &str, cmd: &mut Command) -> Result<()> {
    let path = layout.process_logs().join(format!("{name}.log"));
    if std::fs::metadata(&path).map(|m| m.len() > 10 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let out = OpenOptions::new().create(true).append(true).open(&path).with_context(|| format!("cannot open {}", path.display()))?;
    let err = out.try_clone()?;
    cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
    Ok(())
}

pub fn note(layout: &Layout, line: &str) {
    let path = layout.process_logs().join("supervisor.log");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {line}", chrono_like_now());
    }
}

/// UTC timestamp (RFC 3339, seconds) without a date library.
fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Runs a short-lived command to completion. stdout is returned, stderr goes to the named log.
pub fn run(layout: &Layout, name: &str, mut cmd: Command, stdin: Option<&str>) -> Result<Output> {
    let path = layout.process_logs().join(format!("{name}.log"));
    let err = OpenOptions::new().create(true).append(true).open(&path)?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::from(err));
    if stdin.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd.spawn().with_context(|| format!("cannot start {name}"))?;
    if let Some(input) = stdin {
        let mut pipe = child.stdin.take().expect("stdin piped");
        pipe.write_all(input.as_bytes())?;
    }
    let out = child.wait_with_output()?;
    if !out.status.success() {
        bail!("{name} failed ({}); see {}", out.status, path.display());
    }
    Ok(out)
}

/// Asks a child to stop (SIGTERM on macOS; Windows has no equivalent for console-less children, so
/// it is terminated directly) and kills it after `grace`.
pub fn terminate(child: &mut Child, grace: Duration) {
    if let Ok(Some(_)) = child.try_wait() {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Remembers the PIDs of running services so a later start can stop leftovers after a crash.
pub fn save_pids(layout: &Layout, pids: &[u32]) {
    let _ = std::fs::write(layout.state().join("desktop-pids.json"), serde_json::to_string(pids).unwrap_or_default());
}

/// Stops services left behind by a previous app instance that crashed or was force-quit. A PID is
/// only killed when that process still runs a program from this app's runtime folder, so a reused
/// PID belonging to something else is never touched.
pub fn stop_leftovers(layout: &Layout) {
    let file = layout.state().join("desktop-pids.json");
    let Ok(raw) = std::fs::read_to_string(&file) else { return };
    let pids: Vec<u32> = serde_json::from_str(&raw).unwrap_or_default();
    let runtime = layout.runtime.to_string_lossy().to_lowercase();
    let ours: Vec<u32> = pids
        .into_iter()
        .filter(|pid| command_line(*pid).is_some_and(|c| c.to_lowercase().contains(&runtime)))
        .collect();
    if !ours.is_empty() {
        note(layout, &format!("stopping leftover processes {ours:?}"));
        kill_pids(&ours);
    }
    let _ = std::fs::remove_file(file);
}

#[cfg(unix)]
fn command_line(pid: u32) -> Option<String> {
    let out = Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

#[cfg(windows)]
fn command_line(pid: u32) -> Option<String> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &format!("(Get-Process -Id {pid} -ErrorAction SilentlyContinue).Path")]);
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// SIGTERM to all, up to 10 s to exit, then SIGKILL for any that are still alive.
#[cfg(unix)]
fn kill_pids(pids: &[u32]) {
    let alive = |pid: u32| unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };
    for &pid in pids {
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && pids.iter().any(|&p| alive(p)) {
        std::thread::sleep(Duration::from_millis(100));
    }
    for &pid in pids.iter().filter(|&&p| alive(p)) {
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
fn kill_pids(pids: &[u32]) {
    use std::os::windows::process::CommandExt;
    for pid in pids {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).creation_flags(0x0800_0000).output();
    }
}

/// Minimal HTTP GET against a loopback port; returns the status code.
pub fn http_status(port: u16, path: &str) -> Option<u16> {
    use std::io::Read;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").ok()?;
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).ok()?;
    let head = String::from_utf8_lossy(&buf[..n]);
    head.split_whitespace().nth(1)?.parse().ok()
}
