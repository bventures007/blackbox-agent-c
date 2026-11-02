#!/usr/bin/env bash
# PILOT-07 runtime proof on the second install: rotate the installation data key on a populated, running stack with a
# sealed Shopify secret + a signed producer (fenced, verified before retire, api/worker recreated), then PILOT-08:
# owner restriction of one raw evidence object answered as `restricted` on the API (owner + agent) and through the
# stdio MCP bridge (official Inspector CLI). Evidence: $EV/part2a.txt (keys redacted; agent key file 0600 outside the repo).
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; INST=$HOME/blackbox-pilot-ops2; EV=$REPO/reports/evidence/OPS-RERUN; API=http://127.0.0.1:19185; OWNER=$INST/owner.key; cd "$INST"
redact() { sed -E 's/AGE-SECRET-KEY-1[A-Z0-9]+/AGE-SECRET-KEY-1<redacted>/g; s/bbk_[A-Za-z0-9_-]{20,}/bbk_<redacted>/g; s/bba_[A-Za-z0-9_-]{20,}/bba_<redacted>/g'; }
oapi() { python3 "$REPO/scripts/verify/owner-api.py" "$API" "$OWNER" "$@"; }
{
echo "# ops2 part 2a  started $(date -u +%FT%TZ)  load $(uptime | sed 's/.*load averages: //')"
echo "## key layout before"; ls -la secrets | awk '{print $1, $5, $9}' | grep -E 'data.key|anchor.key'; echo "generation: $(cat secrets/data.key.version)"; shasum -a 256 secrets/data.key | awk '{print "data.key sha256 (first 12):", substr($1,1,12)}'
echo "## ./blackbox rotate-data-key"; T0=$(date +%s); ./blackbox rotate-data-key 2>&1 | redact; echo "rotate exit ${PIPESTATUS[0]} after $(( $(date +%s) - T0 )) s"
echo "## key layout after"; ls -la secrets | awk '{print $1, $5, $9}' | grep -E 'data.key|anchor.key'; echo "generation: $(cat secrets/data.key.version)"; shasum -a 256 secrets/data.key | awk '{print "data.key sha256 (first 12):", substr($1,1,12)}'; ls data/state | grep -i rotation || echo "no key-rotation state file (completed)"; [ -f data/state/writers.paused.json ] && echo "FENCE STILL SET" || echo "fence released"
echo "## containers"; docker compose -p blackbox-agent-c-ops2 ps --format '{{.Name}}\t{{.Status}}'
echo "## secrets in the database carry the new generation"; docker compose -p blackbox-agent-c-ops2 exec -T postgres psql -X -U postgres -d blackbox -Atc "SELECT provider, secret_key_version FROM connections WHERE secret_ciphertext IS NOT NULL UNION ALL SELECT 'producer', secret_key_version FROM producer_credentials"
echo "## security audit"; oapi GET /api/settings/security | tail -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print({k:v for k,v in d['counts'].items() if 'key' in k or 'evidence' in k})"
echo "## ./blackbox verify (golden answer after rotation)"; ./blackbox verify 2>&1 | tail -3; echo "verify exit ${PIPESTATUS[0]}"
echo "## api cli rotate-data-key --verify-only (every stored secret opens with the live key)"; docker compose -p blackbox-agent-c-ops2 exec -T postgres psql -X -U postgres -d blackbox -Atc "SELECT tenant_id FROM tenants" | docker compose -p blackbox-agent-c-ops2 exec -T api node /app/apps/api/dist/cli.js rotate-data-key --verify-only 2>&1 | tail -2
echo "## PILOT-08: restrict one raw evidence object"
EID=$(oapi GET '/api/journal?track=source&limit=5' | tail -1 | python3 -c "import json,sys; es=[e for e in json.loads(sys.stdin.read())['entries'] if e['evidence_refs']]; print(es[0]['evidence_refs'][0])")
echo "evidence id: $EID"; echo "before:"; oapi GET "/api/evidence/$EID" | tail -1 | head -c 200; echo
echo "POST restrict:"; oapi POST "/api/evidence/$EID/restrict" '{"reason":"Owner removed the raw provider payload on request (pilot PILOT-08 proof)"}' | head -2
echo "after (owner):"; oapi GET "/api/evidence/$EID" | tail -1 | head -c 400; echo
echo "content endpoint:"; oapi GET "/api/evidence/$EID/content" | head -1
echo "agent key (API-created, saved to $INST/agent.key 0600):"; umask 077; oapi POST /api/agents '{"name":"ops2-reader"}' | tail -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); open('$INST/agent.key','w').write(d['key']+'\n'); print({k:v for k,v in d.items() if k!='key'})"; chmod 0600 "$INST/agent.key"
echo "after (agent, API):"; curl -s -H "Authorization: Bearer $(cat "$INST/agent.key")" "$API/api/evidence/$EID" | head -c 300; echo
echo "after (agent, MCP get_evidence via Inspector CLI):"; (cd "$REPO" && timeout 180 npx --yes @modelcontextprotocol/inspector --cli -e BLACKBOX_API_URL="$API" -e BLACKBOX_AGENT_KEY_FILE="$INST/agent.key" node packages/mcp/dist/server.js --method tools/call --tool-name get_evidence --tool-arg "evidence_id=$EID" 2>&1 | redact | head -c 700); echo
echo "ledger rows:"; docker compose -p blackbox-agent-c-ops2 exec -T postgres psql -X -U postgres -d blackbox -Atc "SELECT action, policy_ref, reason FROM evidence_redactions"
echo "# finished $(date -u +%FT%TZ)"
} > "$EV/part2a.txt" 2>&1
grep -cE 'AGE-SECRET-KEY-1[A-Z0-9]{10,}|bbk_[A-Za-z0-9_-]{20,}|bba_[A-Za-z0-9_-]{20,}' "$EV/part2a.txt" | sed 's/^/secret-pattern lines in evidence: /'
grep -E '^##|exit|generation:|FENCE|fence|restricted|verified' "$EV/part2a.txt" | head -40
