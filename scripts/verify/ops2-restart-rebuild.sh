#!/usr/bin/env bash
# LOCAL-08/09 on the second install with the smoke corpus: (1) restart with a 1000-entry unapplied tail — engine stopped,
# 1000 observations ingested through the owner replay path while it is down, engine started: time until every tenant is
# ready and the owner tenant's applied cursor reaches the committed cursor, engine RSS and docker stats; (2) no-snapshot
# rebuild — all engine snapshots removed, engine restarted: time to healthy, RSS. Evidence: $EV/restart-tail.json, rebuild.json, part4.txt.
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; INST=$HOME/blackbox-pilot-ops2; EV=$REPO/reports/evidence/PILOT-09-rerun; API=http://127.0.0.1:19185; OWNER=$INST/owner.key; P=blackbox-agent-c-ops2; cd "$INST"
oapi() { python3 "$REPO/scripts/verify/owner-api.py" "$API" "$OWNER" "$@"; }
engine_health() { oapi GET /api/diagnostics/health | tail -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); c=[x for x in d['cards'] if x['area']=='engine'][0]; print(c['state'], '|', (c.get('reason') or '')[:120])"; }
rss() { docker exec $P-engine sh -c 'grep VmRSS /proc/1/status' 2>/dev/null | awk '{printf "%d", $2*1024}'; }
wait_ready() { local t0=$(date +%s); for i in $(seq 1 600); do s="$(engine_health 2>/dev/null)"; case "$s" in healthy*) echo $(( $(date +%s) - t0 )); return 0;; esac; sleep 2; done; echo "timeout"; return 1; }
{
echo "# ops2 part 4  started $(date -u +%FT%TZ)  load $(uptime | sed 's/.*load averages: //')"
echo "## baseline: $(engine_health); rss=$(rss)"; docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | grep "$P" | sed 's/^/  /'
REPLAY=$(oapi GET /api/sources | tail -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); c=[x for p in d['catalogue'] for x in p['connections'] if x['display_name']=='pilot06 replay']; print(c[0]['connection_id'])")
echo "## (1) stop the engine, ingest 1000 observations through the owner replay path while it is down"
docker compose -p $P stop engine >/dev/null 2>&1; echo "engine stopped $(date -u +%FT%TZ)"
T0=$(date +%s); python3 - "$REPLAY" "$OWNER" "$API" "$REPO" <<'PY'
import json,sys,subprocess
conn,owner,api,repo=sys.argv[1:5]
ev=[{"provider_event_id":f"tail-{i}","kind":"order.accepted","occurred_at":"2026-10-31T09:00:00Z","entity":{"order":f"#TAIL-{i}"},"payload":{"order":f"#TAIL-{i}","quantity":1,"unit":"piece","unit_gross_minor":100,"gross_minor":100,"currency":"EUR","status":"accepted"},"evidence_refs":[]} for i in range(1000)]
acc=0
for k in range(0,1000,200):
    out=subprocess.run(["python3",f"{repo}/scripts/verify/owner-api.py",api,owner,"POST","/api/ingest/replay",json.dumps({"connection_id":conn,"events":ev[k:k+200]})],capture_output=True,text=True).stdout.strip().split("\n")
    try: acc+=json.loads(out[-1])["accepted"]
    except Exception: print("batch",k,"->",out[0][:200])
print("accepted observations:",acc)
PY
echo "ingest wall: $(( $(date +%s) - T0 )) s"
COMMITTED=$(oapi GET /api/workspace | tail -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('tenant_id'))"); echo "owner tenant $COMMITTED"
echo "## start the engine, time to healthy (all tenants ready, applied = committed)"; T0=$(date +%s); docker compose -p $P start engine >/dev/null 2>&1; R=$(wait_ready); echo "engine healthy after ${R} s; $(engine_health); rss=$(rss)"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | grep "$P" | sed 's/^/  /'
python3 - "$R" "$(rss)" > "$EV/restart-tail.json" <<'PY'
import json,sys; print(json.dumps({"class":"restart_with_unapplied_tail","tail_entries":1000,"time_to_ready_seconds":(int(sys.argv[1]) if sys.argv[1].isdigit() else None),"engine_rss_bytes":int(sys.argv[2] or 0),"measured_at":__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()},indent=1))
PY
echo "## (2) no-snapshot rebuild: remove every engine snapshot (table + files), restart the engine"
docker compose -p $P stop engine >/dev/null 2>&1
docker compose -p $P exec -T postgres psql -X -U postgres -d blackbox -Atc "DELETE FROM engine_snapshots; SELECT count(*) FROM engine_snapshots" 2>&1 | tail -1 | sed 's/^/snapshots left in table: /'
ls data/snapshots 2>/dev/null | wc -l | sed 's/^/snapshot files before: /'; rm -rf data/snapshots/* 2>/dev/null; ls data/snapshots 2>/dev/null | wc -l | sed 's/^/snapshot files after: /'
T0=$(date +%s); docker compose -p $P start engine >/dev/null 2>&1; R2=$(wait_ready); echo "engine healthy after ${R2} s (rebuilt from the journal); $(engine_health); rss=$(rss)"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | grep "$P" | sed 's/^/  /'
docker logs --since 15m $P-engine 2>&1 | python3 -c "
import sys,json,collections
c=collections.Counter()
for l in sys.stdin:
    try: r=json.loads(l)
    except: continue
    c[r.get('event_name')]+=1
print('engine events since restart:', c.most_common(10))"
python3 - "$R2" "$(rss)" > "$EV/rebuild.json" <<'PY'
import json,sys; print(json.dumps({"class":"no_snapshot_rebuild","time_to_ready_seconds":(int(sys.argv[1]) if sys.argv[1].isdigit() else None),"engine_rss_bytes":int(sys.argv[2] or 0),"measured_at":__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()},indent=1))
PY
echo "## golden answer after both restarts"; ./blackbox verify 2>&1 | tail -2
echo "# finished $(date -u +%FT%TZ)  load $(uptime | sed 's/.*load averages: //')"
} > "$EV/part4.txt" 2>&1
grep -cE 'bb[ka]_[A-Za-z0-9_-]{20,}' "$EV/part4.txt" | sed 's/^/secret-pattern lines: /'; grep -E '^##|after|accepted|rss=|verify' "$EV/part4.txt" | cut -c1-220
