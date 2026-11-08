# Blackbox desktop app

A native desktop app for macOS (Apple Silicon) and Windows (x64) that runs the complete local pilot **without Docker**. Start the app and it brings up PostgreSQL, the Rust engine, the API and the worker as ordinary child processes, then shows the existing Blackbox web UI in its own window. Quit the app and everything stops.

The business code is unchanged: the same TypeScript API and worker, the same Rust engine, the same migrations. The app replaces only what Docker Compose and `./blackbox` do: processes, ports, secrets, the database bootstrap and restarts.

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Blackbox.app / Blackbox.exe   (Tauri, Rust: apps/desktop/src-tauri)        │
│ window: status page (ui/) → Blackbox web UI on http://127.0.0.1:<api>      │
│ tray / menu bar: open · restart services · logs · data folder · quit       │
│                                                                            │
│ supervisor ── starts, watches and restarts ──┐                             │
└──────────────────────────────────────────────┼─────────────────────────────┘
          ┌───────────────┬───────────────┬────┴──────────┬────────────────┐
          ▼               ▼               ▼               ▼                │
   PostgreSQL 16     engine (Rust)    API (Node)     worker (Node)          │
   127.0.0.1:19281   127.0.0.1:19282  127.0.0.1:19280  no listener          │
   bundled binaries  blackbox-engine  api-server.mjs   worker.mjs           │
```

## What happens when the app starts

1. Checks that the bundle is complete and stops services left behind by a crashed earlier run.
2. First start only: generates the installation secrets (database role passwords, engine token, data/anchor keys) and creates the database cluster with `initdb` (scram-sha-256, data checksums).
3. Starts PostgreSQL on 127.0.0.1, creates the database and the non-owner, non-BYPASSRLS roles from `0000_roles.sql`, then runs the migrations.
4. Starts engine, API and worker and waits for `/api/health`.
5. First start only: creates the workspace and owner and shows the personal access key **once**. The app continues only after you confirm that it is saved.
6. Switches the window to the Blackbox web UI.

A service that crashes is restarted (up to 5 times in 2 minutes; after that the status page shows the error and a link to the logs). Closing the window keeps Blackbox running in the tray / menu bar; **Quit** stops worker → API → engine, then PostgreSQL (`pg_ctl stop -m fast`). SIGTERM, SIGINT and SIGHUP quit the same way.

Measured on an M3 MacBook (release build, empty data folder): first start including `initdb` about 2 seconds; resident memory about 15 MB PostgreSQL, 10 MB engine, 95 MB API, 80 MB worker. The golden scenario (`demo` + `verify`) passes against the desktop install.

## Where data lives

| | macOS | Windows |
| --- | --- | --- |
| Data (database, secrets, evidence, logs) | `~/Library/Application Support/app.blackbox.desktop` | `%LOCALAPPDATA%\app.blackbox.desktop` |
| Process logs | `<data>/logs/desktop/*.log` | same |
| Ports | `<data>/state/desktop-ports.json` (chosen once, near 19280) | same |

The ports default to 19280–19282, so the app can run next to a Docker install on 19180. Deleting the data folder resets the app completely, **including all business data**.

## Build it

Prerequisites: Node.js 22+, pnpm, Rust (the toolchain in `src-tauri/rust-toolchain.toml` is installed automatically by rustup); on Windows additionally the MSVC build tools and WebView2 (preinstalled on Windows 11).

```bash
pnpm install
cd apps/desktop
node scripts/fetch-runtime.mjs   # PostgreSQL 16 + Node.js 22 for this machine, SHA-256 verified
node scripts/stage-app.mjs       # builds the workspace, bundles API/worker/MCP, builds the engine
pnpm exec tauri build            # → src-tauri/target/release/bundle/{dmg,macos,nsis}
```

For a development run against a throwaway data folder:

```bash
cd apps/desktop/src-tauri && cargo build && BLACKBOX_DESKTOP_DATA=/tmp/bb-desktop ./target/debug/blackbox-desktop
```

`BLACKBOX_DESKTOP_RUNTIME` points the app at a different `runtime/` folder.

### Windows

The same code builds for Windows; only the runtime downloads (`--target win32-x64`) and the installer type (NSIS, per-user, no admin rights) differ. The Rust engine has to be compiled on Windows itself. The workflow [.github/workflows/desktop.yml](../../.github/workflows/desktop.yml) builds the macOS `.dmg` and the Windows `.exe` installer in parallel (manual run or a `desktop-v*` tag) and uploads both as build artifacts.

## Connecting an AI client (MCP)

Create a named read-only agent key in the web UI (Agents view), save it to a file, then configure the client with the bridge that ships inside the app:

```json
{
  "mcpServers": {
    "blackbox": {
      "command": "/Applications/Blackbox.app/Contents/Resources/runtime/node/node",
      "args": ["/Applications/Blackbox.app/Contents/Resources/runtime/app/services/mcp.mjs"],
      "env": { "BLACKBOX_API_URL": "http://127.0.0.1:19280", "BLACKBOX_AGENT_KEY_FILE": "/path/to/agent-key" }
    }
  }
}
```

## Status and known gaps

- **Tested:** macOS arm64 debug and release builds: first start, restart with an existing database, cleanup after a crash, shutdown on SIGTERM, owner-key flow, golden scenario.
- **Not yet tested:** Windows. The code paths exist (no-console processes, `taskkill`, `;` path lists, NSIS), but no Windows build has been run yet.
- **Unsigned:** macOS Gatekeeper and Windows SmartScreen warn on first open. Distribution needs an Apple Developer ID with notarization and a Windows code-signing certificate.
- **Backups:** the scheduled encrypted backups of the Docker install (`backup-scheduler`, `age`) are not wired into the app yet; `pg_dump` is bundled for that.
- **Upgrades:** migrations run on every start, so app updates within PostgreSQL 16 work. A future PostgreSQL major version needs a `pg_upgrade` step.
- **Docker install unchanged:** `./blackbox` and Compose keep working as before; the two installs do not share data.
