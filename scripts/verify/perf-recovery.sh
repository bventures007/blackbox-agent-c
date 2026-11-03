#!/usr/bin/env bash
# PILOT-09 recovery classes on the dedicated perf install (contract: snapshot restart with a 1,000-entry unapplied
# tail ready <= 30 s; no-snapshot rebuild ready <= 180 s):
#   (1) engine stopped; TAIL_OBS observations (3 journal entries each) ingested through the owner replay path while
#       it is down (tail size = committed cursor delta of the owner tenant, read from the replay acks); engine started
#       from its snapshots; time until the API health card reports the engine healthy (every tenant ready, applied =
#       committed, polled every 1 s); engine lag/RSS and an authorized hot-set query afterwards.
#   (2) engine stopped; engine_snapshots cleared as bb_engine through the loopback proxy + data/snapshots files removed;
#       engine started; time to healthy; engine_checkpoints (applied_sequence, state_hash) of every tenant compared with
#       the values recorded before the rebuild (identical state hashes = identical rebuilt state); golden verify.
# Usage: scripts/verify/perf-recovery.sh   (env: INST, P, PORT, PGPROXY_PORT, POOLS, EV, TAIL_OBS)
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c
INST="${INST:-$HOME/blackbox-pilot-perf}"; P="${P:-blackbox-agent-c-perf}"; PORT="${PORT:-19180}"; PGPROXY_PORT="${PGPROXY_PORT:-19197}"
POOLS="${POOLS:-$HOME/blackbox-perf-keys-perf/pools.json}"; EV="${EV:-$REPO/reports/evidence/PILOT-09-perf}"
OWNER="$INST/owner.key"; API=http://127.0.0.1:$PORT; TAIL_OBS="${TAIL_OBS:-334}"
PGPASS_FILE=$INST/secrets/pg_engine_password; ENGINE_IMAGE="$(docker inspect --format '{{.Config.Image}}' $P-engine 2>/dev/null)"
cd "$INST"; mkdir -p "$EV"
COMPOSE=(docker compose -p $P -f infra/compose/docker-compose.yml --env-file .env)
oapi() { python3 "$REPO/scripts/verify/owner-api.py" "$API" "$OWNER" "$@"; }
engine_health() { oapi GET /api/diagnostics/health | tail -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); c=[x for x in d['cards'] if x['area']=='engine'][0]; print(c['state'], '|', (c.get('reason') or '')[:120])"; }
rss() { docker exec $P-engine sh -c 'grep VmRSS /proc/1/status' 2>/dev/null | awk '{printf "%d", $2*1024}'; }
load() { uptime | sed 's/.*load averages: //'; }
engine_json() { docker exec $P-api node -e "const fs=require('fs');const tok=fs.readFileSync('/run/secrets/engine_token','utf8').trim();fetch('http://engine:7070/health',{headers:{'x-engine-token':tok}}).then(r=>r.json()).then(j=>{const t=Object.values(j.tenants);console.log(JSON.stringify({status:j.status,rss_mib:+(j.rss_bytes/1048576).toFixed(1),approx_mib:+(j.memory.approx_resident_bytes/1048576).toFixed(1),tenants:t.length,ready:t.filter(x=>x.phase==='ready').length,lag_entries:t.reduce((s,x)=>s+(x.lag_entries||0),0),loaded_from_snapshot:t.filter(x=>x.loaded_from_snapshot).length,batches:t.reduce((s,x)=>s+(x.batches_applied||0),0),entries_applied:t.reduce((s,x)=>s+(x.entries_applied||0),0)}))})" 2>/dev/null; }
# polled every second: the API card says healthy only when every tenant is ready (applied = committed)
wait_ready() { local t0=$(date +%s); for i in $(seq 1 1200); do s="$(engine_health 2>/dev/null)"; case "$s" in healthy*) echo $(( $(date +%s) - t0 )); return 0;; esac; sleep 1; done; echo "timeout"; return 1; }
checkpoints() { node -e "const pg=require('$REPO/node_modules/pg');const fs=require('fs');const c=new pg.Client({host:'127.0.0.1',port:$PGPROXY_PORT,user:'bb_engine',password:fs.readFileSync('$PGPASS_FILE','utf8').trim(),database:'blackbox'});c.connect().then(()=>c.query('SELECT tenant_id, applied_sequence, state_hash FROM engine_checkpoints ORDER BY tenant_id')).then(r=>{for(const x of r.rows)console.log(x.tenant_id+'|'+x.applied_sequence+'|'+x.state_hash)}).then(()=>c.end()).catch(e=>{console.error('ERR',e.message);process.exit(1)})"; }
hot_query() { node -e "
const fs=require('fs');const P=JSON.parse(fs.readFileSync('$POOLS','utf8'));const c=P.clients[0];const key=fs.readFileSync(c.key_file,'utf8').trim();const o=P.pools[c.tenant_id].hot[3];
(async()=>{const t0=Date.now();const r=await fetch('$API/api/entities/order/'+encodeURIComponent(o)+'/state',{headers:{authorization:'Bearer '+key}});const j=await r.json();console.log(JSON.stringify({status:r.status,consistency:j.consistency&&j.consistency.status,ms:Date.now()-t0}));})()"; }
{
echo "# perf recovery started $(date -u +%FT%TZ) load $(load); engine image $ENGINE_IMAGE; commit $(git -C $REPO rev-parse HEAD)"
echo "## baseline: $(engine_health); rss=$(rss); $(engine_json)"
TENANT=$(oapi GET /api/workspace | tail -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('tenant_id'))")
REPLAY=$(oapi GET /api/sources | tail -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); c=[x for p in d['catalogue'] for x in p['connections'] if x['display_name']=='perf tail replay' and x['status']!='disconnected']; print(c[0]['connection_id'] if c else '')")
[ -n "$REPLAY" ] || REPLAY=$(oapi POST /api/sources/connections '{"provider":"replay","display_name":"perf tail replay","config":{"synthetic":true,"purpose":"PILOT-09 restart tail"}}' | tail -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print((d.get('connection') or d)['connection_id'])")
echo "owner tenant $TENANT; replay connection $REPLAY"
# committed cursor of the owner tenant before the tail (engine health, tenant block)
BEFORE=$(docker exec $P-api node -e "const fs=require('fs');const tok=fs.readFileSync('/run/secrets/engine_token','utf8').trim();fetch('http://engine:7070/health',{headers:{'x-engine-token':tok}}).then(r=>r.json()).then(j=>console.log(j.tenants['$TENANT'].committed_cursor))" 2>/dev/null)
echo "## (1) restart with an unapplied tail: engine stopped, $TAIL_OBS observations ingested while it is down (owner committed cursor before: $BEFORE)"
"${COMPOSE[@]}" stop engine >/dev/null 2>&1; echo "engine stopped $(date -u +%FT%TZ)"
TAG=$(date +%s); T0=$(date +%s)
AFTER=$(python3 - "$REPLAY" "$OWNER" "$API" "$REPO" "$TAG" "$TAIL_OBS" <<'PY'
import json,sys,subprocess
conn,owner,api,repo,tag,n=sys.argv[1:7]; n=int(n)
ev=[{"provider_event_id":f"tail-{tag}-{i}","kind":"order.accepted","occurred_at":"2026-10-31T09:00:00Z","entity":{"order":f"#TAIL-{tag}-{i}","customer":f"C-TAIL-{i%7}","item":f"SKU-TAIL-{i%5}"},"payload":{"order":f"#TAIL-{tag}-{i}","quantity":1,"unit":"piece","unit_gross_minor":100,"gross_minor":100,"currency":"EUR","status":"accepted"},"evidence_refs":[]} for i in range(n)]
acc=0; last=None
for k in range(0,n,200):
    out=subprocess.run(["python3",f"{repo}/scripts/verify/owner-api.py",api,owner,"POST","/api/ingest/replay",json.dumps({"connection_id":conn,"events":ev[k:k+200]})],capture_output=True,text=True).stdout.strip().split("\n")
    try:
        b=json.loads(out[-1]); acc+=b["accepted"]; last=b.get("committed_cursor")
    except Exception: print("batch",k,"->",out[0][:200],file=sys.stderr)
print(json.dumps({"accepted":acc,"committed_cursor":last}))
PY
)
echo "ingest: $AFTER; wall $(( $(date +%s) - T0 )) s"
LASTC=$(echo "$AFTER" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['committed_cursor'])")
TAIL=$(( LASTC - BEFORE )); echo "unapplied tail = $LASTC - $BEFORE = $TAIL journal entries"
echo "## start the engine (snapshots present), time to healthy"; T0=$(date +%s); "${COMPOSE[@]}" up -d --no-deps engine >/dev/null 2>&1; R=$(wait_ready); echo "engine healthy after ${R} s; $(engine_health); rss=$(rss); load $(load)"
echo "engine json: $(engine_json)"; echo "authorized hot query after restart: $(hot_query)"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | grep "$P-engine" | sed 's/^/  /'
python3 - "$R" "$(rss)" "$TAIL" "$TAIL_OBS" "$ENGINE_IMAGE" "$(load)" > "$EV/restart.json" <<'PY'
import json,sys,datetime
r,rss,tail,obs,img,load=sys.argv[1:7]
print(json.dumps({"class":"restart_with_unapplied_tail","unapplied_tail_entries":int(tail),"unapplied_tail_observations":int(obs),"ready_seconds":(int(r) if r.isdigit() else None),"time_to_ready_seconds":(int(r) if r.isdigit() else None),"engine_rss_bytes_after":int(rss or 0),"engine_image":img,"host_load_after":load,"measured_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"source":"scripts/verify/perf-recovery.sh","ready_definition":"API health card engine=healthy (every tenant ready, applied cursor = committed cursor), polled every 1 s from the compose up command"},indent=1))
PY
sleep 20
echo "## (2) no-snapshot rebuild: checkpoints before"; checkpoints > "$EV/checkpoints-before-rebuild.txt"; wc -l < "$EV/checkpoints-before-rebuild.txt" | sed 's/^/tenants with checkpoints: /'
"${COMPOSE[@]}" stop engine >/dev/null 2>&1; echo "engine stopped $(date -u +%FT%TZ)"
node -e "const pg=require('$REPO/node_modules/pg');const fs=require('fs');const c=new pg.Client({host:'127.0.0.1',port:$PGPROXY_PORT,user:'bb_engine',password:fs.readFileSync('$PGPASS_FILE','utf8').trim(),database:'blackbox'});c.connect().then(()=>c.query('DELETE FROM engine_snapshots')).then(r=>console.log('engine_snapshots rows deleted as bb_engine:',r.rowCount)).then(()=>c.query('SELECT count(*)::int AS n FROM engine_snapshots')).then(r=>console.log('rows left:',r.rows[0].n)).then(()=>c.end()).catch(e=>{console.error('ERR',e.message);process.exit(1)})"
ls data/snapshots 2>/dev/null | wc -l | sed 's/^/snapshot files before: /'; rm -rf data/snapshots/* 2>/dev/null; ls data/snapshots 2>/dev/null | wc -l | sed 's/^/snapshot files after: /'
echo "load before rebuild $(load)"; T0=$(date +%s); "${COMPOSE[@]}" up -d --no-deps engine >/dev/null 2>&1; R2=$(wait_ready); echo "engine healthy after ${R2} s (rebuilt from the journal); $(engine_health); rss=$(rss); load $(load)"
echo "engine json: $(engine_json)"; echo "authorized hot query after rebuild: $(hot_query)"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' | grep "$P-engine" | sed 's/^/  /'
docker logs --since 30m $P-engine 2>&1 | python3 -c "
import sys,json,collections
c=collections.Counter()
for l in sys.stdin:
    try: r=json.loads(l)
    except: continue
    c[r.get('event_name')]+=1
print('engine events since restart:', c.most_common(12))"
echo "## checkpoints after the rebuild vs before"; sleep 15; checkpoints > "$EV/checkpoints-after-rebuild.txt"
python3 - "$EV/checkpoints-before-rebuild.txt" "$EV/checkpoints-after-rebuild.txt" <<'PY'
import sys
b={l.split('|')[0]:l.strip().split('|')[1:] for l in open(sys.argv[1]) if '|' in l}
a={l.split('|')[0]:l.strip().split('|')[1:] for l in open(sys.argv[2]) if '|' in l}
same=sum(1 for t in b if t in a and a[t]==b[t]); moved=[t for t in b if t in a and a[t][0]!=b[t][0]]; diff=[t for t in b if t in a and a[t][0]==b[t][0] and a[t][1]!=b[t][1]]
print(f"tenants: {len(b)} before, {len(a)} after; identical (sequence+state_hash): {same}; cursor moved (new entries): {len(moved)}; SAME cursor but DIFFERENT hash: {len(diff)} {diff[:3]}")
PY
RSS2=$(rss)
python3 - "$R2" "$RSS2" "$ENGINE_IMAGE" "$(load)" > "$EV/rebuild.json" <<'PY'
import json,sys,datetime
r,rss,img,load=sys.argv[1:5]
print(json.dumps({"class":"no_snapshot_rebuild","ready_seconds":(int(r) if r.isdigit() else None),"time_to_ready_seconds":(int(r) if r.isdigit() else None),"engine_rss_bytes_after":int(rss or 0),"engine_image":img,"host_load_after":load,"measured_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"source":"scripts/verify/perf-recovery.sh","method":"engine_snapshots deleted as bb_engine + data/snapshots emptied while the engine was stopped; engine started; API health card engine=healthy polled every 1 s; engine_checkpoints state hashes compared before/after"},indent=1))
PY
echo "## golden answer after both restarts (./blackbox verify)"; ./blackbox verify 2>&1 | tail -2; echo "verify exit ${PIPESTATUS[0]}"
echo "# finished $(date -u +%FT%TZ) load $(load)"
} > "$EV/recovery.txt" 2>&1
grep -cE 'bb[ka]_[A-Za-z0-9_-]{20,}' "$EV/recovery.txt" | sed 's/^/secret-pattern lines: /'; cut -c1-300 "$EV/recovery.txt"
