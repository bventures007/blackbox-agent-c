#!/usr/bin/env bash
# LOCAL-08 restart-with-unapplied-tail on the second install with the follow-up engine image (same protocol as
# scripts/verify/ops2-restart-rebuild.sh part (1)): engine stopped, 1,000 observations (= 3,000 journal entries)
# ingested through the owner replay path while it is down, engine started with the given Compose override,
# time until the API health card reports healthy and the owner tenant's applied cursor reaches the committed cursor.
# Usage: scripts/verify/ops2-restart-tail-followup.sh <override.yml abs path> <out-dir abs path>
set -uo pipefail
OVERRIDE="${1:?override}"; EV="${2:?out dir}"
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; INST=$HOME/blackbox-pilot-ops2; API=http://127.0.0.1:19185; OWNER=$INST/owner.key; P=blackbox-agent-c-ops2
cd "$INST"; mkdir -p "$EV"
COMPOSE=(docker compose -p $P -f infra/compose/docker-compose.yml -f "$OVERRIDE" --env-file .env)
oapi() { python3 "$REPO/scripts/verify/owner-api.py" "$API" "$OWNER" "$@"; }
engine_health() { oapi GET /api/diagnostics/health | tail -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); c=[x for x in d['cards'] if x['area']=='engine'][0]; print(c['state'], '|', (c.get('reason') or '')[:120])"; }
rss() { docker exec $P-engine sh -c 'grep VmRSS /proc/1/status' 2>/dev/null | awk '{printf "%d", $2*1024}'; }
load() { uptime | sed 's/.*load averages: //'; }
wait_ready() { local t0=$(date +%s); for i in $(seq 1 600); do s="$(engine_health 2>/dev/null)"; case "$s" in healthy*) echo $(( $(date +%s) - t0 )); return 0;; esac; sleep 2; done; echo "timeout"; return 1; }
{
echo "# restart-with-tail follow-up started $(date -u +%FT%TZ) load $(load); override=$OVERRIDE"
echo "## baseline: $(engine_health); rss=$(rss)"
REPLAY=$(oapi GET /api/sources | tail -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); c=[x for p in d['catalogue'] for x in p['connections'] if x['display_name']=='pilot06 replay']; print(c[0]['connection_id'])")
BEFORE=$(oapi GET /api/workspace | tail -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('tenant_id'))")
"${COMPOSE[@]}" stop engine >/dev/null 2>&1; echo "engine stopped $(date -u +%FT%TZ)"
TAG=$(date +%s)
T0=$(date +%s); python3 - "$REPLAY" "$OWNER" "$API" "$REPO" "$TAG" <<'PY'
import json,sys,subprocess
conn,owner,api,repo,tag=sys.argv[1:6]
ev=[{"provider_event_id":f"tail2-{tag}-{i}","kind":"order.accepted","occurred_at":"2026-10-31T09:00:00Z","entity":{"order":f"#TAIL2-{tag}-{i}"},"payload":{"order":f"#TAIL2-{tag}-{i}","quantity":1,"unit":"piece","unit_gross_minor":100,"gross_minor":100,"currency":"EUR","status":"accepted"},"evidence_refs":[]} for i in range(1000)]
acc=0
for k in range(0,1000,200):
    out=subprocess.run(["python3",f"{repo}/scripts/verify/owner-api.py",api,owner,"POST","/api/ingest/replay",json.dumps({"connection_id":conn,"events":ev[k:k+200]})],capture_output=True,text=True).stdout.strip().split("\n")
    try: acc+=json.loads(out[-1])["accepted"]
    except Exception: print("batch",k,"->",out[0][:200])
print("accepted observations:",acc)
PY
echo "ingest wall: $(( $(date +%s) - T0 )) s"
echo "## start the engine, time to healthy (all tenants ready, applied = committed)"; T0=$(date +%s); "${COMPOSE[@]}" up -d --no-deps engine >/dev/null 2>&1; R=$(wait_ready); echo "engine healthy after ${R} s; $(engine_health); rss=$(rss); load $(load)"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | grep "$P-engine" | sed 's/^/  /'
python3 - "$R" "$(rss)" > "$EV/restart.json" <<'PY'
import json,sys; print(json.dumps({"class":"restart_with_unapplied_tail","tail_entries":3000,"unapplied_tail_entries":3000,"unapplied_tail_observations":1000,"ready_seconds":(int(sys.argv[1]) if sys.argv[1].isdigit() else None),"time_to_ready_seconds":(int(sys.argv[1]) if sys.argv[1].isdigit() else None),"engine_rss_bytes_after":int(sys.argv[2] or 0),"engine_image":"blackbox/engine:0.1.0-followup","measured_at":__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),"source":"scripts/verify/ops2-restart-tail-followup.sh"},indent=1))
PY
echo "# finished $(date -u +%FT%TZ) load $(load)"
} > "$EV/restart-tail.txt" 2>&1
grep -cE 'bb[ka]_[A-Za-z0-9_-]{20,}' "$EV/restart-tail.txt" | sed 's/^/secret-pattern lines: /'; grep -E '^##|accepted|healthy after|rss=' "$EV/restart-tail.txt" | cut -c1-220
