#!/usr/bin/env bash
# Upgrade rehearsal on a release-mode installation (OPS-02 / PILOT-03 preparation).
#   tests/ops/upgrade.sh [--full]
# Builds two ops-only archives (backup + postgres images only unless --full), installs the first from the
# extracted archive exactly like a tester, seeds data, enrolls backups, then upgrades to the second archive
# and checks: pre-upgrade generation exists, version recorded, data intact, fence released, phase file gone,
# previous release files preserved. Uses project blackbox-agent-c-optest-upg-<pid> and port 19189.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
FULL=0; [ "${1:-}" = "--full" ] && FULL=1
if [ $FULL = 0 ]; then export BLACKBOX_SERVICES="postgres backup-scheduler" BLACKBOX_BUILD_SERVICES="backup"; IMG="--images backup"; else IMG=""; fi
T="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/blackbox-upgrade.XXXXXX")" && pwd -P)"
P="blackbox-agent-c-optest-upg-$$"
cleanup() { set +e; docker compose -p "$P" down -v --remove-orphans >/dev/null 2>&1; rm -rf "$T" "$ROOT/release/dist-upgrade-test"; }
trap cleanup EXIT
step() { printf '\n=== %s ===\n' "$*"; }

step "build two ops-only release archives"
OUT="$ROOT/release/dist-upgrade-test"; mkdir -p "$OUT"
for v in 0.0.1 0.0.2; do
  "$ROOT/scripts/release/build.sh" "$v" $IMG > "$T/build-$v.log" 2>&1 || { tail -20 "$T/build-$v.log"; exit 2; }
  mv "$ROOT/release/dist/blackbox-$v-mac-arm64.tar.gz" "$OUT/"; echo "built $v"
done
rm -rf "$ROOT/release/dist"

step "install 0.0.1 from the extracted archive (release mode)"
tar -xzf "$OUT/blackbox-0.0.1-mac-arm64.tar.gz" -C "$T"; I="$T/blackbox-0.0.1"
unset BLACKBOX_INSTALL_DIR
"$I/blackbox" doctor >/dev/null || true
"$I/blackbox" setup --project "$P" --port 19189 > "$T/setup.log" 2>&1 || { tail -20 "$T/setup.log"; exit 2; }
[ "$(grep -o '"version": "[^"]*"' "$I/data/state/installed-release.json" | cut -d'"' -f4)" = "0.0.1" ]
docker compose -f "$I/infra/compose/docker-compose.yml" --env-file "$I/.env" exec -T postgres psql -X -U postgres -d blackbox -q -v ON_ERROR_STOP=1 -c "INSERT INTO tenants(display_name) VALUES ('upg-a'),('upg-b')"
mkdir -p "$T/dest"; "$I/blackbox" backup-config "$T/dest" > "$T/bc.out" 2>&1
echo "installed 0.0.1 and seeded"

step "upgrade refuses the same version and an unknown source"
set +e; "$I/blackbox" upgrade "$OUT/blackbox-0.0.1-mac-arm64.tar.gz" >/dev/null 2>&1; rc=$?; set -e; [ $rc -ne 0 ]; [ ! -f "$I/data/state/upgrade.json" ]
set +e; "$I/blackbox" upgrade "$T/nope.tar.gz" >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 2 ]

step "upgrade 0.0.1 → 0.0.2"
"$I/blackbox" upgrade "$OUT/blackbox-0.0.2-mac-arm64.tar.gz" 2>&1 | grep -v "^ Container\|^ Volume\|^ Network" | tail -25
[ "$(grep -o '"version": "[^"]*"' "$I/data/state/installed-release.json" | cut -d'"' -f4)" = "0.0.2" ]
grep -q '"version": "0.0.2"' "$I/release.json"
grep -q 'BLACKBOX_VERSION=0.0.2' "$I/.env"
[ -f "$I/data/state/previous-release/0.0.1/release.json" ] && [ -x "$I/data/state/previous-release/0.0.1/blackbox" ]
[ ! -f "$I/data/state/upgrade.json" ] && [ ! -d "$I/data/state/maintenance.lock" ] && [ ! -f "$I/data/state/writers.paused.json" ]
ls "$T/dest"/blackbox-backup-*.tar.age >/dev/null
grep -q '"kind": "pre-upgrade"' "$T/dest"/blackbox-backup-*.meta.json
[ "$(docker compose -f "$I/infra/compose/docker-compose.yml" --env-file "$I/.env" exec -T postgres psql -X -At -U postgres -d blackbox -c 'select count(*) from tenants')" = 2 ]
docker image inspect blackbox/backup:0.0.2 >/dev/null
grep -q "upgrade done 0.0.1->0.0.2" "$I/logs/setup.log"
"$I/blackbox" doctor > "$T/doctor.out" 2>&1 || true; grep -q "release 0.0.2 installed" "$T/doctor.out"
echo
echo "UPGRADE PASS 0.0.1 → 0.0.2 ($([ $FULL = 1 ] && echo full stack || echo ops-only))"
