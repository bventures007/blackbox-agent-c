#!/usr/bin/env bash
# Ops gates on the second install (OPS-01 / PILOT-01 backup half): demo data, golden verify, a sealed source secret +
# a signed producer (so key rotation and backups have secrets to carry), backup-config with the recovery identity
# captured to a 0600 file outside the repo, proof that the running scheduler was recreated with the enrolled
# destination, a manual backup, and the status surface after the next scheduler tick. Evidence: $EV/part1.txt (redacted).
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; INST=$HOME/blackbox-pilot-ops2; DEST=$HOME/blackbox-pilot-ops2-backups; EV=$REPO/reports/evidence/OPS-RERUN
API=http://127.0.0.1:19185; OWNER=$INST/owner.key; cd "$INST"
redact() { sed -E 's/AGE-SECRET-KEY-1[A-Z0-9]+/AGE-SECRET-KEY-1<redacted>/g; s/bbk_[A-Za-z0-9_-]{20,}/bbk_<redacted>/g; s/bba_[A-Za-z0-9_-]{20,}/bba_<redacted>/g'; }
{
echo "# ops2 part 1  started $(date -u +%FT%TZ)  load $(uptime | sed 's/.*load averages: //')"
echo "## ./blackbox demo --confirm"; ./blackbox demo --confirm 2>&1 | tail -3; echo "exit $?"
echo "## ./blackbox verify"; ./blackbox verify 2>&1 | tail -4; echo "verify exit ${PIPESTATUS[0]}"
echo "## sealed source secret + signed producer via the API (owner session)"
python3 "$REPO/scripts/verify/owner-api.py" "$API" "$OWNER" POST /api/sources/connections '{"provider":"shopify","display_name":"rotation shop","config":{"shop_domain":"rotation-ops2.myshopify.com"},"secret":{"admin_api_token":"shpat_ops2_rotation_secret_value"}}' | head -c 400 | sed 's/"secret":"[^"]*"/"secret":"<redacted>"/'; echo
python3 "$REPO/scripts/verify/owner-api.py" "$API" "$OWNER" POST /api/sources/connections '{"provider":"generic","display_name":"rotation producer","config":{"producer_name":"ops2-rotation"}}' | head -c 400 | sed -E 's/"secret":"[^"]*"/"secret":"<redacted>"/'; echo
echo "## scheduler container before enrollment"; docker inspect blackbox-agent-c-ops2-backup-scheduler --format 'created={{.Created}} dest-mount={{range .Mounts}}{{if eq .Destination "/backup-dest"}}{{.Source}}{{end}}{{end}}'
echo "## ./blackbox backup-config $DEST --label ops2-same-device  (recovery identity captured to $INST/recovery.key 0600, redacted here)"
umask 077; ./blackbox backup-config "$DEST" --label ops2-same-device > "$INST/.backup-config.out" 2>&1; echo "exit $?"
grep -o 'AGE-SECRET-KEY-1[A-Z0-9]*' "$INST/.backup-config.out" | head -n1 > "$INST/recovery.key"; chmod 0600 "$INST/recovery.key"; redact < "$INST/.backup-config.out"; rm -f "$INST/.backup-config.out"
echo "recovery.key: $(stat -f '%Sp %z bytes' "$INST/recovery.key")"
echo "## scheduler container after enrollment (must be recreated with the enrolled destination mounted)"; docker inspect blackbox-agent-c-ops2-backup-scheduler --format 'created={{.Created}} dest-mount={{range .Mounts}}{{if eq .Destination "/backup-dest"}}{{.Source}}{{end}}{{end}}'
echo "## data/backups/status.json right after enrollment"; cat data/backups/status.json
echo "## destination marker"; cat "$DEST/.blackbox-backup-destination"
echo "## ./blackbox backup (manual generation)"; T0=$(date +%s); ./blackbox backup 2>&1 | redact | tail -12; echo "backup exit ${PIPESTATUS[0]} after $(( $(date +%s) - T0 )) s"
echo "## status.json after the manual backup"; cat data/backups/status.json; echo
echo "## destination listing"; ls -la "$DEST" | grep -v '^total'
echo "## waiting for one scheduler tick (<= 11 min) to prove the status is not rewritten to not_configured (PILOT-01 fix)"
for i in $(seq 1 66); do sleep 10; n="$(docker logs blackbox-agent-c-ops2-backup-scheduler 2>&1 | wc -l | tr -d ' ')"; [ "$i" = 1 ] && first="$n"; [ "$n" -gt "${first:-0}" ] && break; done
echo "scheduler log (tail):"; docker logs --tail 5 blackbox-agent-c-ops2-backup-scheduler 2>&1 | redact
echo "## status.json after the tick ($(date -u +%FT%TZ))"; cat data/backups/status.json; echo
echo "## GET /api/settings/backups"; python3 "$REPO/scripts/verify/owner-api.py" "$API" "$OWNER" GET /api/settings/backups | head -c 900; echo
echo "# finished $(date -u +%FT%TZ)"
} > "$EV/part1.txt" 2>&1
grep -cE 'AGE-SECRET-KEY-1[A-Z0-9]{10,}|bbk_[A-Za-z0-9_-]{20,}' "$EV/part1.txt" | sed 's/^/secret-pattern lines in evidence: /'
grep -E '^##|exit|status"|created=' "$EV/part1.txt" | tail -24
