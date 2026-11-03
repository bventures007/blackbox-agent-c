#!/usr/bin/env bash
# PILOT-09 / OPS-05 smoke protocol re-run on the second install with the follow-up images (sequential: API closed,
# API fixed, MCP closed, MCP fixed; 600 s each + 60 s warm-up, 20 clients, 40 req/s fixed rate, 20 obs/s ingestion),
# then restart-with-tail + no-snapshot rebuild through scripts/verify/ops2-restart-rebuild.sh semantics, verdict and
# the performance report inputs. Evidence under reports/evidence/PILOT-09-followup/smoke/.
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; INST=$HOME/blackbox-pilot-ops2; EV=$REPO/reports/evidence/PILOT-09-followup/smoke
POOLS=$HOME/blackbox-perf-keys/pools.json; P=blackbox-agent-c-ops2; OWNER=$INST/owner.key
DURATION="${DURATION:-600}"; WARMUP="${WARMUP:-60}"
mkdir -p "$EV"; cd "$REPO"
load() { uptime | sed 's/.*load averages: //'; }
{
echo "# smoke re-run started $(date -u +%FT%TZ) load $(load)"
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep "$P-" | sed 's/^/  /'
api_ready() { local t0=$(date +%s); while :; do if curl -s -m 5 -o /dev/null -w '%{http_code}' $API/api/health | grep -q 200; then echo "api responsive after $(( $(date +%s) - t0 )) s"; return 0; fi; [ $(( $(date +%s) - t0 )) -ge 900 ] && { echo "api not responsive within 900 s"; return 1; }; sleep 5; done; }
API=http://127.0.0.1:19185
for spec in ${RUNS:-"closed api" "fixed api" "closed mcp" "fixed mcp"}; do
  set -- $spec; MODE=$1; TR=$2
  echo "## pre-run API readiness: $(api_ready)"
  echo "## run $TR-$MODE started $(date -u +%FT%TZ) load $(load)"
  node tests/perf/smoke.mjs --pools "$POOLS" --mode "$MODE" --transport "$TR" --duration "$DURATION" --clients 20 --rate 40 --ingest-obs-per-second 20 --warmup "$WARMUP" --project "$P" --owner-key-file "$OWNER" --out "$EV/run-$TR-$MODE.json" > "$EV/run-$TR-$MODE.log" 2>&1
  echo "exit=$? finished $(date -u +%FT%TZ) load $(load)"; tail -3 "$EV/run-$TR-$MODE.log" | cut -c1-300
done
echo "# runs finished $(date -u +%FT%TZ) load $(load)"
} > "$EV/smoke-rerun.txt" 2>&1
grep -cE 'bb[ka]_[A-Za-z0-9_-]{20,}' "$EV/smoke-rerun.txt" | sed 's/^/secret-pattern lines: /'; cat "$EV/smoke-rerun.txt" | cut -c1-200
