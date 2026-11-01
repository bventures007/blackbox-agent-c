#!/bin/bash
# Restore phases, run inside the blackbox/backup container by ./blackbox restore (host-only).
# The recovery identity is read from BLACKBOX_RECOVERY_IDENTITY_FILE (mounted file, never argv).
#   restore.sh inspect <backup.tar.age>   validate outer checksum against the sidecar (no key needed)
#   restore.sh unpack  <backup.tar.age>   decrypt outer → /data/restore/staging (members stay encrypted),
#                                         verify manifest + member checksums + format/version compatibility,
#                                         write key material to /secrets, evidence/snapshots to /data
#   restore.sh database                   stream-decrypt database.pgc.age into pg_restore (no plaintext on disk)
#   restore.sh ledger                     print the redaction ledger JSON from the staging (if present)
#   restore.sh finish                     remove staging
set -euo pipefail
. /scripts/common.sh
STAGING="/data/restore/staging"
IDENTITY="${BLACKBOX_RECOVERY_IDENTITY_FILE:-/run/secrets/recovery_identity}"
cmd="${1:-}"; shift || true

need_identity() { [ -r "$IDENTITY" ] || die "recovery identity not readable at $IDENTITY"; grep -q '^AGE-SECRET-KEY-1' "$IDENTITY" || die "recovery identity is not an age X25519 identity"; }

case "$cmd" in
  inspect)
    f="${1:?backup file}"; [ -f "$f" ] || die "backup file not found"
    meta="${f%.tar.age}.meta.json"
    case "$f" in *.tar.age) ;; *) die "not a .tar.age backup generation";; esac
    case "$f" in *.partial) die "partial generation; cannot be restored";; esac
    if [ -f "$meta" ]; then
      exp="$(jq -r .sha256 "$meta")"; act="$(sha256_of "$f")"
      [ "$exp" = "$act" ] || die "sidecar sha256 mismatch (corrupt or tampered generation)"
      [ "$(jq -r '.finalized // false' "$meta")" = "true" ] || die "generation not finalized"
      jq -c '{generation, created_at, blackbox_version, bytes, sha256, cutoff_committed, install_id}' "$meta"
    else
      log "no sidecar; outer checksum cannot be pre-verified (age authentication still applies)"
      jq -n --arg f "$(basename "$f")" --argjson b "$(bytes_of "$f")" '{file:$f, bytes:$b, sidecar:false}'
    fi ;;
  unpack)
    f="${1:?backup file}"; need_identity
    umask 077; rm -rf "$STAGING"; mkdir -p "$STAGING"
    log "decrypting outer container"
    age -d -i "$IDENTITY" "$f" | tar -C "$STAGING" -xf - || die "decryption failed (wrong recovery key or corrupt file)"
    [ -f "$STAGING/manifest.json" ] || die "manifest.json missing in backup"
    fmt="$(jq -r .format "$STAGING/manifest.json")"
    [ "$fmt" = "$BACKUP_FORMAT" ] || die "unsupported backup format '$fmt' (this release reads $BACKUP_FORMAT)"
    # member checksums
    jq -r '.members[] | "\(.sha256)  \(.name)"' "$STAGING/manifest.json" | (cd "$STAGING" && sha256sum -c --quiet -) || die "member checksum mismatch"
    # compatibility with the installed release (install-time compatibility: backup format + pg major)
    if [ -r "$RELEASE_JSON" ]; then
      want_bf="$(jq -r '.backup_format_version // empty' "$RELEASE_JSON")"; have_bf="$(jq -r '.release.backup_format_version // empty' "$STAGING/manifest.json")"
      if [ -n "$want_bf" ] && [ -n "$have_bf" ] && [ "$have_bf" -gt "$want_bf" ] 2>/dev/null; then die "backup was written by a newer backup format ($have_bf > $want_bf); upgrade this release first"; fi
      want_pg="$(jq -r '.postgres_major // empty' "$RELEASE_JSON")"; have_pg="$(jq -r '.postgres_server_version // empty' "$STAGING/manifest.json" | cut -d. -f1)"
      if [ -n "$want_pg" ] && [ -n "$have_pg" ] && [ "$have_pg" -gt "$want_pg" ] 2>/dev/null; then die "backup comes from PostgreSQL $have_pg, this release runs $want_pg: no automatic downgrade"; fi
    fi
    log "restoring key material to /secrets"
    [ -d /secrets ] && [ -w /secrets ] || die "/secrets not writable"
    age -d -i "$IDENTITY" "$STAGING/keys.tar.age" | tar -C /secrets -xf -
    chmod 0600 /secrets/* 2>/dev/null || true
    if [ -f "$STAGING/evidence.tar.age" ]; then
      log "restoring evidence"; mkdir -p /data/evidence; age -d -i "$IDENTITY" "$STAGING/evidence.tar.age" | tar -C /data/evidence -xf -
    fi
    if [ -f "$STAGING/snapshots.tar.age" ]; then
      log "restoring snapshots"; mkdir -p /data/snapshots; age -d -i "$IDENTITY" "$STAGING/snapshots.tar.age" | tar -C /data/snapshots -xf -
    fi
    jq -c '{generation, created_at, blackbox_version, cutoff, applied_migrations, redaction_ledger_included, release}' "$STAGING/manifest.json" ;;
  database)
    need_identity; pg_env
    [ -f "$STAGING/database.pgc.age" ] || die "no database member in staging; run unpack first"
    log "restoring database (streamed; no plaintext dump written)"
    age -d -i "$IDENTITY" "$STAGING/database.pgc.age" | pg_restore --no-password --exit-on-error --single-transaction -d "$PGDATABASE" \
      || die "pg_restore failed"
    log "database restored" ;;
  ledger)
    need_identity
    if [ -f "$STAGING/redaction-ledger.json.age" ]; then age -d -i "$IDENTITY" "$STAGING/redaction-ledger.json.age"; else echo 'null'; fi ;;
  finish) rm -rf "$STAGING"; log "staging removed" ;;
  *) die "usage: restore.sh inspect|unpack|database|ledger|finish" ;;
esac
