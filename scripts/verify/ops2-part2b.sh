#!/usr/bin/env bash
# PILOT-02 / OPS-01 restore half + PILOT-07/08 restore angles on the second install: isolated restore of the generation
# created BEFORE the data-key rotation and BEFORE the evidence restriction, with the recovery identity only, into a
# fresh directory/port/project; machine time as printed by the wrapper; golden answer verified in the restored
# install; restored key material is generation 1 (differs from the live generation-2 key: the restore used backup
# material only); raw evidence stays blocked by the restore fence (restore_policy_unreconciled) until reconciled.
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; INST=$HOME/blackbox-pilot-ops2; DEST=$HOME/blackbox-pilot-ops2-backups; EV=$REPO/reports/evidence/OPS-RERUN
RDIR=$HOME/blackbox-pilot-ops2-restore; RAPI=http://127.0.0.1:19192; cd "$INST"
GEN="$(ls -t "$DEST"/*.tar.age | head -n1)"
EID="$(grep -o 'evidence id: [0-9a-f-]*' "$EV/part2a.txt" | head -n1 | awk '{print $3}')"
{
echo "# ops2 part 2b  started $(date -u +%FT%TZ)  load $(uptime | sed 's/.*load averages: //')"
echo "## generation: $(basename "$GEN") ($(stat -f %z "$GEN") bytes, sidecar: $(cat "${GEN%.tar.age}.meta.json" | tr -d '\n' | cut -c1-200)…)"
echo "## live install key generation now: $(cat secrets/data.key.version); live data.key sha256 (first 12): $(shasum -a 256 secrets/data.key | cut -c1-12)"
echo "## ./blackbox restore $(basename "$GEN") --into $RDIR --port 19192 --project blackbox-agent-c-ops2-restore  (BLACKBOX_RECOVERY_KEY_FILE=$INST/recovery.key; new owner key captured to $RDIR.owner.key)"
rm -rf "$RDIR"; T0=$(date +%s)
BLACKBOX_RECOVERY_KEY_FILE="$INST/recovery.key" python3 "$REPO/scripts/verify/pty-capture.py" "$INST" "$HOME/blackbox-pilot-ops2-restore.owner.key" "$EV/part2b-restore-transcript-redacted.txt" -- ./blackbox restore "$GEN" --into "$RDIR" --port 19192 --project blackbox-agent-c-ops2-restore
echo "restore exit $? after $(( $(date +%s) - T0 )) s wall"
grep -iE 'machine|operator|elapsed|processing|verify|representative|restored|fence|phase|\[' "$EV/part2b-restore-transcript-redacted.txt" | tail -25
echo "## restored install"; (cd "$RDIR" && ./blackbox status 2>&1 | tail -8)
echo "restored key generation: $(cat "$RDIR/secrets/data.key.version" 2>/dev/null || echo '(no version file: generation 1 layout)'); restored data.key sha256 (first 12): $(shasum -a 256 "$RDIR/secrets/data.key" | cut -c1-12)  -> $( [ "$(shasum -a 256 "$RDIR/secrets/data.key")" != "$(shasum -a 256 secrets/data.key)" ] && echo 'differs from the live generation-2 key: restore used the backup material only' || echo 'SAME AS LIVE KEY (unexpected)')"
echo "## restored install: every stored secret opens with the restored (generation-1) key"
(cd "$RDIR" && docker compose -p blackbox-agent-c-ops2-restore exec -T postgres psql -X -U postgres -d blackbox -Atc "SELECT tenant_id FROM tenants" | docker compose -p blackbox-agent-c-ops2-restore exec -T api node /app/apps/api/dist/cli.js rotate-data-key --verify-only 2>&1 | tail -1)
echo "## restored install: ./blackbox verify (golden answer)"; (cd "$RDIR" && ./blackbox verify 2>&1 | tail -3; echo "verify exit ${PIPESTATUS[0]}")
echo "## restored install: raw evidence blocked until the restore policy is reconciled (evidence restricted AFTER this generation on the live install: $EID)"
python3 "$REPO/scripts/verify/owner-api.py" "$RAPI" "$HOME/blackbox-pilot-ops2-restore.owner.key" GET "/api/evidence/$EID" | tail -1 | head -c 300; echo
python3 "$REPO/scripts/verify/owner-api.py" "$RAPI" "$HOME/blackbox-pilot-ops2-restore.owner.key" GET "/api/evidence/$EID/content" | head -1
echo "evidence fence file:"; cat "$RDIR/data/state/evidence-access.json"; echo; echo "writers fence:"; cat "$RDIR/data/state/writers.paused.json"; echo
echo "## restored install: GET /api/settings/backups (restored status surface)"; python3 "$REPO/scripts/verify/owner-api.py" "$RAPI" "$HOME/blackbox-pilot-ops2-restore.owner.key" GET /api/settings/backups | tail -1 | head -c 300; echo
echo "## original install untouched: live key generation $(cat secrets/data.key.version), status.json last_generation $(python3 -c "import json;print(json.load(open('data/backups/status.json'))['last_generation'])")"
echo "## stopping the restored stack (folder kept for inspection)"; (cd "$RDIR" && ./blackbox down 2>&1 | tail -1)
echo "# finished $(date -u +%FT%TZ)  load $(uptime | sed 's/.*load averages: //')"
} > "$EV/part2b.txt" 2>&1
grep -cE 'AGE-SECRET-KEY-1[A-Z0-9]{10,}|bbk_[A-Za-z0-9_-]{20,}' "$EV/part2b.txt" "$EV/part2b-restore-transcript-redacted.txt" | sed 's/^/secret-pattern lines: /'
grep -E '^##|exit|machine|differs|SAME|restricted|verified|status"' "$EV/part2b.txt" | head -40
