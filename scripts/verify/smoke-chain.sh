#!/usr/bin/env bash
# PILOT-09 / OPS-05 smoke runs on the second install (ops2): closed-loop and fixed-arrival through API and MCP,
# each 600 s with 20 observations/s concurrent replay ingestion, docker stats of the Compose project sampled by the driver.
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; EV=$REPO/reports/evidence/PILOT-09-rerun; POOLS=$HOME/blackbox-perf-keys/pools.json; OWNER=$HOME/blackbox-pilot-ops2/owner.key; cd "$REPO"
for spec in "api closed" "api fixed" "mcp closed" "mcp fixed"; do
  set -- $spec; t=$1; m=$2
  { echo "# command: node tests/perf/smoke.mjs --pools <keys-dir>/pools.json --mode $m --transport $t --duration 600 --clients 20 --rate 40 --ingest-obs-per-second 20 --warmup 60 --project blackbox-agent-c-ops2 --owner-key-file <ops2>/owner.key --out $EV/run-$t-$m.json"; echo "# started: $(date -u +%FT%TZ) load: $(uptime | sed 's/.*load averages: //')"; node tests/perf/smoke.mjs --pools "$POOLS" --mode "$m" --transport "$t" --duration 600 --clients 20 --rate 40 --ingest-obs-per-second 20 --warmup 60 --project blackbox-agent-c-ops2 --owner-key-file "$OWNER" --out "$EV/run-$t-$m.json" 2>&1 | sed -E 's/bb[ka]_[A-Za-z0-9_-]{20,}/<redacted>/g'; echo "# exit: $? finished $(date -u +%FT%TZ) load: $(uptime | sed 's/.*load averages: //')"; } > "$EV/run-$t-$m.log" 2>&1
  tail -3 "$EV/run-$t-$m.log" | cut -c1-200
done
