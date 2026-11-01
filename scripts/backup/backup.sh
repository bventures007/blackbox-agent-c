#!/bin/bash
# Creates one encrypted, coherent backup generation (PILOT-OPERATIONS-AND-RECOVERY.md §1).
# Runs inside the blackbox/backup container. The host wrapper (or the scheduler) fences writers
# before calling this script and releases the fence afterwards, even on failure.
#
# Output: <destination>/blackbox-backup-<ts>.tar.age (outer age-encrypted tar) plus a plaintext,
# non-secret sidecar <same>.meta.json (format, version, cutoffs, sha256, bytes). The outer tar holds:
#   manifest.json           versions, checksums, cutoffs, redaction ledger state (no secrets)
#   database.pgc.age        pg_dump -Fc of the whole database, age-encrypted (ciphertext at rest in staging)
#   evidence.tar.age        raw evidence directory
#   snapshots.tar.age       engine snapshots (optional acceleration only)
#   keys.tar.age            installation data key (+ generation file and PII-anchor root), engine token, runtime role passwords
#   redaction-ledger.json.age  when the table exists
# Members are individually encrypted so the staging directory never holds plaintext; the outer
# stream is encrypted again so one file carries everything and has one checksum.
set -euo pipefail
. /scripts/common.sh

KIND="${1:-manual}"   # manual | scheduled | pre-upgrade
pg_env
check_destination
[ -r "$BACKUP_RECIPIENT_FILE" ] || die "backup recipient public key missing ($BACKUP_RECIPIENT_FILE); run ./blackbox backup-config"
RECIPIENT="$(tr -d '\n' < "$BACKUP_RECIPIENT_FILE")"
case "$RECIPIENT" in age1*) ;; *) die "backup recipient is not an age X25519 recipient";; esac

TS="$(date -u +%Y%m%dT%H%M%SZ)"
GEN="blackbox-backup-$TS"
STAGING="$BACKUP_DESTINATION/.staging-$GEN"
FINAL="$BACKUP_DESTINATION/$GEN.tar.age"
PARTIAL="$FINAL.partial"
STARTED="$(now_iso)"
INSTALL_ID="$(install_id)"
VERSION="${BLACKBOX_VERSION:-dev}"

cleanup() {
  local rc=$?
  rm -rf "$STAGING" 2>/dev/null || true
  if [ $rc -ne 0 ]; then
    rm -f "$PARTIAL" 2>/dev/null || true
    local prev; prev="$(read_status | jq '.failures // 0')"
    merge_status "$(jq -n --arg t "$(now_iso)" --arg k "$KIND" --arg g "$GEN" --argjson n "$prev" \
      '{status:"failed", last_attempt_at:$t, last_attempt_kind:$k, last_attempt_generation:$g, last_error:"backup_failed", failures:($n+1)}')"
    log "backup FAILED; partial generation removed; previous generations untouched"
  fi
  exit $rc
}
trap cleanup EXIT

umask 077
mkdir -p "$STAGING"
merge_status "$(jq -n --arg t "$STARTED" --arg k "$KIND" --arg g "$GEN" \
  '{status:"running", last_attempt_at:$t, last_attempt_kind:$k, last_attempt_generation:$g, destination_available:true}')"
log "generation $GEN ($KIND) starting"

# --- cutoffs (committed = tenant high-water marks, applied = engine checkpoints) -----------------
COMMITTED='[]'; APPLIED='[]'
if table_exists tenant_sequences; then
  COMMITTED="$(sql -c "select coalesce(json_agg(json_build_object('tenant_id',tenant_id,'committed_sequence',last_sequence) order by tenant_id),'[]'::json) from tenant_sequences")"
fi
if table_exists engine_checkpoints; then
  APPLIED="$(sql -c "select coalesce(json_agg(json_build_object('tenant_id',tenant_id,'applied_sequence',applied_sequence,'reducer_version',reducer_version) order by tenant_id),'[]'::json) from engine_checkpoints")"
fi
SCHEMA_VERSIONS='[]'
if table_exists schema_migrations; then
  SCHEMA_VERSIONS="$(sql -c "select coalesce(json_agg(version order by version),'[]'::json) from schema_migrations")"
fi
PG_VERSION="$(sql -c "show server_version")"

# --- members -------------------------------------------------------------------------------------
log "dumping database"
pg_dump -Fc -Z 6 --no-password | age -r "$RECIPIENT" > "$STAGING/database.pgc.age"

log "archiving evidence"
if [ -d "$BACKUP_SOURCE_EVIDENCE" ]; then
  tar -C "$BACKUP_SOURCE_EVIDENCE" --sort=name -cf - . | age -r "$RECIPIENT" > "$STAGING/evidence.tar.age"
fi
log "archiving snapshots"
if [ -d "$BACKUP_SOURCE_SNAPSHOTS" ]; then
  tar -C "$BACKUP_SOURCE_SNAPSHOTS" --sort=name -cf - . | age -r "$RECIPIENT" > "$STAGING/snapshots.tar.age"
fi
log "archiving installation key material"
KEYS=()
for f in data.key data.key.version anchor.key engine_token pg_migrate_password pg_api_password pg_worker_password pg_engine_password backup_recipient.pub; do
  [ -r "$BACKUP_SOURCE_SECRETS/$f" ] && KEYS+=("$f")
done
[ "${#KEYS[@]}" -gt 0 ] || die "no installation key material readable under $BACKUP_SOURCE_SECRETS"
tar -C "$BACKUP_SOURCE_SECRETS" --sort=name -cf - "${KEYS[@]}" | age -r "$RECIPIENT" > "$STAGING/keys.tar.age"

LEDGER_INCLUDED=false
if table_exists redaction_ledger; then
  log "exporting redaction ledger"
  sql -c "copy (select coalesce(json_agg(r order by r.ledger_id),'[]'::json) from redaction_ledger r) to stdout" \
    | age -r "$RECIPIENT" > "$STAGING/redaction-ledger.json.age"
  LEDGER_INCLUDED=true
fi

# --- manifest ------------------------------------------------------------------------------------
MEMBERS='[]'
for f in "$STAGING"/*.age; do
  n="$(basename "$f")"
  MEMBERS="$(jq -n --argjson m "$MEMBERS" --arg n "$n" --arg s "$(sha256_of "$f")" --argjson b "$(bytes_of "$f")" '$m + [{name:$n, sha256:$s, bytes:$b}]')"
done
RELEASE_INFO='{}'
[ -r "$RELEASE_JSON" ] && RELEASE_INFO="$(jq '{version, tested_commit, api_version, worker_version, engine_version, mcp_version, journal_schema_version, reducer_version, snapshot_version, backup_format_version, postgres_major}' "$RELEASE_JSON")"
jq -n \
  --arg format "$BACKUP_FORMAT" --arg gen "$GEN" --arg created "$STARTED" --arg kind "$KIND" \
  --arg version "$VERSION" --arg install "$INSTALL_ID" --arg pg "$PG_VERSION" \
  --argjson release "$RELEASE_INFO" --argjson committed "$COMMITTED" --argjson applied "$APPLIED" \
  --argjson schema "$SCHEMA_VERSIONS" --argjson members "$MEMBERS" --argjson ledger "$LEDGER_INCLUDED" \
  '{format:$format, generation:$gen, created_at:$created, kind:$kind, blackbox_version:$version, install_id:$install,
    postgres_server_version:$pg, release:$release, applied_migrations:$schema,
    cutoff:{committed:$committed, applied:$applied},
    redaction_ledger_included:$ledger, members:$members}' > "$STAGING/manifest.json"

# --- finalize: stream outer tar through age, atomic rename, sidecar --------------------------------
log "sealing generation"
tar -C "$STAGING" --sort=name -cf - manifest.json $(cd "$STAGING" && ls *.age) | age -r "$RECIPIENT" > "$PARTIAL"
sync "$PARTIAL" 2>/dev/null || true
SHA="$(sha256_of "$PARTIAL")"; BYTES="$(bytes_of "$PARTIAL")"
mv -f "$PARTIAL" "$FINAL"
# weekly = first finalized generation of this ISO week (shares the same file; retention keeps both classes)
WEEK="$(date -u +%G-W%V)"
WEEKLY=false
if ! ls "$BACKUP_DESTINATION"/blackbox-backup-*.meta.json >/dev/null 2>&1 || \
   ! grep -l "\"iso_week\": \"$WEEK\"" "$BACKUP_DESTINATION"/blackbox-backup-*.meta.json 2>/dev/null | grep -q .; then
  WEEKLY=true
fi
jq -n --arg format "$BACKUP_FORMAT" --arg gen "$GEN" --arg created "$STARTED" --arg finished "$(now_iso)" \
  --arg kind "$KIND" --arg version "$VERSION" --arg install "$INSTALL_ID" --arg sha "$SHA" --argjson bytes "$BYTES" \
  --arg week "$WEEK" --argjson weekly "$WEEKLY" --argjson committed "$COMMITTED" \
  '{format:$format, generation:$gen, file:($gen+".tar.age"), created_at:$created, finalized_at:$finished, kind:$kind,
    blackbox_version:$version, install_id:$install, sha256:$sha, bytes:$bytes, iso_week:$week, weekly:$weekly,
    cutoff_committed:$committed, finalized:true}' > "$BACKUP_DESTINATION/$GEN.meta.json.tmp"
mv -f "$BACKUP_DESTINATION/$GEN.meta.json.tmp" "$BACKUP_DESTINATION/$GEN.meta.json"
rm -rf "$STAGING"
log "generation finalized: $FINAL ($BYTES bytes, sha256 $SHA)"

# --- retention: only finalized generations of this installation, only after the new one is sealed ---
/scripts/retention.sh "$BACKUP_DESTINATION" "$INSTALL_ID" "$RETENTION_DAILY" "$RETENTION_WEEKLY"

DEST_LABEL="$(jq -r '.label // "backup destination"' "$BACKUP_DESTINATION/$MARKER_NAME" 2>/dev/null || echo "backup destination")"
SAME_DEVICE="$(jq -r '.same_device // true' "$BACKUP_DESTINATION/$MARKER_NAME" 2>/dev/null || echo true)"
NEXT_DUE="$(date -u -d "$STARTED + 24 hours" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+24H +%Y-%m-%dT%H:%M:%SZ)"
merge_status "$(jq -n --arg t "$(now_iso)" --arg g "$GEN" --arg f "$FINAL" --arg sha "$SHA" --argjson bytes "$BYTES" \
  --arg started "$STARTED" --arg next "$NEXT_DUE" --arg label "$DEST_LABEL" --argjson same "$SAME_DEVICE" --argjson committed "$COMMITTED" \
  --argjson daily "$RETENTION_DAILY" --argjson weekly "$RETENTION_WEEKLY" --arg kind "$KIND" \
  '{status:"scheduled", configured:true, last_completed_at:$t, last_generation:$g, last_generation_path:$f, last_sha256:$sha, last_bytes:$bytes,
    last_cutoff_at:$started, last_cutoff_committed:$committed, last_kind:$kind, next_due_at:$next, destination_label:$label,
    destination_available:true, same_device:$same, retention:{daily:$daily, weekly:$weekly}, last_error:null, failures:0}')"
printf '%s\n' "$FINAL"
