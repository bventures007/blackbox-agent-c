#!/usr/bin/env bash
# QUERY-01/02 + PILOT-10 on the second install: sparse synthetic tenant (CLI, no HTTP route) with a read-only agent key,
# tests/questions/coverage.mjs --phase positive (24 intents through API and the stdio MCP bridge, as_of snapshots, missing-data
# paths on the sparse tenant), ./blackbox down && ./blackbox up, --phase restart (as_of re-check per group). External
# established peers of api/worker/engine and of the Docker VM are sampled before/after the whole run (PILOT-10 egress).
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; INST=${INST:-$HOME/blackbox-pilot-ops2}; API=${API:-http://127.0.0.1:19185}; P=${P:-blackbox-agent-c-ops2}; OWNER=$INST/owner.key; KEYS=$HOME/blackbox-perf-keys; OUT=$REPO/reports/evidence/QUERY-01-rerun; cd "$REPO"; mkdir -p "$OUT" "$KEYS"
peers() { for c in api worker engine; do docker exec $P-$c sh -c 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null' | awk 'NR>1 && $4=="01"{print $3}' | python3 -c "
import sys,ipaddress
seen=set()
for l in sys.stdin:
    h,port=l.strip().split(':')
    if len(h)==8: ip=ipaddress.ip_address(int.from_bytes(bytes.fromhex(h),'little'))
    else: b=bytes.fromhex(h); ip=ipaddress.ip_address(b''.join(b[i:i+4][::-1] for i in range(0,16,4)))
    if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_unspecified: continue
    seen.add(f'{ip}:{int(port,16)}')
print('$c', 'external established peers:', sorted(seen) or 'none')"; done
lsof -nP -iTCP -sTCP:ESTABLISHED -a -c com.docker.backend 2>/dev/null | awk 'NR>1{print $9}' | python3 -c "
import sys,ipaddress
ext=set()
for l in sys.stdin:
    try: remote=l.strip().split('->')[1]; ip=remote.rsplit(':',1)[0].strip('[]'); a=ipaddress.ip_address(ip)
    except Exception: continue
    if not (a.is_loopback or a.is_private or a.is_link_local): ext.add(remote)
print('host com.docker.backend external established:', len(ext), sorted(ext)[:8])"; }
{
echo "# question coverage run  $(date -u +%FT%TZ)  install $P at $API  load $(uptime | sed 's/.*load averages: //')"
echo "## egress sample before"; peers
echo "## sparse tenant + read-only agent key (host CLI, test-only; key written 0600 outside the repo, never printed)"
umask 077
docker compose -p $P exec -T api node /app/apps/api/dist/cli.js create-tenant --name coverage-sparse --seed-order '#M' --json 2>/dev/null | tail -1 > "$KEYS/coverage-sparse-tenant.json"
TENANT=$(python3 -c "import json,sys; print(json.load(open('$KEYS/coverage-sparse-tenant.json')).get('tenant_id',''))"); echo "sparse tenant: ${TENANT:0:8}…"
docker compose -p $P exec -T api node /app/apps/api/dist/cli.js create-tenant-agent-key --tenant "$TENANT" --name coverage-sparse --json 2>/dev/null | tail -1 | python3 -c "
import json,sys,os; d=json.loads(sys.stdin.read()); fd=os.open('$KEYS/coverage-sparse.key', os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600); os.write(fd,(d['key']+'\n').encode()); os.close(fd); print('sparse agent key: status', d.get('status'), 'prefix', d['key'][:4], 'len', len(d['key']))"
echo "## phase positive  $(date -u +%FT%TZ)"
node tests/questions/coverage.mjs --phase positive --api "$API" --owner-key-file "$OWNER" --sparse-key-file "$KEYS/coverage-sparse.key" --out "$OUT" 2>&1 | sed -E 's/bb[ka]_[A-Za-z0-9_-]{20,}/<redacted>/g'; echo "positive exit: ${PIPESTATUS[0]}"
echo "## ./blackbox down && ./blackbox up  $(date -u +%FT%TZ)"; ( cd "$INST" && ./blackbox down 2>&1 | tail -1 && ./blackbox up 2>&1 | tail -1 )
for i in $(seq 1 90); do c=$(curl -s -m 5 -o /dev/null -w '%{http_code}' $API/health); [ "$c" = 200 ] && { echo "api /health 200 after ${i} probes"; break; }; sleep 2; done
for i in $(seq 1 300); do s=$(python3 scripts/verify/owner-api.py $API "$OWNER" GET /api/diagnostics/health 2>/dev/null | tail -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print([c['state'] for c in d['cards'] if c['area']=='engine'][0])" 2>/dev/null); [ "$s" = healthy ] && { echo "engine healthy after ${i} probes"; break; }; sleep 2; done
echo "## phase restart  $(date -u +%FT%TZ)"
node tests/questions/coverage.mjs --phase restart --api "$API" --owner-key-file "$OWNER" --sparse-key-file "$KEYS/coverage-sparse.key" --out "$OUT" 2>&1 | sed -E 's/bb[ka]_[A-Za-z0-9_-]{20,}/<redacted>/g'; echo "restart exit: ${PIPESTATUS[0]}"
echo "## egress sample after"; peers
echo "# finished $(date -u +%FT%TZ)  load $(uptime | sed 's/.*load averages: //')"
} > "$OUT/run.txt" 2>&1
echo "secret-pattern lines: $(grep -cE 'bb[ka]_[A-Za-z0-9_-]{20,}' "$OUT"/run.txt "$OUT"/*.json | awk -F: '{s+=$2} END{print s}')"
grep -E '^#|^##|exit|peers|passed|parity|identical|FAILED|healthy|tenant' "$OUT/run.txt" | cut -c1-240
