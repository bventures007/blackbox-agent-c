#!/usr/bin/env bash
# PILOT-09 / OPS-05 smoke protocol on the dedicated perf install (fresh install of the tested commit, contract-sized
# corpus): sequential API closed-loop, API fixed-arrival, MCP closed-loop, MCP fixed-arrival through tests/perf/smoke.mjs
# (600 s each, 20 clients / 40 req/s, concurrent owner replay ingestion at the contract's 20 journal entries/s =
# INGEST_OBS observations/s x 3 entries per observation, 60 s hot-set warm-up). Host load, docker stats (memory + CPU
# of every container incl. PostgreSQL) and the engine's VmRSS are sampled every 15 s by scripts/verify/perf-sampler.sh.
# Usage: scripts/verify/perf-smoke-run.sh   (env: INST, P, PORT, POOLS, EV, DURATION, WARMUP, INGEST_OBS, RUNS)
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c
INST="${INST:-$HOME/blackbox-pilot-perf}"; P="${P:-blackbox-agent-c-perf}"; PORT="${PORT:-19180}"
POOLS="${POOLS:-$HOME/blackbox-perf-keys-perf/pools.json}"; EV="${EV:-$REPO/reports/evidence/PILOT-09-perf}"
OWNER="$INST/owner.key"; API=http://127.0.0.1:$PORT
DURATION="${DURATION:-600}"; WARMUP="${WARMUP:-60}"; INGEST_OBS="${INGEST_OBS:-7}"
mkdir -p "$EV"; cd "$REPO"
load() { uptime | sed 's/.*load averages: //'; }
api_ready() { local t0=$(date +%s); while :; do if curl -s -m 5 -o /dev/null -w '%{http_code}' $API/api/health | grep -q 200; then echo "api responsive after $(( $(date +%s) - t0 )) s"; return 0; fi; [ $(( $(date +%s) - t0 )) -ge 900 ] && { echo "api not responsive within 900 s"; return 1; }; sleep 5; done; }
engine_json() { docker exec $P-api node -e "const fs=require('fs');const tok=fs.readFileSync('/run/secrets/engine_token','utf8').trim();fetch('http://engine:7070/health',{headers:{'x-engine-token':tok}}).then(r=>r.json()).then(j=>{const t=Object.values(j.tenants);console.log(JSON.stringify({status:j.status,rss_mib:+(j.rss_bytes/1048576).toFixed(1),approx_mib:+(j.memory.approx_resident_bytes/1048576).toFixed(1),rss_over_target:j.memory.rss_over_target??null,tenants:t.length,ready:t.filter(x=>x.phase==='ready').length,lag_entries:t.reduce((s,x)=>s+(x.lag_entries||0),0),write_copies_resident:t.filter(x=>x.write_copy_resident).length,evictions:t.reduce((s,x)=>s+(x.evictions||0),0),rss_evictions:t.reduce((s,x)=>s+(x.rss_evictions||0),0),cold_hits:j.memory.cold_cache_hits,cold_misses:j.memory.cold_cache_misses,admission:j.admission}))})" 2>/dev/null; }
{
echo "# perf smoke protocol started $(date -u +%FT%TZ) load $(load) commit $(git rev-parse HEAD)"
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep "$P-" | sed 's/^/  /'
echo "foreign containers (not $P-*): $(docker ps --format '{{.Names}}' | grep -vc "^$P-")"
for spec in ${RUNS:-"closed api" "fixed api" "closed mcp" "fixed mcp"}; do
  set -- $spec; MODE=$1; TR=$2
  echo "## pre-run API readiness: $(api_ready)"
  echo "## engine before $TR-$MODE: $(engine_json)"
  echo "## run $TR-$MODE started $(date -u +%FT%TZ) load $(load)"
  bash "$REPO/scripts/verify/perf-sampler.sh" "$P" "$EV/samples-$TR-$MODE.jsonl" 15 & SAMPLER=$!
  node tests/perf/smoke.mjs --pools "$POOLS" --mode "$MODE" --transport "$TR" --duration "$DURATION" --clients 20 --rate 40 --ingest-obs-per-second "$INGEST_OBS" --warmup "$WARMUP" --project "$P" --owner-key-file "$OWNER" --out "$EV/run-$TR-$MODE.json" > "$EV/run-$TR-$MODE.log" 2>&1
  rc=$?; kill $SAMPLER 2>/dev/null; wait $SAMPLER 2>/dev/null
  echo "exit=$rc finished $(date -u +%FT%TZ) load $(load)"; tail -1 "$EV/run-$TR-$MODE.log" | cut -c1-400
  echo "## engine after $TR-$MODE: $(engine_json)"
  python3 - "$EV/samples-$TR-$MODE.jsonl" <<'PY'
import json,sys,re
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
def mib(s):
    m=re.match(r'([\d.]+)\s*([KMG]i?B)',s); v=float(m.group(1)); u=m.group(2)
    return v*1024 if u.startswith('G') else v/1024 if u.startswith('K') else v
def cpu(s): return float(s.rstrip('%') or 0)
pg=[cpu(c['cpu']) for r in rows for c in r['containers'] if c['name'].endswith('-postgres')]
api=[cpu(c['cpu']) for r in rows for c in r['containers'] if c['name'].endswith('-api')]
eng=[cpu(c['cpu']) for r in rows for c in r['containers'] if c['name'].endswith('-engine')]
rss=[r['engine_vmrss_bytes']/1048576 for r in rows if r.get('engine_vmrss_bytes')]
loads=[float(r['load'].split()[0]) for r in rows]
med=lambda a: sorted(a)[len(a)//2] if a else None
print(f"sampler: {len(rows)} samples; host 1-min load min/median/max {min(loads):.1f}/{med(loads):.1f}/{max(loads):.1f}; postgres CPU median/max {med(pg):.0f}%/{max(pg):.0f}%; api CPU median/max {med(api):.0f}%/{max(api):.0f}%; engine CPU median/max {med(eng):.0f}%/{max(eng):.0f}%; engine VmRSS median/max {med(rss):.0f}/{max(rss):.0f} MiB")
PY
done
echo "# runs finished $(date -u +%FT%TZ) load $(load)"
} > "$EV/smoke-protocol.txt" 2>&1
grep -cE 'bb[ka]_[A-Za-z0-9_-]{20,}' "$EV/smoke-protocol.txt" | sed 's/^/secret-pattern lines: /'; cut -c1-300 "$EV/smoke-protocol.txt"
