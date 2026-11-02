#!/usr/bin/env bash
# PILOT-06 forced critical floor (above the ~46 TiB the containers report for bind mounts on Docker Desktop) and PILOT-05 revoked MCP key.
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; INST=$HOME/blackbox-pilot-ops2; EV=$REPO/reports/evidence/OPS-RERUN; API=http://127.0.0.1:19185; OWNER=$INST/owner.key; cd "$INST"
oapi() { python3 "$REPO/scripts/verify/owner-api.py" "$API" "$OWNER" "$@"; }
j() { tail -1; }
vol() { oapi GET /api/diagnostics/storage | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(' '.join(f\"{k}={v.get('state')}\" for k,v in d['volumes'].items()))"; }
{
echo "# ops2 part 3b  started $(date -u +%FT%TZ)  load $(uptime | sed 's/.*load averages: //')"
echo "## container-side figures vs host (Docker Desktop bind mounts): $(oapi GET /api/diagnostics/storage | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); v=d['volumes']['evidence']; print(f\"evidence total {v['total_bytes']/2**40:.0f} TiB free {v['free_bytes']/2**40:.0f} TiB\")") | host: $(df -g / | tail -1 | awk '{print "total "$2" GiB free "$4" GiB"}')"
SHOP=$(oapi GET /api/sources | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); c=[x for p in d['catalogue'] for x in p['connections'] if p['provider']=='shopify' and x['display_name']=='rotation shop']; print(c[0]['connection_id'])")
REPLAY=$(oapi GET /api/sources | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); c=[x for p in d['catalogue'] for x in p['connections'] if x['display_name']=='pilot06 replay']; print(c[0]['connection_id'])")
echo "## force critical: critical_min_bytes = 100 TB (above the reported free space)"; oapi PATCH /api/settings/storage '{"critical_min_bytes":100000000000000}' | head -1
for i in $(seq 1 24); do s="$(vol)"; echo "$s" | grep -q critical && break; sleep 5; done; echo "volumes: $s (after $((i*5)) s)"
echo "## health cards"; oapi GET /api/diagnostics/health | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); [print(' ', c['area'], c['state'], '-', (c.get('reason') or '')[:90], '->', (c.get('next_action') or '')[:60]) for c in d['cards']]"
echo "## existing check run on the shopify connection:"; oapi GET "/api/sources/connections/$SHOP" | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); [print(' ', r['kind'], r['state'], r['phase'], r.get('error_code'), r.get('next_action'), 'attempt', r.get('attempt')) for r in d['runs'][:3]]"
echo "## request a new backfill run while critical"; oapi POST "/api/sources/connections/$SHOP/runs" '{"kind":"backfill"}' | j | head -c 240; echo
sleep 30; echo "runs after 30 s:"; oapi GET "/api/sources/connections/$SHOP" | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); [print(' ', r['kind'], r['state'], r['phase'], r.get('error_code'), r.get('next_action'), 'attempt', r.get('attempt')) for r in d['runs'][:3]]"
echo "## ingestion while critical (POST /api/ingest/replay):"; oapi POST /api/ingest/replay "{\"connection_id\":\"$REPLAY\",\"events\":[{\"provider_event_id\":\"p06-2\",\"kind\":\"order.accepted\",\"occurred_at\":\"2026-10-31T09:00:00Z\",\"entity\":{\"order\":\"#P06B\"},\"payload\":{\"order\":\"#P06B\",\"quantity\":1,\"unit\":\"piece\",\"unit_gross_minor\":100,\"gross_minor\":100,\"currency\":\"EUR\",\"status\":\"accepted\"},\"evidence_refs\":[]}]}" 2>&1 | head -2 | cut -c1-240
echo "## cursors retained? connection health before/after (last_successful_check, cursor):"; oapi GET "/api/sources/connections/$SHOP" | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); [print(' ', h.get('capability_id'), h.get('state'), 'cursor', (h.get('cursor') or h.get('checkpoint') or '')[:30] if isinstance(h.get('cursor') or h.get('checkpoint'),str) else h.get('cursor')) for h in d['health'][:4]]"
echo "## restore thresholds"; oapi PATCH /api/settings/storage '{"critical_min_bytes":1073741824}' | head -1
for i in $(seq 1 24); do s="$(vol)"; echo "$s" | grep -q critical || break; sleep 5; done; echo "volumes: $s (after $((i*5)) s)"
sleep 30; echo "runs after recovery:"; oapi GET "/api/sources/connections/$SHOP" | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); [print(' ', r['kind'], r['state'], r['phase'], r.get('error_code'), r.get('next_action'), 'attempt', r.get('attempt')) for r in d['runs'][:3]]"
echo "## PILOT-05: revoke agent key ops2-reader and call the MCP bridge with the revoked key"; CID=$(oapi GET /api/agents | j | python3 -c "import json,sys; print([a for a in json.loads(sys.stdin.read()) if a['name']=='ops2-reader'][0]['credential_id'])"); oapi POST "/api/agents/$CID/revoke" '{}' | head -1
(cd "$REPO" && timeout 120 npx --yes @modelcontextprotocol/inspector --cli -e BLACKBOX_API_URL="$API" -e BLACKBOX_AGENT_KEY_FILE="$INST/agent.key" node packages/mcp/dist/server.js --method tools/call --tool-name get_readiness 2>&1 | sed -E 's/bba_[A-Za-z0-9_-]{20,}/bba_<redacted>/g' | head -c 500); echo
echo "## PILOT-05: scheduler log after the 90 s stop/restart (coalesced resume, no storm):"; docker logs --since 20m blackbox-agent-c-ops2-worker 2>&1 | python3 -c "
import sys,json,collections
c=collections.Counter()
for l in sys.stdin:
    try: r=json.loads(l)
    except: continue
    c[r.get('event_name')]+=1
print(' ', c.most_common(15))"
echo "# finished $(date -u +%FT%TZ)"
} > "$EV/part3b.txt" 2>&1
grep -cE 'bbk_[A-Za-z0-9_-]{20,}|bba_[A-Za-z0-9_-]{20,}' "$EV/part3b.txt" | sed 's/^/secret-pattern lines: /'; cat "$EV/part3b.txt" | cut -c1-230
