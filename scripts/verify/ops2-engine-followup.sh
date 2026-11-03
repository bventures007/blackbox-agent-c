#!/usr/bin/env bash
# PILOT-09 follow-up measurement on the second install (50-tenant smoke corpus), parameterised by engine image so
# the same protocol runs before/after the engine change under the same host conditions:
#   (1) restart with snapshots → time to healthy, engine RSS right after load, RSS after warm-up (300 hot lookups over
#       the perf pools) and after the idle window (ENGINE_WRITE_COPY_IDLE_SECONDS + poll) with host load recorded;
#   (2) no-snapshot rebuild → engine_snapshots cleared as bb_engine (through the loopback proxy) + data/snapshots files
#       removed, engine restarted → time to healthy (API health card, polled every 2 s like scripts/verify/ops2-restart-rebuild.sh),
#       RSS after rebuild and after the idle window.
# Usage: scripts/verify/ops2-engine-followup.sh <engine image> <tag> [override.yml]
#   override.yml (optional) is passed as a second Compose file (image + environment for the engine service only).
set -uo pipefail
IMAGE="${1:?engine image}"; TAG="${2:?tag}"; OVERRIDE="${3:-}"
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; INST=$HOME/blackbox-pilot-ops2; EV=$REPO/reports/evidence/PILOT-09-followup
API=http://127.0.0.1:19185; OWNER=$INST/owner.key; P=blackbox-agent-c-ops2; POOLS=$HOME/blackbox-perf-keys/pools.json
PGPROXY_PORT=19187; PGPASS_FILE=$INST/secrets/pg_engine_password
IDLE_WAIT="${IDLE_WAIT:-100}"
cd "$INST"
COMPOSE=(docker compose -p $P -f infra/compose/docker-compose.yml); [ -n "$OVERRIDE" ] && COMPOSE+=(-f "$OVERRIDE"); COMPOSE+=(--env-file .env)
oapi() { python3 "$REPO/scripts/verify/owner-api.py" "$API" "$OWNER" "$@"; }
engine_health() { oapi GET /api/diagnostics/health | tail -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); c=[x for x in d['cards'] if x['area']=='engine'][0]; print(c['state'], '|', (c.get('reason') or '')[:120])"; }
rss() { docker exec $P-engine sh -c 'grep VmRSS /proc/1/status' 2>/dev/null | awk '{printf "%d", $2*1024}'; }
engine_json() { docker exec $P-api node -e "const fs=require('fs');const tok=fs.readFileSync('/run/secrets/engine_token','utf8').trim();fetch('http://engine:7070/health',{headers:{'x-engine-token':tok}}).then(r=>r.json()).then(j=>{const t=Object.values(j.tenants);console.log(JSON.stringify({status:j.status,rss_mib:+(j.rss_bytes/1048576).toFixed(1),approx_mib:+(j.memory.approx_resident_bytes/1048576).toFixed(1),rss_target_mib:j.memory.rss_target_bytes?j.memory.rss_target_bytes/1048576:null,rss_over_target:j.memory.rss_over_target??null,tenants:t.length,ready:t.filter(x=>x.phase==='ready').length,write_copies_resident:t.filter(x=>x.write_copy_resident).length,write_copies_dropped:t.reduce((s,x)=>s+(x.write_copies_dropped||0),0),write_copies_cloned:t.reduce((s,x)=>s+(x.write_copies_cloned||0),0),evictions:t.reduce((s,x)=>s+(x.evictions||0),0),rss_evictions:t.reduce((s,x)=>s+(x.rss_evictions||0),0),batches:t.reduce((s,x)=>s+(x.batches_applied||0),0)}))})" 2>/dev/null; }
wait_ready() { local t0=$(date +%s); for i in $(seq 1 900); do s="$(engine_health 2>/dev/null)"; case "$s" in healthy*) echo $(( $(date +%s) - t0 )); return 0;; esac; sleep 2; done; echo "timeout"; return 1; }
warm() { node -e "
const fs=require('fs');const P=JSON.parse(fs.readFileSync('$POOLS','utf8'));const cs=P.clients.slice(0,10);
(async()=>{let ok=0,err=0;const lat=[];for(let i=0;i<300;i++){const c=cs[i%cs.length];const key=fs.readFileSync(c.key_file,'utf8').trim();const pool=P.pools[c.tenant_id];const o=pool.hot[(i*7)%pool.hot.length];const t0=Date.now();const r=await fetch('$API/api/entities/order/'+encodeURIComponent(o)+'/state',{headers:{authorization:'Bearer '+key}});lat.push(Date.now()-t0);if(r.status===200)ok++;else err++;}
lat.sort((a,b)=>a-b);console.log(JSON.stringify({requests:300,ok,err,p50_ms:lat[149],p95_ms:lat[284]}));})()"; }
load() { uptime | sed 's/.*load averages: //'; }
{
echo "# ops2 engine follow-up [$TAG] image=$IMAGE override=${OVERRIDE:-none} started $(date -u +%FT%TZ) load $(load)"
echo "## baseline (current container): $(docker ps --format '{{.Image}} {{.Status}}' --filter name=$P-engine); $(engine_health); rss=$(rss)"
echo "## (1) restart with snapshots on image $IMAGE"
"${COMPOSE[@]}" stop engine >/dev/null 2>&1
T0=$(date +%s); "${COMPOSE[@]}" up -d --no-deps engine >/dev/null 2>&1; R1=$(wait_ready); echo "healthy after ${R1} s (snapshot load); $(engine_health); rss=$(rss); load $(load)"
echo "engine json: $(engine_json)"
echo "warm-up: $(warm)"; echo "after warm-up: rss=$(rss); $(engine_json)"
sleep "$IDLE_WAIT"; echo "after ${IDLE_WAIT} s idle: rss=$(rss); load $(load); $(engine_json)"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | grep "$P-engine" | sed 's/^/  docker stats: /'
RSS_STEADY=$(rss)
echo "## (2) no-snapshot rebuild: clear engine_snapshots as bb_engine + snapshot files, restart the engine"
"${COMPOSE[@]}" stop engine >/dev/null 2>&1
node -e "const pg=require('$REPO/node_modules/pg');const fs=require('fs');const c=new pg.Client({host:'127.0.0.1',port:$PGPROXY_PORT,user:'bb_engine',password:fs.readFileSync('$PGPASS_FILE','utf8').trim(),database:'blackbox'});c.connect().then(()=>c.query('DELETE FROM engine_snapshots')).then(r=>console.log('engine_snapshots rows deleted as bb_engine:',r.rowCount)).then(()=>c.query('SELECT count(*)::int AS n FROM engine_snapshots')).then(r=>console.log('rows left:',r.rows[0].n)).then(()=>c.end()).catch(e=>{console.error('ERR',e.message);process.exit(1)})"
ls data/snapshots 2>/dev/null | wc -l | sed 's/^/snapshot files before: /'; rm -rf data/snapshots/* 2>/dev/null; ls data/snapshots 2>/dev/null | wc -l | sed 's/^/snapshot files after: /'
echo "load before rebuild $(load)"; T0=$(date +%s); "${COMPOSE[@]}" up -d --no-deps engine >/dev/null 2>&1; R2=$(wait_ready); echo "healthy after ${R2} s (rebuilt from the journal); $(engine_health); rss=$(rss); load $(load)"
echo "engine json: $(engine_json)"
docker logs --since 20m $P-engine 2>&1 | python3 -c "
import sys,json,collections
c=collections.Counter(); first=None; last=None
for l in sys.stdin:
    try: r=json.loads(l)
    except: continue
    c[r.get('event_name')]+=1
    if r.get('event_name')=='engine.batch_applied': last=r.get('timestamp') or r.get('ts') or r.get('time')
print('engine events since restart:', c.most_common(12))"
sleep "$IDLE_WAIT"; echo "after ${IDLE_WAIT} s idle: rss=$(rss); load $(load); $(engine_json)"
echo "warm-up: $(warm)"; echo "after warm-up: rss=$(rss); $(engine_json)"
RSS_REBUILT=$(rss)
python3 - "$TAG" "$IMAGE" "$R1" "$RSS_STEADY" "$R2" "$RSS_REBUILT" "$(load)" > "$EV/measurement-$TAG.json" <<'PY'
import json,sys,datetime
tag,image,r1,rss1,r2,rss2,load=sys.argv[1:8]
print(json.dumps({"tag":tag,"engine_image":image,"restart_with_snapshot_seconds":(int(r1) if r1.isdigit() else None),"engine_rss_bytes_steady_after_warmup_and_idle":int(rss1 or 0),"no_snapshot_rebuild_seconds":(int(r2) if r2.isdigit() else None),"engine_rss_bytes_after_rebuild_idle_and_warmup":int(rss2 or 0),"host_load_at_end":load,"measured_at":datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=1))
PY
echo "## golden answer after both restarts"; ./blackbox verify 2>&1 | tail -2
echo "# finished $(date -u +%FT%TZ) load $(load)"
} > "$EV/measurement-$TAG.txt" 2>&1
grep -cE 'bb[ka]_[A-Za-z0-9_-]{20,}' "$EV/measurement-$TAG.txt" | sed 's/^/secret-pattern lines: /'; grep -E '^##|healthy after|rss=|warm-up|verify|deleted' "$EV/measurement-$TAG.txt" | cut -c1-260
