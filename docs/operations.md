# Operations: wrapper, Compose release, backups, restore, upgrade

Engineering reference for the host wrapper `blackbox` (repo: `scripts/blackbox`; archive: `<install>/blackbox`), the versioned Compose release and the recovery procedures required by `specs/PILOT-OPERATIONS-AND-RECOVERY.md`, `specs/WEB-DESKTOP-AND-DEPLOYMENT.md`, `specs/SYSTEM-AND-DIAGNOSTICS.md` and ADR-0002/0005/0006. User-facing steps live in `INSTALL.en.md` / `INSTALL.de.md`.

## Commands and exit codes

| Command | What it does | Exit codes |
| --- | --- | --- |
| `doctor [--json]` | Checks arch (arm64), macOS, Docker daemon + Compose v2, openssl/curl, free disk (warn < max(10 %, 5 GiB), critical < max(2 %, 1 GiB)), loopback bind, port 19180 free or owned by the api container, secrets dir 0700 / files 0600 and complete, data dirs writable, release images present, service state, api health, fence, backup state, installed vs release version, interrupted upgrade. Never installs, repairs or resets. | 0 ok, 1 degraded, 2 failure |
| `setup [--port N] [--project name]` | Refuses if `.env`/`secrets` exist. Creates `secrets/` (0700; CSPRNG via `openssl rand`), `data/{logs,evidence,snapshots,backups,state,restore}`, `.env`; loads `images/*.tar` (release) or builds from source (checkout fallback); starts PostgreSQL; bootstraps roles (`0000_roles.sql`, passwords via stdin, never argv); applies migrations; starts services; runs `api cli setup` with the TTY attached so the owner key is shown once. Phases only go to `logs/setup.log`. | 0, 1 (already set up / owner setup failed), 2 |
| `up` / `down` / `status` | Compose up (detached, waits for api health) / stop (volumes kept) / state summary with fence, backup and upgrade state. | 0/1/2 |
| `destroy --i-understand` | Removes containers, the `pgdata` volume and `data/` after the typed phrase `destroy <project>`. Secrets and `.env` stay. | 2 without flag/phrase |
| `logs [...]` | Delegates to `api cli logs` run in a one-off container with the host-mounted `data/logs` (works while api/postgres are down; needs Docker). Without the api image, a coarse bash fallback (`--level`, `--component`, `--follow`) over `records-*.jsonl` is used and labeled as such. | 0, 1 (no files) |
| `diagnostics export --since 1h --output <file>` | `api cli diagnostics export`, explicit local file, no upload. | 0/1/2 |
| `demo` | `api cli demo` inside the container (host-authorized exec; loads the labeled GOLDEN scenario into demo connections only through the replay ingestion path). | 0/1/2 |
| `verify` | api health, migrations current (every `migrations/*.sql` recorded in `schema_migrations(version, checksum, applied_at)` — the same table the api CLI migrator writes), engine/worker running, `api cli verify` (golden order #1001: physical/available stock 112, captured 11900, fees 350, refunded 2380, bank-confirmed 9170 through the engine's latest_committed barrier; exit 0 only on an exact match). | 0 ok, 1 warnings, 2 failure |
| `backup-config <dir> [--label text]` | Enrolls a destination: writes `.blackbox-backup-destination` (install id, label, same-device flag), generates the age X25519 recovery identity in the backup container, verifies an encrypt/decrypt round trip, stores only the recipient (`secrets/backup_recipient.pub`), prints the secret identity once, sets `BLACKBOX_BACKUP_DESTINATION` in `.env`, initializes `data/backups/status.json`. Refuses destinations inside `data/` or `secrets/`. | 0/2 |
| `backup [--kind manual\|pre-upgrade]` | Fenced generation (see below). Refuses when not configured, destination unmounted/unenrolled, recipient missing, postgres down or another fence active. | 0, 1 (precondition), 2 |
| `restore <file.tar.age> [--into dir] [--port N] [--project name]` | Host-only. Recovery identity from `BLACKBOX_RECOVERY_KEY_FILE` or a hidden interactive prompt — never argv. Default: fresh isolated installation beside the release dir (`blackbox-restore-<ts>`, port 19184, project `<project>-restore-<ts>`). | 0/1/2 |
| `restore <file> --replace` | Previews pgdata volume, data size and the generation, requires the typed phrase `replace <project>`, then destroys the current data and restores in place. | 0/1/2 |
| `resume-sources` | Clears the writer fence and unpauses/starts the worker after a restore/upgrade review. | 0 |
| `upgrade <archive.tar.gz\|dir> [--use-backup <gen>] [--resume]` | Fenced, resumable upgrade (phases below). | 0, 1 (blocked/interrupted), 2 |
| `reset-access` / `rotate-key` / `create-agent-key` | Host-only (secrets dir must be readable/writable by the OS user), delegate to the api CLI with the TTY attached. | 0/1/2 |

`BLACKBOX_BIND` other than `127.0.0.1` is refused everywhere with `public/LAN binding is unsupported` (exit 2). `BLACKBOX_INSTALL_DIR` overrides the install directory (default: release dir; `<repo>/.local` for a checkout so Git stays clean). `BLACKBOX_MIGRATOR=auto|cli|sql` selects the migrator. `BLACKBOX_SERVICES` / `BLACKBOX_BUILD_SERVICES` restrict the started services / built images (test knob for the ops-only round trip while application images are missing).

## File layout (installation directory)

```
<install>/
  blackbox                      wrapper (release) — repo: scripts/blackbox
  infra/compose/docker-compose.yml
  release.json                  compat manifest (checkout: .local/release.json, version "dev")
  images/{api,worker,engine,backup,postgres}.tar   bundled arm64 images (release only)
  migrations/*.sql              (checkout: packages/database/migrations)
  examples/.env.example, INSTALL.en.md, INSTALL.de.md
  .env                          generated, 0600, non-secret config (paths, port, project, version)
  secrets/                      0700; files 0600:
    pg_superuser_password pg_migrate_password pg_api_password pg_worker_password pg_engine_password
    engine_token (hex-64)   data.key (32 raw bytes, AES-256-GCM installation key, ADR-0002)
    backup_recipient.pub (age X25519 recipient; the identity is never stored)
  logs/setup.log                sanitized wrapper phases (no values)
  data/
    logs/      records-*.jsonl (api log collector; readable on the host without containers)
    evidence/  raw evidence objects
    snapshots/ engine snapshots (optional acceleration)
    backups/   status.json (+ unconfigured/ placeholder mount when no destination is enrolled)
    state/     install.json, installed-release.json, writers.paused.json (fence), evidence-access.json,
               upgrade.json, maintenance.lock/, previous-release/<version>/, last-backup-path
    restore/   0700 staging for restore (members stay encrypted; removed at the end)
```

Volumes: `pgdata` is the only named volume (`<project>_pgdata`). Evidence, logs, snapshots, backups, state and restore are bind mounts under `data/` so `logs`/`doctor`/`diagnostics export` work when containers are down. Container UID is 10001 (`blackbox`) for api/worker/engine/backup; PostgreSQL runs as `postgres` inside its container. On Docker Desktop for Mac, bind-mounted files are presented to the container with the host user's ownership mapped, so 0600/0700 host permissions are preserved and readable by the container user.

Networks: `backend` (`internal: true`, no egress: postgres, engine, api, worker, backup, scheduler) and `egress` (api, worker: outbound provider polling). Only `api` publishes a port: `127.0.0.1:${BLACKBOX_PORT}:19180`.

## Container environment contract (integration hooks for apps/api, apps/worker, apps/engine)

Common: `BLACKBOX_VERSION`, `BLACKBOX_BIND=127.0.0.1`, `BLACKBOX_PORT=19180`, `PGHOST=postgres`, `PGPORT=5432`, `PGDATABASE=blackbox`, `PGUSER=bb_api|bb_worker|bb_engine`, `PGPASSWORD_FILE=/run/secrets/pg_*_password`, `ENGINE_URL=http://engine:7070`, `ENGINE_TOKEN_FILE=/run/secrets/engine_token`, `DATA_KEY_FILE=/run/secrets/data.key`, `LOG_DIR=/data/logs`, `EVIDENCE_DIR=/data/evidence`, `SNAPSHOT_DIR=/data/snapshots`, `BACKUP_STATUS_FILE=/data/backups/status.json` (read-only for api/worker), `FENCE_DIR=/data/state` (read-only), `LOG_LEVEL`, `TZ`.
api only: `PGMIGRATE_USER=bb_migrate`, `PGMIGRATE_PASSWORD_FILE=/run/secrets/pg_migrate_password`, `MIGRATIONS_DIR=/migrations`, `WEB_DIST_DIR=/app/apps/web/dist`. Engine: `ENGINE_LISTEN=0.0.0.0:7070`, `RUST_LOG`.

Required behaviors:

- **Fence**: while `/data/state/writers.paused.json` exists (`{reason, since, owner}`), the worker must not run provider polls, outbox dispatch, backups, retention or rebuilds, and the API must answer write routes (`/api/ingest/*`, runs, review actions, settings mutations) with `503 {error:{code:"maintenance", retryable:true}}`. Reads stay available. The wrapper additionally `compose pause`s the worker when it is the fence owner.
- **Evidence block**: while `/data/state/evidence-access.json` has `blocked:true` (written by restore), `/api/evidence/*` content returns `{status:"unavailable", reason:"restore_policy_unreconciled"}` until the owner reconciles the restore cutoff/redaction policy in Settings (API removes the file through its own write path → TODO: the settings handler needs write access; current mounts are read-only, so the reconcile action should go through `./blackbox resume-sources --accept-evidence-policy` or the orchestrator grants api rw on `/data/state`).
- **Migrations**: `node /app/apps/api/dist/cli.js migrate` must use table `schema_migrations(version text primary key, checksum text, applied_at timestamptz)` with `version = <file name without .sql>` and `checksum = sha256(file)`, applying files serially in name order as `bb_migrate` inside one transaction each. The wrapper's SQL fallback (`BLACKBOX_MIGRATOR=sql`) implements exactly this and refuses changed checksums.
- **CLI subcommands the wrapper calls** (all inside the api image, TTY attached unless noted): `setup` (shows owner key once), `reset-access`, `rotate-key`, `create-agent-key`, `logs <filters>` (-T), `diagnostics export --since --output` (-T), `demo` (-T), `verify` (-T; exit 0 when the golden demo answer matches), `migrate` (-T), optional `maintenance-lease acquire|release --reason` (-T; DB advisory lease — the wrapper tolerates its absence).
- **Health**: `GET /api/health` → 200 `{status, version}`; engine binary must accept `--healthcheck` (exit 0 when healthy) because the runtime image has no curl.
- **Backup status**: api reads `/data/backups/status.json` for `GET /api/settings/backups` and the health card: `{status: not_configured|scheduled|running|failed|overdue, configured, destination_label, destination_available, same_device, last_attempt_at, last_attempt_kind, last_completed_at, last_generation, last_generation_path, last_sha256, last_bytes, last_cutoff_at, last_cutoff_committed:[{tenant_id, committed_sequence}], next_due_at, retention:{daily,weekly}, last_error, failures}`. `recoverable_age_seconds = now - last_cutoff_at`. `POST /api/settings/backups/run` cannot run the wrapper; it should write `/data/state/backup-request.json` (requires rw on state — see TODO above) which the scheduler container picks up on its next check (TODO: scheduler currently checks only the 24 h objective).

## Fences and coherence

A backup, restore or upgrade owns exactly one fence at a time (`writers.paused.json` plus `data/state/maintenance.lock/` for upgrades). Backup: fence → `compose pause worker` → `backup.sh` → unpause + clear fence (also on failure via trap). Because the API refuses writes during the fence and the worker is paused, `pg_dump` sees a cutoff that equals the committed high-water marks captured in the manifest; the engine keeps serving reads from RAM.

## Backup format (`blackbox-backup/1`)

`<dest>/blackbox-backup-<UTC ts>.tar.age` = `age -r <recipient>` over a tar containing `manifest.json` (format, generation, created_at, kind, blackbox_version, install_id, postgres_server_version, release versions, applied_migrations, cutoff {committed per tenant, applied per tenant with reducer_version}, redaction_ledger_included, members with sha256/bytes) and members `database.pgc.age` (pg_dump custom format, level 6), `evidence.tar.age`, `snapshots.tar.age`, `keys.tar.age` (data.key, engine_token, runtime role passwords, backup_recipient.pub), `redaction-ledger.json.age` (when the `redaction_ledger` table exists). Members are individually encrypted so the staging directory `<dest>/.staging-<gen>/` never holds plaintext; the outer stream is encrypted again so one file has one checksum. Written to `*.partial`, fsynced, atomically renamed, then a plaintext non-secret sidecar `<gen>.meta.json` (sha256, bytes, cutoff, iso_week, weekly, finalized:true) is published. The superuser password is not included (a restore generates a new one). Nothing writes to a destination without the `.blackbox-backup-destination` marker whose `install_id` matches `data/state/install.json`.

Retention runs only after a new generation is finalized, deletes only finalized generations with this install id, keeps the 7 newest daily and the 4 newest weekly (the first generation of an ISO week is weekly) and never removes the last usable generation. Scheduler: `backup-scheduler` container checks every 10 minutes; one overdue backup when the newest `last_completed_at` is older than 24 h; `status: overdue` after 24 h 30 min; it never replays missed intervals and is idle without an enrolled destination.

## Restore phases

1. host: recovery identity to a 0600 temp file; target dir (fresh by default), new superuser password, `.env`, `install.json` with `restored_from`.
2. container `inspect`: sidecar sha256 and `finalized` check (no key needed); `.partial` refused.
3. container `unpack`: decrypt outer → `data/restore/staging` (members still encrypted), format check, member checksums, compatibility (`backup_format_version` not newer than release, PostgreSQL major not newer), decrypt `keys.tar.age` → `secrets/`, evidence and snapshots → `data/`.
4. host: fence `restore_pending_review`, start postgres (fresh volume), bootstrap roles with the restored passwords.
5. container `database`: `age -d | pg_restore --single-transaction` (streamed; no plaintext dump on disk).
6. host: apply newer migrations; write `evidence-access.json` (blocked until reconciled); remove staging; start engine/api; `api cli reset-access` (new owner key once, all sessions/agent keys revoked); `api cli verify`.
7. Report: machine processing time (unpack/db/start, fence/verify), operator input time, full elapsed. Worker stays paused until `./blackbox resume-sources`.

A wrong identity fails at step 3 with `decryption failed`; losing both the recovery identity and the original install is an honest unrecoverable state (no login reset decrypts anything).

## Upgrade phases (resumable via `data/state/upgrade.json`, which always records the *next* phase to run)

`preflight` (stage the new release, compare `installed-release.json` with the new `release.json`: same PostgreSQL major, `journal_schema_version` present, free space > 2× stage + 1 GiB) → `lease` (`maintenance.lock/` + optional api `maintenance-lease`) → `backup` (`backup --kind pre-upgrade`; failure blocks unless `--use-backup <gen>` names a generation that passes `inspect`) → `pause` (fence + stop worker/api) → `stage-files` (previous release files copied to `data/state/previous-release/<from>/`, new wrapper/compose/release.json/migrations/images/guides copied in, `.env` version/postgres image updated, then `exec` of the new wrapper with `--continue`) → `images` (load) → `migrate` (postgres up, roles, serial migrations) → `start` → `verify` (health/migrations/golden) → `release` (clear fence, start worker, remove lock/stage/phase file). Any failure keeps the fence and the phase file; `./blackbox upgrade --resume` continues from the recorded phase. `doctor` reports an interrupted upgrade.

## Rollback policy per version

`release.json.compatibility.binary_rollback_safe_to` lists the versions to which the image set can be reverted without schema/encryption/event-format change; for every other case the documented route is an **isolated restore** of the pre-upgrade generation (its cutoff is in the manifest and status file; later data is explicitly lost) or a forward fix. Reverting images never reverts a database migration; the wrapper prints this on every upgrade. Previous image tags remain in Docker and previous release files under `data/state/previous-release/<version>/`. Template default: no safe binary rollback declared.

## Secrets and trust boundary

Host-owner trust: anyone with read access to `<install>/secrets` can read the data key; the app does not protect against the OS owner. Recommend FileVault. No secret is placed in argv, Git, logs, URLs, localStorage or Compose environment dumps; passwords reach PostgreSQL through stdin of `psql` inside the container (log_statement=none) and through `*_FILE` secrets at `/run/secrets`. Missing/corrupt keys stop dependent operations (`doctor` DOC-SECRETF) and are never regenerated over existing data.

## Tests

- `tests/ops/wrapper-unit.sh` — syntax (bash 3.2), help/unknown command, bind refusal, doctor on a fresh dir, refusals without setup, manifest checker, compose/dockerfile invariants (no Docker stack).
- `tests/ops/backup-roundtrip.sh [--full]` — real Compose stack: setup → seed two tenants + evidence → refusals (unconfigured, unenrolled destination) → backup-config → two backups → wrong-key restore fails → restore into fresh install (data/evidence/keys identical, new superuser password, fence + evidence block present, staging removed, original untouched) → resume-sources → down/up keeps data → setup refuses overwrite. Ops-only by default; `--full` adds the api CLI paths once the application images exist.
- `tests/ops/upgrade.sh [--full]` — builds two ops-only archives (`build.sh --images backup`), installs 0.0.1 in release mode from the extracted archive, seeds data, enrolls backups, refuses same-version/unknown sources, upgrades to 0.0.2 and checks the pre-upgrade generation, recorded version, `.env`/`release.json`, previous-release copy, released fence/lease/phase file, data intact, loaded image and doctor output. An *interrupted* upgrade (`--resume`) is implemented but not yet covered by an automated test.
- `scripts/release/check-manifest.sh` and `scripts/release/verify-download.sh` for DIST-01..03 (see docs/release.md).

## Known findings (ops verification 2026-11-01)

- `backup-config` while the stack runs: the already running `backup-scheduler` has no destination in its environment and rewrites `data/backups/status.json` to `not_configured` every check until `./blackbox up` recreates it; the status surface is wrong for up to one scheduler interval after enrollment (PILOT-01 finding).
- Refused `upgrade` preflights leave `data/state/upgrade-stage/` behind (harmless; cleaned by the next upgrade).
- `json_get` on a missing key used to abort the wrapper silently under `set -eo pipefail` (a `release.json` without `journal_schema_version` exited 1 without the refusal message); fixed with `|| true`.
- `scripts/blackbox` ships the same `BLACKBOX_PORT` publish for api, but the api image must know the published port for its Host/Origin allowlist (`BLACKBOX_PUBLIC_PORT`, see docs/architecture.md); release 0.1.0-rc6 is unusable on a non-default port.
