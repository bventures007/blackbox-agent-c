# Build environment

Observed at implementation start (2026-11-01). No secrets or tokens.

| Item | Observed value |
| --- | --- |
| Assigned repository | github.com/bventures007/blackbox-agent-c (branch main) |
| Agent/model and version | Claude Code (Claude Fable 5.1, model id claude-fable-5-1), autonomous /goal run |
| Start commit | 629da21 "Specify pilot recovery, operational safeguards and early persisted slice" (baseline-v14) |
| OS, CPU architecture, available CPU/RAM | macOS 27.2 (Darwin 27.2.0), Apple Silicon arm64, see `sysctl` record in reports/checkpoint.md |
| Node and pnpm versions | Node v25.9.0, pnpm (Homebrew), npm bundled |
| Rust toolchain | cargo/rustc 1.83.0 (Homebrew-independent rustup install) |
| Python | 3.13.3 (for preparation validators only) |
| Docker/Compose availability | Docker Desktop 27.3.1, Compose v2.30.3 (desktop-linux context) |
| PostgreSQL integration-test availability | Through Compose only (no host psql); tests run against the Compose PostgreSQL 16 service |
| Browser/E2E availability | Playwright (Chromium) installed per project; Claude desktop built-in browser used for manual screen comparison |
| Network/package registry access | npm registry, crates.io and Docker Hub reachable; no private registry |
| Execution limits set by owner | Compose project `blackbox-agent-c`, host ports 127.0.0.1:19180-19189 only, own volumes/secrets, stop after P4 handover, max 80 agent turns |
| Provider sandbox/live capabilities | No Shopify store, Shopify Payments account or merchant credentials available in this environment (SLICE-02/live rows blocked_external) |
| Real Mac/Linux host verification | This Apple Silicon Mac; "fresh install" means a fresh folder on the same machine (recorded honestly in reports) |
| MCP client(s) available | @modelcontextprotocol/sdk client (protocol tests) and @modelcontextprotocol/inspector CLI as an independent local client |
| Runtime isolation: ports/Compose project/volumes | Compose project `blackbox-agent-c`; web/API 127.0.0.1:19180; landing test host 127.0.0.1:19181; provider fixture 127.0.0.1:19182; PostgreSQL/engine not published |

Intended versus actual: every row above was observed on this host. Missing host capability (a second physical Mac, provider accounts) is a test limitation recorded as blocked_external, never invented.
