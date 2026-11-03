#!/usr/bin/env bash
# Resource sampler for the PILOT-09 perf protocol: every <interval> s one JSON line with the host load
# averages, docker stats (memory/CPU) of every container of the Compose project and the engine's VmRSS
# from /proc/1/status. Runs until killed. Usage: perf-sampler.sh <compose project> <out.jsonl> [interval=15]
set -u
P="${1:?project}"; OUT="${2:?out}"; IV="${3:-15}"
while :; do
  ts=$(date -u +%FT%TZ)
  load=$(uptime | sed 's/.*load averages: //' | tr -s ' ' | sed 's/^ //')
  rss=$(docker exec "$P-engine" sh -c 'grep VmRSS /proc/1/status' 2>/dev/null | awk '{printf "%d", $2*1024}')
  stats=$(docker stats --no-stream --format '{{json .}}' 2>/dev/null | grep "\"Name\":\"$P-" | python3 -c '
import sys,json
rows=[]
for l in sys.stdin:
    r=json.loads(l); rows.append({"name":r["Name"],"mem":r["MemUsage"].split("/")[0].strip(),"cpu":r["CPUPerc"]})
print(json.dumps(rows))' 2>/dev/null)
  printf '{"at":"%s","load":"%s","engine_vmrss_bytes":%s,"containers":%s}\n' "$ts" "$load" "${rss:-null}" "${stats:-[]}" >> "$OUT"
  sleep "$IV"
done
