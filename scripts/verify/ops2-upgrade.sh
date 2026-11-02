#!/usr/bin/env bash
# OPS-02 / PILOT-03 on the populated second install (553k-entry corpus): refusals (same version, missing source), a fenced
# upgrade to <archive> interrupted during the images phase (SIGKILL of the wrapper), doctor/up refusals while interrupted,
# `upgrade --resume` to completion, then version/fence/backup/golden checks. Evidence: $EV/upgrade.txt (keys redacted).
#   scripts/verify/ops2-upgrade.sh <new-archive.tar.gz>
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; INST=$HOME/blackbox-pilot-ops2; EV=$REPO/reports/evidence/OPS-RERUN; NEW="$1"; OLD=$REPO/release/dist/blackbox-0.1.0-mac-arm64.tar.gz; cd "$INST"
redact() { sed -E 's/AGE-SECRET-KEY-1[A-Z0-9]+/AGE-SECRET-KEY-1<redacted>/g; s/bb[ka]_[A-Za-z0-9_-]{20,}/<redacted>/g'; }
{
echo "# ops2 upgrade rehearsal  started $(date -u +%FT%TZ)  load $(uptime | sed 's/.*load averages: //')"
echo "## installed: $(./blackbox status 2>&1 | head -1)"; echo "entries: $(docker compose -p blackbox-agent-c-ops2 exec -T postgres psql -X -U postgres -d blackbox -Atc 'select count(*) from journal_entries')"
echo "## refusal: same version"; ./blackbox upgrade "$OLD" 2>&1 | tail -2; echo "exit ${PIPESTATUS[0]}"
echo "## refusal: missing source"; ./blackbox upgrade /nonexistent/blackbox-9.9.9-mac-arm64.tar.gz 2>&1 | tail -1; echo "exit ${PIPESTATUS[0]}"
echo "## upgrade to $(basename "$NEW"), interrupted with SIGKILL in the images phase"
T0=$(date +%s); ./blackbox upgrade "$NEW" > "$EV/upgrade-run1.txt" 2>&1 & UP=$!
for i in $(seq 1 1800); do ph="$(python3 -c "import json;print(json.load(open('data/state/upgrade.json'))['phase'])" 2>/dev/null)"; if [ "$ph" = "images" ]; then sleep 3; kill -9 $UP 2>/dev/null; echo "killed wrapper (pid $UP) in phase images after $(( $(date +%s) - T0 )) s"; break; fi; kill -0 $UP 2>/dev/null || { echo "wrapper exited before the images phase (exit $(wait $UP; echo $?))"; break; }; sleep 1; done
wait $UP 2>/dev/null; redact < "$EV/upgrade-run1.txt" | grep -vE '^\s*$' | tail -15
echo "## state after the interruption"; cat data/state/upgrade.json 2>/dev/null; echo; ls data/state | tr '\n' ' '; echo; [ -f data/state/writers.paused.json ] && echo "fence: $(cat data/state/writers.paused.json)"
echo "## ./blackbox doctor (must report the interrupted upgrade)"; ./blackbox doctor 2>&1 | grep -iE 'upgrade|doctor:' | head -4
echo "## ./blackbox up (must refuse)"; ./blackbox up 2>&1 | tail -1; echo "exit ${PIPESTATUS[0]}"
echo "## ./blackbox upgrade --resume"; T1=$(date +%s); ./blackbox upgrade --resume > "$EV/upgrade-run2-resume.txt" 2>&1; echo "resume exit $? after $(( $(date +%s) - T1 )) s"; redact < "$EV/upgrade-run2-resume.txt" | grep -vE '^\s*$' | tail -20
echo "## after: $(./blackbox status 2>&1 | head -1)"; grep -E '"version"' release.json | head -1; grep BLACKBOX_VERSION .env; [ -f data/state/upgrade.json ] && echo "UPGRADE STATE FILE STILL PRESENT" || echo "upgrade state file removed"; [ -f data/state/writers.paused.json ] && echo "FENCE STILL SET: $(cat data/state/writers.paused.json)" || echo "fence released"; ls data/state/previous-release/ 2>/dev/null | sed 's/^/previous release kept: /'
echo "## pre-upgrade generation"; ls -la "$HOME/blackbox-pilot-ops2-backups" | grep -E 'tar.age' | awk '{print $5, $9}'; python3 -c "import json;d=json.load(open('data/backups/status.json'));print({k:d.get(k) for k in ('status','last_kind','last_generation','last_bytes','last_completed_at')})"
echo "## containers"; docker compose -p blackbox-agent-c-ops2 ps --format '{{.Name}}\t{{.Image}}\t{{.Status}}'
echo "## golden answer after the upgrade"; ./blackbox verify 2>&1 | tail -2
echo "## entries after: $(docker compose -p blackbox-agent-c-ops2 exec -T postgres psql -X -U postgres -d blackbox -Atc 'select count(*) from journal_entries')"
echo "# finished $(date -u +%FT%TZ)  load $(uptime | sed 's/.*load averages: //')"
} > "$EV/upgrade.txt" 2>&1
grep -cE 'AGE-SECRET-KEY-1[A-Z0-9]{10,}|bb[ka]_[A-Za-z0-9_-]{20,}' "$EV/upgrade.txt" "$EV/upgrade-run1.txt" "$EV/upgrade-run2-resume.txt" | sed 's/^/secret-pattern lines: /'
grep -E '^##|exit|killed|FENCE|fence|state file|version|verify|entries' "$EV/upgrade.txt" | cut -c1-200
