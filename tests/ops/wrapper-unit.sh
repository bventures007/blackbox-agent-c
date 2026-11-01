#!/usr/bin/env bash
# Unit-level checks of the host wrapper and release tooling that need no Docker stack.
#   tests/ops/wrapper-unit.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BB="$ROOT/scripts/blackbox"
T="$(mktemp -d "${TMPDIR:-/tmp}/blackbox-ops-unit.XXXXXX")"; trap 'rm -rf "$T"' EXIT
pass=0; failn=0
check() { if "$@"; then pass=$((pass+1)); echo "  ok   $*"; else failn=$((failn+1)); echo "  FAIL $*"; fi; }
exit_is() { local want="$1"; shift; "$@" >/dev/null 2>&1; [ $? -eq "$want" ]; }
contains() { local needle="$1"; shift; { "$@" 2>&1 || true; } | grep -q -- "$needle"; }

echo "wrapper syntax (bash 3.2 compatible)"
check /bin/bash -n "$BB"
check /bin/bash -n "$ROOT/scripts/release/build.sh"
check /bin/bash -n "$ROOT/scripts/release/check-manifest.sh"
check /bin/bash -n "$ROOT/scripts/release/verify-download.sh"
for f in "$ROOT"/scripts/backup/*.sh; do check bash -n "$f"; done

echo "help / unknown command"
check exit_is 0 "$BB" help
check exit_is 0 "$BB" --help
check contains "doctor" "$BB" help
check exit_is 2 "$BB" no-such-command

echo "non-loopback bind refusal"
check exit_is 2 env BLACKBOX_BIND=0.0.0.0 BLACKBOX_INSTALL_DIR="$T/i1" "$BB" setup
check contains "public/LAN binding is unsupported" env BLACKBOX_BIND=0.0.0.0 BLACKBOX_INSTALL_DIR="$T/i1" "$BB" setup
check contains "public/LAN binding is unsupported" env BLACKBOX_BIND=192.168.1.5 BLACKBOX_INSTALL_DIR="$T/i1" "$BB" doctor
check exit_is 2 env BLACKBOX_BIND=0.0.0.0 BLACKBOX_INSTALL_DIR="$T/i1" "$BB" doctor
check '[' ! -e "$T/i1/secrets" ']'

echo "doctor on a fresh directory (exit 0 or 1 depending on Docker; never 2 when prerequisites exist)"
# BLACKBOX_PORT override keeps the check independent of whatever else listens on 19180 on this host
BLACKBOX_PORT=19179 BLACKBOX_INSTALL_DIR="$T/i2" "$BB" doctor > "$T/doc.out" 2>&1; rc=$?
check '[' $rc -le 1 ']'
check grep -q "DOC-ARCH" "$T/doc.out"
check grep -q "not set up yet" "$T/doc.out"
check '[' ! -e "$T/i2/.env" ']'
{ BLACKBOX_PORT=19179 BLACKBOX_INSTALL_DIR="$T/i2" "$BB" doctor --json 2>/dev/null || true; } | tail -n1 > "$T/doc.json"
check grep -q '"exit_code"' "$T/doc.json"

echo "commands that need a setup refuse cleanly"
for c in up down status backup verify demo; do check exit_is 1 env BLACKBOX_INSTALL_DIR="$T/i3" "$BB" $c; done
check contains "not set up yet" env BLACKBOX_INSTALL_DIR="$T/i3" "$BB" up
check exit_is 2 env BLACKBOX_INSTALL_DIR="$T/i3" "$BB" destroy
check exit_is 2 env BLACKBOX_INSTALL_DIR="$T/i3" "$BB" restore "$T/nonexistent.tar.age"
check contains "recovery" env BLACKBOX_INSTALL_DIR="$T/i3" BLACKBOX_RECOVERY_KEY_FILE="$T/missing" "$BB" restore "$BB"

echo "release manifest checker"
check exit_is 0 "$ROOT/scripts/release/check-manifest.sh" "$ROOT/release/release-manifest.template.json"
printf '{"schema_version":"1","status":"released","version":"9.9.9","date":"2026-01-01","tested_commit":"abc","artifact_filename":"wrong.tar.gz","platform":"macOS Apple Silicon (arm64)","format":"tar.gz","byte_size":1,"sha256":"%s","download_url":"./x","guide_url":"./INSTALL.en.md","prerequisites":{"a":1}}\n' "$(printf '0%.0s' $(seq 64))" > "$T/bad.json"
check exit_is 2 "$ROOT/scripts/release/check-manifest.sh" "$T/bad.json"
printf '{"schema_version":"1","status":"pending","download_url":"./fake.tar.gz","platform":"x","format":"tar.gz","prerequisites":{},"guide_url":"./g"}\n' > "$T/bad2.json"
check exit_is 2 "$ROOT/scripts/release/check-manifest.sh" "$T/bad2.json"

echo "compose file: loopback only, internal networks, no extra published ports"
C="$ROOT/infra/compose/docker-compose.yml"
check '[' "$(grep -c -E '^\s+- "\$\{BLACKBOX_BIND' "$C")" = 1 ']'
check grep -q 'internal: true' "$C"
check '[' "$(grep -c -E '^\s+ports:' "$C")" = 1 ']'
check grep -q 'postgres:16.6-alpine@sha256:' "$C"
check '[' "$(grep -c 'user: "10001:10001"' "$C")" -ge 5 ']'
check docker compose -f "$C" --env-file "$ROOT/infra/compose/.env.example" config --quiet

echo "dockerfiles pinned by digest"
for d in api worker engine backup; do check grep -q '@sha256:' "$ROOT/infra/docker/$d.Dockerfile"; check grep -q -E 'USER 10001' "$ROOT/infra/docker/$d.Dockerfile"; done

echo "result: $pass passed, $failn failed"
[ $failn -eq 0 ]
