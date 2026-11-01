#!/bin/bash
# Shared helpers for the Blackbox operations container (backup image). Bash only, no secrets in argv.
# Status file contract (read by the API for the Backups & recovery settings/health cards):
#   /data/backups/status.json — see docs/operations.md "Backup status file".
set -euo pipefail

BACKUP_FORMAT="blackbox-backup/1"
: "${BACKUP_DESTINATION:=/backup-dest}"
: "${BACKUP_STATUS_FILE:=/data/backups/status.json}"
: "${BACKUP_RECIPIENT_FILE:=/secrets/backup_recipient.pub}"
: "${BACKUP_SOURCE_EVIDENCE:=/data/evidence}"
: "${BACKUP_SOURCE_SNAPSHOTS:=/data/snapshots}"
: "${BACKUP_SOURCE_SECRETS:=/secrets}"
: "${RELEASE_JSON:=/release/release.json}"
: "${STATE_DIR:=/data/state}"
: "${RETENTION_DAILY:=7}"
: "${RETENTION_WEEKLY:=4}"
MARKER_NAME=".blackbox-backup-destination"

log() { printf '%s backup %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# PostgreSQL password from the *_FILE secret (never argv).
pg_env() {
  if [ -n "${PGPASSWORD_FILE:-}" ] && [ -r "$PGPASSWORD_FILE" ]; then
    PGPASSWORD="$(tr -d '\n' < "$PGPASSWORD_FILE")"; export PGPASSWORD
  fi
}

install_id() {
  if [ -r "$STATE_DIR/install.json" ]; then
    jq -r '.install_id // empty' "$STATE_DIR/install.json"
  fi
}

release_field() { # release_field <jq-path>
  if [ -r "$RELEASE_JSON" ]; then jq -r "$1 // empty" "$RELEASE_JSON"; fi
}

# Atomic JSON status write (tmp + rename) — partial reads by the API are impossible.
write_status() { # write_status <json>
  local dir; dir="$(dirname "$BACKUP_STATUS_FILE")"
  mkdir -p "$dir" || { log "cannot create $dir; status persistence unavailable"; return 0; }
  printf '%s\n' "$1" | jq . > "$BACKUP_STATUS_FILE.tmp" && mv -f "$BACKUP_STATUS_FILE.tmp" "$BACKUP_STATUS_FILE"
}

read_status() { if [ -r "$BACKUP_STATUS_FILE" ]; then cat "$BACKUP_STATUS_FILE"; else echo '{}'; fi; }

merge_status() { # merge_status <json-object-with-updates>
  local cur; cur="$(read_status)"
  write_status "$(jq -n --argjson a "$cur" --argjson b "$1" '$a * $b')"
}

# Destination safety: refuses an unenrolled, missing, unwritable or empty-mount-point directory.
check_destination() {
  [ -d "$BACKUP_DESTINATION" ] || die "backup destination is not a directory (unmounted volume?): refusing to write"
  [ -f "$BACKUP_DESTINATION/$MARKER_NAME" ] || die "backup destination has no $MARKER_NAME marker (not enrolled or volume not mounted): refusing to write"
  local expected actual
  expected="$(install_id)"; actual="$(jq -r '.install_id // empty' "$BACKUP_DESTINATION/$MARKER_NAME" 2>/dev/null || true)"
  if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
    die "backup destination marker belongs to another installation ($actual); refusing to write"
  fi
  [ -w "$BACKUP_DESTINATION" ] || die "backup destination is not writable"
}

sha256_of() { sha256sum "$1" | awk '{print $1}'; }
bytes_of() { stat -c %s "$1"; }

sql() { psql -X -v ON_ERROR_STOP=1 -At "$@"; }
table_exists() { sql -c "select to_regclass('public.$1') is not null" | grep -q t; }
