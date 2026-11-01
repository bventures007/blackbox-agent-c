#!/usr/bin/env bash
# Backup → restore round trip through the real wrapper and Compose stack.
#   tests/ops/backup-roundtrip.sh [--full]
# Default (ops-only): postgres + backup-scheduler + backup image only — valid while the api/worker/engine
# images are not built. With --full the complete stack is started and the api CLI paths (owner key,
# reset-access, verify) are exercised; the test then requires the application images.
# Uses its own Compose projects (blackbox-agent-c-optest*), ports 19187/19188 and a scratch install dir.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BB="$ROOT/scripts/blackbox"
FULL=0; [ "${1:-}" = "--full" ] && FULL=1
if [ $FULL = 0 ]; then export BLACKBOX_SERVICES="postgres backup-scheduler" BLACKBOX_BUILD_SERVICES="backup"; MODE="ops-only (postgres + backup image; application images not required)"; else MODE="full stack"; fi
T="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/blackbox-roundtrip.XXXXXX")" && pwd -P)"
INSTALL="$T/install"; DEST="$T/backup-dest"; RESTORE="$T/restore"
P1="blackbox-agent-c-optest-$$"; P2="$P1-restore"
export BLACKBOX_INSTALL_DIR="$INSTALL"
cleanup() {
  set +e
  docker compose -p "$P1" down -v --remove-orphans >/dev/null 2>&1
  docker compose -p "$P2" down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$T"
}
trap cleanup EXIT
compose1() { docker compose -f "$ROOT/infra/compose/docker-compose.yml" --env-file "$INSTALL/.env" "$@"; }
compose2() { docker compose -f "$RESTORE/infra/compose/docker-compose.yml" --env-file "$RESTORE/.env" "$@"; }
step() { printf '\n=== %s ===\n' "$*"; }
T0=$(date +%s)
echo "backup round trip — $MODE — scratch $T"

step "setup"
"$BB" setup --project "$P1" --port 19187
[ -f "$INSTALL/.env" ] && [ "$(stat -f %Lp "$INSTALL/secrets" 2>/dev/null || stat -c %a "$INSTALL/secrets")" = "700" ]
grep -q "setup done" "$INSTALL/logs/setup.log"
! grep -q -E 'bbk_|AGE-SECRET|password=' "$INSTALL/logs/setup.log"

step "seed sample data (two synthetic tenants, evidence file)"
compose1 exec -T postgres psql -X -U postgres -d blackbox -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO tenants(display_name) VALUES ('roundtrip-a'),('roundtrip-b');
INSERT INTO tenant_sequences(tenant_id,last_sequence) SELECT tenant_id, 0 FROM tenants;
SQL
mkdir -p "$INSTALL/data/evidence/sub"; head -c 200000 /dev/urandom > "$INSTALL/data/evidence/sub/blob.bin"; echo "evidence-sample" > "$INSTALL/data/evidence/sample.txt"
SRC_SHA="$(shasum -a 256 "$INSTALL/data/evidence/sub/blob.bin" | awk '{print $1}')"

step "backup refuses before configuration"
set +e; "$BB" backup >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 1 ]

step "backup-config (recovery key captured to a 0600 file, never printed)"
mkdir -p "$DEST"
"$BB" backup-config "$DEST" --label "roundtrip scratch" > "$T/bc.out" 2>&1
(umask 077; grep -o 'AGE-SECRET-KEY-1[A-Z0-9]*' "$T/bc.out" > "$T/recovery.key")
[ -s "$T/recovery.key" ] && [ -f "$DEST/.blackbox-backup-destination" ] && [ -s "$INSTALL/secrets/backup_recipient.pub" ]
grep -q "$DEST" "$INSTALL/.env"

step "backup refuses an unmounted/unenrolled destination"
mv "$DEST/.blackbox-backup-destination" "$T/marker.bak"
set +e; "$BB" backup >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 1 ]; [ -z "$(ls "$DEST")" ]
mv "$T/marker.bak" "$DEST/.blackbox-backup-destination"

step "backup"
"$BB" backup
GEN="$(ls "$DEST"/blackbox-backup-*.tar.age)"; META="${GEN%.tar.age}.meta.json"
[ -f "$META" ] && ! ls "$DEST"/*.partial >/dev/null 2>&1 && ! ls -d "$DEST"/.staging-* >/dev/null 2>&1
[ "$(shasum -a 256 "$GEN" | awk '{print $1}')" = "$(grep -o '"sha256": "[0-9a-f]*"' "$META" | cut -d'"' -f4)" ]
grep -q '"status": "scheduled"' "$INSTALL/data/backups/status.json"
[ ! -f "$INSTALL/data/state/writers.paused.json" ]
# encrypted: the outer file must not expose the plaintext evidence marker
! grep -a -q "evidence-sample" "$GEN"
echo "generation: $GEN"

step "second backup + retention bookkeeping"
"$BB" backup >/dev/null
[ "$(ls "$DEST"/blackbox-backup-*.tar.age | wc -l | tr -d ' ')" = 2 ]

step "restore with a wrong key fails honestly"
(umask 077; printf 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ3Z8X5K\n' > "$T/wrong.key")
set +e; BLACKBOX_RECOVERY_KEY_FILE="$T/wrong.key" "$BB" restore "$GEN" --into "$T/restore-wrong" --port 19188 --project "$P2" >"$T/wrong.out" 2>&1; rc=$?; set -e
[ $rc -ne 0 ]; grep -q -i -E "decrypt|identity|fail" "$T/wrong.out"
docker compose -p "$P2" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$T/restore-wrong"

step "restore into a fresh isolated installation"
M0=$(date +%s)
BLACKBOX_RECOVERY_KEY_FILE="$T/recovery.key" "$BB" restore "$GEN" --into "$RESTORE" --port 19188 --project "$P2"
M1=$(date +%s)
[ "$(compose2 exec -T postgres psql -X -At -U postgres -d blackbox -c 'select count(*) from tenants')" = 2 ]
[ "$(shasum -a 256 "$RESTORE/data/evidence/sub/blob.bin" | awk '{print $1}')" = "$SRC_SHA" ]
cmp "$INSTALL/secrets/data.key" "$RESTORE/secrets/data.key"
cmp "$INSTALL/secrets/engine_token" "$RESTORE/secrets/engine_token"
! cmp -s "$INSTALL/secrets/pg_superuser_password" "$RESTORE/secrets/pg_superuser_password"
[ -f "$RESTORE/data/state/writers.paused.json" ] && [ -f "$RESTORE/data/state/evidence-access.json" ]
[ ! -d "$RESTORE/data/restore/staging" ]
[ "$(stat -f %Lp "$RESTORE/secrets" 2>/dev/null || stat -c %a "$RESTORE/secrets")" = "700" ]
# original installation untouched
[ "$(compose1 exec -T postgres psql -X -At -U postgres -d blackbox -c 'select count(*) from tenants')" = 2 ]
echo "restore machine time: $((M1-M0))s"

step "resume-sources clears the fence"
BLACKBOX_INSTALL_DIR="$RESTORE" "$RESTORE/blackbox" resume-sources >/dev/null
[ ! -f "$RESTORE/data/state/writers.paused.json" ]

step "down keeps volumes; up resumes"
"$BB" down >/dev/null; "$BB" up >/dev/null
[ "$(compose1 exec -T postgres psql -X -At -U postgres -d blackbox -c 'select count(*) from tenants')" = 2 ]

step "setup refuses to overwrite an existing installation"
set +e; "$BB" setup >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 1 ]

if [ $FULL = 1 ]; then
  step "verify (full stack)"; "$BB" verify
fi
echo
echo "ROUNDTRIP PASS ($MODE) in $(( $(date +%s) - T0 ))s; restore machine time $((M1-M0))s"
