#!/usr/bin/env bash
# PILOT-06 (storage thresholds / critical pause / no false ack) and PILOT-05 (runtime stop-restart resume, revoked MCP key)
# on the second install. Thresholds are the documented injection point (PATCH /api/settings/storage); a critical state is
# forced by a critical_min_bytes above the free space, then restored. Evidence: $EV/part3.txt (keys redacted).
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; INST=$HOME/blackbox-pilot-ops2; EV=$REPO/reports/evidence/OPS-RERUN; API=http://127.0.0.1:19185; OWNER=$INST/owner.key; cd "$INST"
oapi() { python3 "$REPO/scripts/verify/owner-api.py" "$API" "$OWNER" "$@"; }
j() { tail -1; }
{
echo "# ops2 part 3  started $(date -u +%FT%TZ)  load $(uptime | sed 's/.*load averages: //')"
echo "## PILOT-06: storage state before"; oapi GET /api/diagnostics/storage | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print({'thresholds':d['thresholds'],'volumes':{k:{'free_gib':round((v.get('free_bytes') or 0)/2**30,1),'state':v.get('state')} for k,v in d['volumes'].items()}})"
SHOP=$(oapi GET /api/sources | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); c=[x for p in d['catalogue'] for x in p['connections'] if p['provider']=='shopify' and x['display_name']=='rotation shop']; print(c[0]['connection_id'])")
echo "shopify connection: $SHOP"
echo "## force critical: PATCH critical_min_bytes = 300 GiB (free space is ~190 GiB)"; oapi PATCH /api/settings/storage '{"critical_min_bytes":322122547200}' | head -1
echo "## waiting up to 90 s for the worker's storage refresh"; for i in $(seq 1 18); do st=$(oapi GET /api/diagnostics/storage | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(max(v.get('state','') for v in d['volumes'].values()))"); [ "$st" = "critical" ] && break; sleep 5; done; echo "storage volume state: $st after $((i*5)) s"
echo "## health cards (storage-related)"; oapi GET /api/diagnostics/health | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); [print(c['area'], c['state'], '-', c.get('reason'), '->', c.get('next_action')) for c in d['cards'] if c['area'] in ('worker','diagnostics','sources','api')]"
echo "## request a check run while critical"; RUN=$(oapi POST "/api/sources/connections/$SHOP/runs" '{"kind":"check"}' | j); echo "$RUN" | head -c 300; echo; RID=$(echo "$RUN" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('run_id',''))" 2>/dev/null)
sleep 25; echo "run after 25 s:"; oapi GET "/api/sources/connections/$SHOP/runs/$RID" | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print({k:d.get(k) for k in ('state','phase','error_code','next_action','attempt')})"
echo "## ingestion while critical must not be acknowledged falsely (POST /api/ingest/replay)"; REPLAY=$(oapi POST /api/sources/connections '{"provider":"replay","display_name":"pilot06 replay","config":{"synthetic":true}}' | j | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['connection']['connection_id'])"); oapi POST /api/ingest/replay "{\"connection_id\":\"$REPLAY\",\"events\":[{\"provider_event_id\":\"p06-1\",\"kind\":\"order.accepted\",\"occurred_at\":\"2026-10-31T09:00:00Z\",\"entity\":{\"order\":\"#P06\"},\"payload\":{\"order\":\"#P06\",\"quantity\":1,\"unit\":\"piece\",\"unit_gross_minor\":100,\"gross_minor\":100,\"currency\":\"EUR\",\"status\":\"accepted\"},\"evidence_refs\":[]}]}" | head -2 | cut -c1-300
echo "## restore thresholds (critical_min_bytes = 1 GiB)"; oapi PATCH /api/settings/storage '{"critical_min_bytes":1073741824}' | head -1
for i in $(seq 1 18); do st=$(oapi GET /api/diagnostics/storage | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(max(v.get('state','') for v in d['volumes'].values()))"); [ "$st" = "ok" ] && break; sleep 5; done; echo "storage volume state: $st after $((i*5)) s"
echo "## resume the paused run (POST runs again) and ingestion after recovery"; oapi POST "/api/sources/connections/$SHOP/runs" '{"kind":"check"}' | j | head -c 200; echo; oapi POST /api/ingest/replay "{\"connection_id\":\"$REPLAY\",\"events\":[{\"provider_event_id\":\"p06-1\",\"kind\":\"order.accepted\",\"occurred_at\":\"2026-10-31T09:00:00Z\",\"entity\":{\"order\":\"#P06\"},\"payload\":{\"order\":\"#P06\",\"quantity\":1,\"unit\":\"piece\",\"unit_gross_minor\":100,\"gross_minor\":100,\"currency\":\"EUR\",\"status\":\"accepted\"},\"evidence_refs\":[]}]}" | head -2 | cut -c1-200
echo "## PILOT-05: revoke the agent key, then the MCP bridge with the revoked key"; AID=$(oapi GET /api/agents | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); a=[x for x in (d['agents'] if isinstance(d,dict) else d) if x['name']=='ops2-reader']; print(a[0]['agent_id'] if a and 'agent_id' in a[0] else (a[0].get('id') or a[0].get('key_id')))"); echo "agent: $AID"; oapi POST "/api/agents/$AID/revoke" '{}' | head -1
(cd "$REPO" && timeout 120 npx --yes @modelcontextprotocol/inspector --cli -e BLACKBOX_API_URL="$API" -e BLACKBOX_AGENT_KEY_FILE="$INST/agent.key" node packages/mcp/dist/server.js --method tools/call --tool-name get_readiness 2>&1 | head -c 400); echo
echo "## PILOT-05: stop the runtime for 90 s, restart, observe the worker's resume (coalesced due jobs, no storm)"; W0=$(docker logs blackbox-agent-c-ops2-worker 2>&1 | wc -l | tr -d ' '); ./blackbox down 2>&1 | tail -1; sleep 90; T0=$(date +%s); ./blackbox up 2>&1 | tail -1; echo "up after $(( $(date +%s) - T0 )) s"; sleep 60
docker logs --since 3m blackbox-agent-c-ops2-worker 2>&1 | python3 -c "
import sys,json,collections
c=collections.Counter(); n=0
for l in sys.stdin:
    try: r=json.loads(l)
    except: continue
    n+=1; c[r.get('event_name')]+=1
print('worker records in the first ~60 s after restart:', n); print(c.most_common(12))"
oapi GET /api/diagnostics/health | j | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); [print(c['area'], c['state'], '-', (c.get('reason') or '')[:80]) for c in d['cards']]"
echo "# finished $(date -u +%FT%TZ)  load $(uptime | sed 's/.*load averages: //')"
} > "$EV/part3.txt" 2>&1
grep -cE 'bbk_[A-Za-z0-9_-]{20,}|bba_[A-Za-z0-9_-]{20,}' "$EV/part3.txt" | sed 's/^/secret-pattern lines: /'; grep -E '^##|state|error|next_action|agent:|records in|up after' "$EV/part3.txt" | cut -c1-220 | head -40
