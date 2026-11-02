#!/usr/bin/env bash
# Fresh install, after SLICE-01: INSTALL-02 (restart keeps the demo answer + evidence links), HEALTH-01/02/03 + DIAG-02
# (observed values; engine stopped -> card not green within 5 s; restored), DIAG-04 (CLI logs/doctor/export with the
# containers down), LOCAL-06 (owner key rotation: old key refused, sessions invalidated, new key shown once).
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; INST=$HOME/blackbox-pilot-fresh; API=http://127.0.0.1:19180; OWNER=$INST/owner.key; P=blackbox-agent-c; EV=$REPO/reports/evidence; cd "$INST"
oapi() { python3 "$REPO/scripts/verify/owner-api.py" "$API" "$OWNER" "$@"; }
cards() { curl -s -b "$1" "$API/api/diagnostics/health" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(' | '.join(f\"{c['area']}={c['state']}\" for c in d['cards']), '| observed', d.get('observed_at'))"; }
{
echo "# INSTALL-02  $(date -u +%FT%TZ)"
echo "## answer snapshot before restart"; "$REPO/scripts/release/answer-snapshot.sh" "$API" "$OWNER" "$EV/INSTALL-02/answer-before.json" 2>&1 | tail -2
echo "## ./blackbox down && ./blackbox up"; T0=$(date +%s); ./blackbox down 2>&1 | tail -1; ./blackbox up 2>&1 | tail -1; echo "restart wall: $(( $(date +%s) - T0 )) s"
echo "## answer snapshot after restart"; "$REPO/scripts/release/answer-snapshot.sh" "$API" "$OWNER" "$EV/INSTALL-02/answer-after.json" 2>&1 | tail -2
python3 - "$EV/INSTALL-02/answer-before.json" "$EV/INSTALL-02/answer-after.json" <<'PY'
import json,sys
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
drop=lambda d:{k:v for k,v in d.items() if k not in ('captured_at','consistency','readiness','page','timing')}
print("identical business content (status/result/evidence refs/entry ids):", drop(a)==drop(b)); print("status:", a.get('status'), b.get('status'), "| available:", (a.get('result') or {}).get('available'), (b.get('result') or {}).get('available'), "| evidence refs:", len(a.get('evidence_refs',[])), len(b.get('evidence_refs',[])))
PY
echo "## evidence links resolvable after restart (first 3 citations of the answer)"; python3 - "$EV/INSTALL-02/answer-after.json" "$API" "$OWNER" "$REPO" <<'PY'
import json,sys,subprocess
d=json.load(open(sys.argv[1])); api,owner,repo=sys.argv[2:5]
refs=[r for r in d.get('evidence_refs',[])][:3]
for r in refs:
    eid=r.split(':',1)[1] if ':' in r else r
    path=f"/api/journal/{eid}" if r.startswith('journal:') else f"/api/evidence/{eid}"
    out=subprocess.run(['python3',f'{repo}/scripts/verify/owner-api.py',api,owner,'GET',path],capture_output=True,text=True).stdout.split('\n')
    print(' ', r, '->', out[0], (out[-1][:90] if len(out)>1 else ''))
PY
echo; echo "# HEALTH-01/02/03 + DIAG-02  $(date -u +%FT%TZ)"
KEY=$(cat "$OWNER"); J=$(mktemp); curl -s -c "$J" -H 'content-type: application/json' -H "origin: $API" -d "{\"key\":\"$KEY\",\"remember\":false}" -o /dev/null "$API/api/auth/login"; unset KEY
echo "## source health (fixture connection from SLICE-01): last successful check vs last new event"; oapi GET /api/sources | tail -1 | python3 -c "
import json,sys; d=json.loads(sys.stdin.read())
for p in d['catalogue']:
    for c in p['connections']:
        if 'fixture' in (c.get('display_name') or '').lower() or p['provider']=='shopify':
            print(' ', p['provider'], c['display_name'], c['status'])
            for cap in p.get('capabilities',[])[:4]: print('    ', cap.get('id'), cap.get('state'), 'last_ok', cap.get('last_successful_check_at'), 'last_new', cap.get('last_new_event_at'), 'next', cap.get('next_check_at'), cap.get('next_check_reason'))
"
echo "## readiness (answer data status) — order-01 answer consistency/coverage"; python3 -c "import json; d=json.load(open('$EV/INSTALL-02/answer-after.json')); print(json.dumps({k:d.get(k) for k in ('consistency','coverage')}, default=str)[:600])"
echo "## health cards baseline"; cards "$J"
echo "## stop the engine; sample the cards every second for 8 s"; docker compose -p $P stop engine >/dev/null 2>&1; T0=$(date +%s.%N); for i in 1 2 3 4 5 6 7 8; do printf '  +%ss ' "$i"; cards "$J"; sleep 1; done
echo "## question while the engine is down (must be explicit unavailable/retryable, never stale-as-current)"; oapi POST /api/questions/inventory.available_to_sell '{"params":{"item_id":"CUP-OLV","requested_quantity":100}}' | head -2 | cut -c1-300
echo "## start the engine; cards until healthy"; docker compose -p $P start engine >/dev/null 2>&1; for i in $(seq 1 60); do s="$(cards "$J")"; echo "  +${i}s $s" | grep -q 'engine=healthy' && { echo "  +${i}s $s"; break; }; sleep 1; done
echo "## top-bar runtime status source: GET /api/diagnostics/health stale_after/refresh"; curl -s -b "$J" "$API/api/diagnostics/health" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print({k:d.get(k) for k in ('refresh_interval_seconds','stale_after_seconds')})"
rm -f "$J"
echo; echo "# DIAG-04  $(date -u +%FT%TZ)"
./blackbox down 2>&1 | tail -1
echo "## ./blackbox logs --since 1h --level warn (containers down)"; ./blackbox logs --since 1h --level warn 2>&1 | tail -4 | cut -c1-200; echo "exit ${PIPESTATUS[0]}"
echo "## ./blackbox logs --since 1h --format json | head (containers down)"; ./blackbox logs --since 1h --format json 2>/dev/null | head -2 | cut -c1-200
echo "## ./blackbox doctor (containers down)"; ./blackbox doctor 2>&1 | grep -E 'DOC-SERVICES|DOC-API|doctor:' | head -3
echo "## ./blackbox diagnostics export --since 2h --output <scratch> (containers down)"; OUT=$REPO/reports/evidence/HEALTH-DIAG/diagnostics-export-containers-down.zip; ./blackbox diagnostics export --since 2h --output "$OUT" 2>&1 | tail -2; ls -la "$OUT" | awk '{print "bundle bytes:", $5}'; python3 - "$OUT" <<'PY'
import zipfile,sys,re
z=zipfile.ZipFile(sys.argv[1]); names=z.namelist(); print("members:", names[:12], "count", len(names))
blob=b"".join(z.read(n) for n in names)
pats={'owner key':rb'bbk_[A-Za-z0-9_-]{20,}','agent key':rb'bba_[A-Za-z0-9_-]{20,}','session cookie':rb'bb_session=','shopify token':rb'shpat_','home path':rb'/Users/benediktsauter','order payload':rb'gross_minor'}
for k,p in pats.items(): print(f"  {k}: {len(re.findall(p,blob))} matches")
PY
./blackbox up 2>&1 | tail -1
echo; echo "# LOCAL-06 owner key rotation  $(date -u +%FT%TZ)"
echo "## session with the current key, then ./blackbox rotate-key (current key on stdin, new key captured to owner.key.new 0600)"
KEY=$(cat "$OWNER"); J=$(mktemp); curl -s -c "$J" -H 'content-type: application/json' -H "origin: $API" -d "{\"key\":\"$KEY\",\"remember\":true}" -o /dev/null -w 'login(old) %{http_code}\n' "$API/api/auth/login"
printf '%s\n' "$KEY" | python3 "$REPO/scripts/verify/pty-capture.py" "$INST" "$INST/owner.key.new" "$EV/LOCAL-06-rerun/rotate-key-transcript-redacted.txt" -- ./blackbox rotate-key; unset KEY
echo "## old session after rotation (must be invalid)"; curl -s -b "$J" -o /dev/null -w 'GET /api/auth/session with the old session cookie: %{http_code}\n' "$API/api/auth/session"
echo "## old key after rotation (must be refused)"; OLDRC=$(curl -s -H 'content-type: application/json' -H "origin: $API" -d "{\"key\":\"$(cat "$OWNER")\",\"remember\":false}" -o /dev/null -w '%{http_code}' "$API/api/auth/login"); echo "login(old key): $OLDRC"
if [ -s "$INST/owner.key.new" ]; then mv "$INST/owner.key" "$INST/owner.key.retired" && mv "$INST/owner.key.new" "$INST/owner.key" && chmod 0600 "$INST/owner.key" && echo "## new key: login $(curl -s -H 'content-type: application/json' -H "origin: $API" -d "{\"key\":\"$(cat "$OWNER")\",\"remember\":false}" -o /dev/null -w '%{http_code}' "$API/api/auth/login") (owner.key replaced; retired key kept 0600 outside the repo for the record)"; chmod 0600 "$INST/owner.key.retired"; else echo "NEW KEY NOT CAPTURED"; fi
rm -f "$J"
echo "## security audit counts"; oapi GET /api/settings/security | tail -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print({k:v for k,v in d['counts'].items()})"
echo "# finished $(date -u +%FT%TZ)"
} > "$EV/HEALTH-DIAG/fresh-part5.txt" 2>&1
grep -cE 'bb[ka]_[A-Za-z0-9_-]{20,}' "$EV/HEALTH-DIAG/fresh-part5.txt" "$EV/LOCAL-06-rerun/rotate-key-transcript-redacted.txt" | sed 's/^/secret-pattern lines: /'; grep -E '^#|identical|restart wall|login|engine=|exit|bundle|matches|NEW KEY|->' "$EV/HEALTH-DIAG/fresh-part5.txt" | cut -c1-220 | head -60
