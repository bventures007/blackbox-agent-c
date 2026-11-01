# Blackbox — Installation guide (macOS, Apple Silicon)

Blackbox runs entirely on your Mac: a local web app at `http://127.0.0.1:19180/`, a background worker, a Rust engine and a PostgreSQL database, all inside Docker containers that are reachable only from this Mac. There is no cloud account, no signup and no AI/LLM key required.

What you download is a versioned `.tar.gz` archive with a shell script (`blackbox`), the container configuration and the prebuilt container images. It is **not** a native `.app`/DMG and it is not signed or notarized; you need Docker Desktop. The checksum on the download page detects a corrupted download; it is not a signature.

## 1. Prerequisites (not installed automatically)

- Mac with Apple Silicon (M1 or newer), macOS 14 or newer.
- **Docker Desktop 4.3x or newer** with Compose v2 (`docker compose version`). Install it from docker.com and start it before continuing. Blackbox never installs or modifies Docker or any other global software.
- About 10 GiB of free disk space (images, database, evidence, backups).
- A password manager to store two keys (owner key, backup recovery key).

Nothing listens on your network: only `127.0.0.1:19180` is published. Binding to another address is refused on purpose.

## 2. Download and extract

1. On the download page, click **Download for Mac**. Compare the shown version, date, size and SHA-256 with the file you got:
   ```sh
   shasum -a 256 ~/Downloads/blackbox-<version>-mac-arm64.tar.gz
   ```
2. Extract into a folder you keep (the folder becomes your installation; do not move it later):
   ```sh
   mkdir -p ~/Blackbox && tar -xzf ~/Downloads/blackbox-<version>-mac-arm64.tar.gz -C ~/Blackbox
   cd ~/Blackbox/blackbox-<version>
   ```
   macOS marks browser downloads with a quarantine attribute. A shell script and Docker images are not affected by Gatekeeper the way an app bundle is; you do not need to change any security setting. If Terminal asks whether the script may access folders (Downloads, external volumes), allow it for the folders you use. Never disable macOS security features globally.

## 3. Check prerequisites

```sh
./blackbox doctor
```
Exit code 0 means ready, 1 means something is degraded (read the `→` hints), 2 means a prerequisite is missing. `doctor` never installs or changes anything.

## 4. Set up (once)

```sh
./blackbox setup
```
This creates the configuration and the secret files (`secrets/`, owner-only permissions), loads the bundled images, starts PostgreSQL, runs the database migrations, starts all services and finally shows your **personal owner key** (`bbk_…`) **exactly once** in the Terminal.

**Save the owner key in your password manager now.** It is never written to any file or log. If you lose it, use `./blackbox reset-access` (section 9).

Setup refuses to run on top of an existing installation and never replaces credentials or data. Phases are logged (without any values) to `logs/setup.log`.

## 5. Open the app

Open `http://127.0.0.1:19180/` in your browser and sign in with the owner key. Closing the browser does **not** stop Blackbox: ingestion keeps running in the background as long as Docker is running. Only `./blackbox down`, quitting Docker Desktop or shutting down the Mac stops processing; nothing is processed while the Mac is off or asleep, and work resumes when you start again.

Try the labeled demo data: `./blackbox demo` (it never touches your own data).

## 6. Stop, restart, update

```sh
./blackbox down      # stops the containers; database, evidence and keys stay
./blackbox up        # starts again and resumes
./blackbox status    # what is running, backup state, fences
./blackbox logs --since 1h --level warn    # works even when the app or database is down
```

Update without losing data: download the new archive, then from the **current** installation folder run
```sh
./blackbox upgrade ~/Downloads/blackbox-<new-version>-mac-arm64.tar.gz
```
The upgrade checks versions and free space, creates a backup first (it stops if backups are not configured unless you point it to a verified backup with `--use-backup`), pauses processing, migrates the database, starts the new version and verifies it. If it is interrupted, `./blackbox upgrade --resume` continues. Reverting to the old images does not undo a database migration; recovery is done with the backup made before the upgrade.

## 7. Backups (strongly recommended)

Until you configure backups, the installation is **unprotected** and `doctor` says so.

1. Choose a destination outside the installation, ideally on a separate volume (an external disk). A folder on the same disk works but does not protect against losing the Mac.
2. Enroll it:
   ```sh
   ./blackbox backup-config /Volumes/MyBackupDisk/blackbox
   ```
   This prints the **backup recovery key** (`AGE-SECRET-KEY-1…`) **once**. Save it in your password manager, separately from the owner key. Without it, backups cannot be decrypted. Blackbox stores only the matching public part.
3. Create the first backup now: `./blackbox backup`. Afterwards, one encrypted backup per 24 hours is created automatically while Blackbox is running; 7 daily and 4 weekly generations are kept. If the Mac is off or the disk is not mounted, nothing is written and the app shows how old the newest backup is.

Restore (for example on a new Mac with Docker and the same release installed):
```sh
./blackbox restore /Volumes/MyBackupDisk/blackbox/blackbox-backup-<timestamp>.tar.age
```
You are asked for the recovery key (hidden input; or set `BLACKBOX_RECOVERY_KEY_FILE` to a file that contains it). The data is restored into a **new, separate** installation folder on port 19184 by default; your current installation is not touched. The restored installation gets a **new owner key** (shown once) and all old sessions and agent keys are revoked. Provider processing stays paused until you have checked the sources: `./blackbox resume-sources`. To overwrite the current installation instead, use `--replace`; it shows what will be destroyed and requires you to type a confirmation phrase.

## 8. Where things are

| Path (inside the installation folder) | Content |
| --- | --- |
| `.env` | non-secret configuration (port, paths) |
| `secrets/` | key files, owner-only (0700/0600). Anyone with access to this folder can read your data key: use FileVault and do not share the folder. |
| `data/logs/` | application logs (sanitized), readable without the app |
| `data/evidence/`, `data/snapshots/` | raw evidence and engine snapshots |
| `data/backups/status.json` | backup status shown in the app |
| `logs/setup.log` | setup phases (no values) |

The database lives in the Docker volume `blackbox-agent-c_pgdata`. `./blackbox down` keeps it; only `./blackbox destroy --i-understand` deletes volumes, after a typed confirmation.

## 9. Lost owner key

```sh
./blackbox reset-access
```
Works only on this Mac with access to the `secrets/` folder (there is no web or email reset). It issues a new owner key (shown once), signs out all sessions, revokes agent keys and keeps all business data and sources.

## 10. Troubleshooting

| Symptom | What to do |
| --- | --- |
| `doctor` exit 2, `DOC-DOCKER` | Start Docker Desktop (or install it). |
| `DOC-PORT … in use` | Another program uses 19180: stop it or set `BLACKBOX_PORT=19181` in `.env` before `setup`/`up`. |
| `DOC-DISK` warning/critical | Free disk space; backups/imports pause at the critical level. |
| `public/LAN binding is unsupported` | Only `127.0.0.1` is supported; remove `BLACKBOX_BIND`. |
| `an installation already exists` | You ran `setup` in an installed folder: use `up` or `upgrade`. |
| App not reachable after `up` | `./blackbox status`, then `./blackbox logs --component api --level error`. |
| Backups `overdue`/`failed` | Mount the destination, run `./blackbox backup`, read the error in `status.json`. |
| Restore says `decryption failed` | Wrong or missing recovery key. There is no way around it. |

Sanitized diagnostics for a support request (local file, nothing is uploaded):
```sh
./blackbox diagnostics export --since 24h --output ~/Desktop/blackbox-diagnostics.zip
```
