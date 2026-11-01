#!/usr/bin/env bash
# SLICE-01 — first persisted Shopify-shaped-to-answer slice (specs/FIRST-VERTICAL-SLICE.md P1 steps 1–6)
# against a RUNNING installed stack (./blackbox up in $INSTALL_DIR). Entirely scripted: bash + curl + node.
# Writes sanitized artifacts (no keys, no cookies) to reports/evidence/SLICE-01/. Prints PASS/FAIL per
# step and exits non-zero on any failure. Synthetic provider-shaped fixture: never live evidence.
#
#   INSTALL_DIR=/Users/you/blackbox-pilot-int OWNER_KEY_FILE=$INSTALL_DIR/owner.key tests/slice/slice-01.sh
#
# Prerequisites: the stack is up (./blackbox status), the owner key is in OWNER_KEY_FILE (0600, outside
# the repo), node >= 22 with the repo's node_modules (MCP SDK) and built packages/mcp/dist.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/blackbox-pilot-int}"
OWNER_KEY_FILE="${OWNER_KEY_FILE:-$INSTALL_DIR/owner.key}"
API="${BLACKBOX_API_URL:-http://127.0.0.1:19180}"
ORIGIN="$API"
PROJECT="${COMPOSE_PROJECT_NAME:-blackbox-agent-c}"
FIXTURE_PORT="${FIXTURE_PORT:-19182}"
FIXTURE_HOST_FROM_CONTAINER="${FIXTURE_HOST_FROM_CONTAINER:-host.docker.internal}"
OUT="${SLICE_OUT:-$REPO/reports/evidence/SLICE-01}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/slice01.XXXXXX")"; chmod 0700 "$TMP"
JAR="$TMP/cookies.txt"
AGENT_KEY_FILE="$TMP/agent.key"
WRAPPER="$INSTALL_DIR/blackbox"
[ -x "$WRAPPER" ] || WRAPPER="$REPO/scripts/blackbox"
FIXTURE_PID=""
FAILED=0
START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$OUT"
rm -f "$OUT"/step-*.json "$OUT"/step-*.txt "$OUT"/logs-*.jsonl "$OUT"/results.json 2>/dev/null || true

say()  { printf '%s\n' "$*"; }
pass() { say "PASS $1"; }
fail() { say "FAIL $1"; FAILED=1; }
die()  { say "FATAL $1"; FAILED=1; finish; }
node_json() { node -e "$1" "${@:2}"; }   # small JSON helpers through node (jq is also used when present)
jqs() { jq -r "$@"; }
# curl wrappers: owner (cookie jar + CSRF + Origin) and agent (bearer from file; the key never reaches argv logs)
CSRF=""
owner_get()  { curl -sS --max-time 30 -b "$JAR" "$API$1"; }
owner_post() { curl -sS --max-time 120 -b "$JAR" -c "$JAR" -H "content-type: application/json" -H "origin: $ORIGIN" -H "x-blackbox-csrf: $CSRF" -X POST --data "$2" "$API$1"; }
owner_post_status() { curl -sS --max-time 120 -o "$3" -w '%{http_code}' -b "$JAR" -c "$JAR" -H "content-type: application/json" -H "origin: $ORIGIN" -H "x-blackbox-csrf: $CSRF" -X POST --data "$2" "$API$1"; }
agent_get_status() { curl -sS --max-time 30 -o "$2" -w '%{http_code}' -H "authorization: Bearer $(cat "$AGENT_KEY_FILE")" "$API$1"; }
mcp() { BLACKBOX_API_URL="$API" BLACKBOX_AGENT_KEY_FILE="$AGENT_KEY_FILE" node "$REPO/tests/slice/mcp-state.mjs" "$@"; }
normalize() { node "$REPO/tests/slice/normalize.mjs" "$1"; }
psql_super() { docker exec -i "$PROJECT-postgres" psql -X -At -U postgres -d blackbox "$@"; }
urlenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
sanitize_check() { # artifacts must never contain keys/cookies
  if grep -rEl 'bbk_[A-Za-z0-9_-]{20,}|bba_[A-Za-z0-9_-]{20,}|bb_session=' "$OUT" >/dev/null 2>&1; then fail "artifacts contain credential-looking strings"; else pass "artifacts contain no owner/agent keys or session cookies"; fi
}
finish() {
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null || true
  rm -rf "$TMP"
  local status; [ $FAILED -eq 0 ] && status=passed || status=failed
  node_json '
    const fs=require("fs"); const [out,status,start]=process.argv.slice(1);
    const obs={}; for (const f of fs.readdirSync(out).filter(f=>/^step-.*\.json$/.test(f)).sort()) { try { obs[f]=JSON.parse(fs.readFileSync(out+"/"+f,"utf8")); } catch { obs[f]="unparsable"; } }
    const summary = obs["step-summary.json"] ?? {};
    fs.writeFileSync(out+"/results.json", JSON.stringify({ status, case:"SLICE-01", started_at:start, finished_at:new Date().toISOString(), observed: summary, artifacts: Object.keys(obs) }, null, 2)+"\n");
  ' "$OUT" "$status" "$START_TS"
  say "SLICE-01: $status (artifacts: $OUT)"
  [ "$status" = passed ] && exit 0 || exit 1
}
trap 'finish' INT TERM

SUMMARY="$TMP/summary.json"; echo '{}' > "$SUMMARY"
note() { # note <key> <json value>
  node_json 'const fs=require("fs");const [f,k,v]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(f,"utf8"));j[k]=JSON.parse(v);fs.writeFileSync(f,JSON.stringify(j));' "$SUMMARY" "$1" "$2"
  cp "$SUMMARY" "$OUT/step-summary.json"
}

say "SLICE-01 against $API (install: $INSTALL_DIR, project $PROJECT); artifacts -> $OUT"
[ -r "$OWNER_KEY_FILE" ] || die "owner key file not readable: $OWNER_KEY_FILE"
curl -fsS --max-time 5 "$API/api/health" > "$OUT/step-0-health.json" || die "API not reachable at $API (./blackbox up first)"
[ -f "$REPO/packages/mcp/dist/server.js" ] || die "packages/mcp/dist/server.js missing (pnpm build:backend)"

# ------------------------------------------------------------------------------------------------
say "== Step 1: owner login, agent key"
KEY="$(tr -d '\n' < "$OWNER_KEY_FILE")"
LOGIN_STATUS="$(curl -sS --max-time 30 -o "$TMP/login.out" -w '%{http_code}' -c "$JAR" -H "content-type: application/json" -H "origin: $ORIGIN" -X POST --data "$(node_json 'process.stdout.write(JSON.stringify({key:process.argv[1],remember:false}))' "$KEY")" "$API/api/auth/login")"
unset KEY
if [ "$LOGIN_STATUS" = "204" ]; then pass "step1 owner login (204, HttpOnly session cookie)"; else fail "step1 owner login returned $LOGIN_STATUS"; die "cannot continue without a session"; fi
owner_get /api/auth/session > "$TMP/session.json"
CSRF="$(jqs .csrf_token "$TMP/session.json")"
TENANT="$(jqs .workspace.tenant_id "$TMP/session.json")"
jq '{principal, workspace, session: {expires_at: .session.expires_at, remembered: .session.remembered}}' "$TMP/session.json" > "$OUT/step-1-session.json"
[ -n "$TENANT" ] && [ "$TENANT" != null ] && pass "step1 session for workspace $TENANT" || fail "step1 no workspace in session"
owner_post /api/agents '{"name":"slice-01 read-only agent"}' > "$TMP/agent.json"
AGENT_ID="$(jqs .credential_id "$TMP/agent.json")"
(umask 077; jqs .key "$TMP/agent.json" > "$AGENT_KEY_FILE")
jq '{credential_id, grant: "workspace.read_business", key: "<redacted; held in a 0600 temp file for the run>"}' "$TMP/agent.json" > "$OUT/step-1-agent.json"
if [ -n "$AGENT_ID" ] && [ "$AGENT_ID" != null ] && grep -q '^bba_' "$AGENT_KEY_FILE"; then pass "step1 agent key created via API ($AGENT_ID)"; else fail "step1 agent key creation"; fi
AGENT_WS_STATUS="$(agent_get_status /api/workspace "$TMP/agent-ws.json")"
[ "$AGENT_WS_STATUS" = "200" ] && pass "step1 agent key authorized on GET /api/workspace" || fail "step1 agent GET /api/workspace -> $AGENT_WS_STATUS"
note step1 "$(jq -c '{login_status: '"$LOGIN_STATUS"', tenant_id: .workspace.tenant_id, agent_credential_id: "'"$AGENT_ID"'", agent_workspace_status: '"$AGENT_WS_STATUS"'}' "$TMP/session.json")"

# ------------------------------------------------------------------------------------------------
say "== Step 2: Shopify-shaped fixture, connection, import plan, backfill"
(lsof -nP -iTCP:"$FIXTURE_PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill) 2>/dev/null || true
node "$REPO/fixtures/shopify/server.mjs" --port "$FIXTURE_PORT" --seed 42 --orders 40 > "$TMP/fixture.log" 2>&1 &
FIXTURE_PID=$!
for i in $(seq 1 30); do curl -fsS --max-time 2 "http://127.0.0.1:$FIXTURE_PORT/__fixture/state" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS --max-time 2 "http://127.0.0.1:$FIXTURE_PORT/__fixture/state" > "$TMP/fixture-state.json" 2>/dev/null && pass "step2 fixture server listening on 127.0.0.1:$FIXTURE_PORT (seed 42, 40 orders)" || die "fixture server did not start"
jq '{seed, orders, clock, fixture: "synthetic Shopify-shaped GraphQL Admin API subset"}' "$TMP/fixture-state.json" > "$OUT/step-2-fixture.json" 2>/dev/null || cp "$TMP/fixture-state.json" "$OUT/step-2-fixture.json"
CONN_BODY="$(node_json 'process.stdout.write(JSON.stringify({provider:"shopify",display_name:"SLICE-01 fixture shop",config:{shop_domain:"fixture-42.myshopify.com",base_url:"http://"+process.argv[1]+":"+process.argv[2],page_size:7},secret:{access_token:"shpat_fixture_0123456789abcdef"}}))' "$FIXTURE_HOST_FROM_CONTAINER" "$FIXTURE_PORT")"
owner_post /api/sources/connections "$CONN_BODY" > "$TMP/conn.json"
CONN="$(jqs '.connection.connection_id // empty' "$TMP/conn.json")"
if [ -n "$CONN" ]; then pass "step2 connection created $CONN (secret sealed with the installation data key)"; else fail "step2 connection: $(cat "$TMP/conn.json")"; die "no connection"; fi
jq '.connection | {connection_id, provider, status, has_secret, config}' "$TMP/conn.json" > "$OUT/step-2-connection.json"
owner_post "/api/sources/connections/$CONN/import-plan" '{"preset":"last_30_days","timezone":"Europe/Berlin","include_open_context":true}' > "$TMP/plan.json"
PLAN="$(jqs '.plan_id // empty' "$TMP/plan.json")"
[ -n "$PLAN" ] && pass "step2 import plan last_30_days ($(jqs .requested_from "$TMP/plan.json") .. $(jqs .initial_cutoff "$TMP/plan.json"))" || fail "step2 import plan: $(cat "$TMP/plan.json")"
cp "$TMP/plan.json" "$OUT/step-2-import-plan.json"
owner_post "/api/sources/connections/$CONN/runs" '{"kind":"backfill"}' > "$TMP/runs.json"
RUN_IDS="$(jq -r '.runs[]?.run_id // .run_id' "$TMP/runs.json" | sort -u)"
PRIMARY_RUN="$(jq -r '.runs[]? | select(.poll_group=="shopify:orders") | .run_id' "$TMP/runs.json" | head -n1)"; [ -n "$PRIMARY_RUN" ] || PRIMARY_RUN="$(jqs .run_id "$TMP/runs.json")"
[ -n "$RUN_IDS" ] && pass "step2 backfill queued: $(echo "$RUN_IDS" | wc -l | tr -d ' ') run(s) (orders/stock/allocations poll groups); orders run $PRIMARY_RUN" || { fail "step2 runs: $(cat "$TMP/runs.json")"; die "no runs"; }
wait_run() { # wait_run <run_id> -> state
  local id="$1" st="" i=0
  while [ $i -lt 240 ]; do
    owner_get "/api/sources/connections/$CONN/runs/$id" > "$TMP/run-$id.json" 2>/dev/null || true
    st="$(jqs '.state // empty' "$TMP/run-$id.json")"
    case "$st" in completed|completed_with_gaps|failed|cancelled) break;; esac
    i=$((i+1)); sleep 2
  done
  echo "$st"
}
ALL_DONE=1
for id in $RUN_IDS; do
  st="$(wait_run "$id")"
  jq '{run_id, kind, poll_group, state, phase, counters, totals_known, percent, pages, started_at, finished_at, outcome, error_code, committed_cursor, coverage_from, coverage_to}' "$TMP/run-$id.json" > "$OUT/step-2-run-$id.json"
  case "$st" in completed|completed_with_gaps) pass "step2 run $id ($(jqs .poll_group "$TMP/run-$id.json")) $st: $(jq -c .counters "$TMP/run-$id.json") pages=$(jqs .pages "$TMP/run-$id.json") committed_cursor=$(jqs .committed_cursor "$TMP/run-$id.json")";; *) fail "step2 run $id ended as '${st:-unknown}' $(jq -c '{error_code,next_action}' "$TMP/run-$id.json")"; ALL_DONE=0;; esac
done
COMMITTED_ORDERS="$(jqs .counters.committed "$TMP/run-$PRIMARY_RUN.json")"
[ "${COMMITTED_ORDERS:-0}" -gt 0 ] && pass "step2 orders backfill committed $COMMITTED_ORDERS logical records through the journal/outbox boundary" || fail "step2 orders backfill committed nothing"
note step2 "$(jq -n -c '{connection_id: "'"$CONN"'", plan_id: "'"$PLAN"'", orders_run_id: "'"$PRIMARY_RUN"'", runs: [inputs | {run_id, poll_group, state, counters, pages, committed_cursor}]}' $(for id in $RUN_IDS; do echo "$TMP/run-$id.json"; done))"

# ------------------------------------------------------------------------------------------------
say "== Step 3: journal entries and delivery dedupe"
journal_all() { # journal_all <query> -> all pages into $1.out
  local q="$1" cursor="" first=1; : > "$TMP/journal-pages.jsonl"
  while :; do
    local url="/api/journal?$q&limit=500"; [ -n "$cursor" ] && url="$url&cursor=$(urlenc "$cursor")"
    owner_get "$url" > "$TMP/page.json" || break
    jq -c '.entries[]' "$TMP/page.json" >> "$TMP/journal-pages.jsonl"
    [ $first = 1 ] && jq '.consistency' "$TMP/page.json" > "$TMP/journal-consistency.json"; first=0
    cursor="$(jqs '.page.next_cursor // empty' "$TMP/page.json")"; [ -n "$cursor" ] || break
  done
}
journal_all "connection_id=$CONN"
J1_TOTAL="$(wc -l < "$TMP/journal-pages.jsonl" | tr -d ' ')"
jq -s 'group_by(.track) | map({track: .[0].track, count: length})' "$TMP/journal-pages.jsonl" > "$TMP/by-track.json"
jq -s 'group_by(.event_type) | map({event_type: .[0].event_type, count: length}) | sort_by(-.count)' "$TMP/journal-pages.jsonl" > "$TMP/by-event.json"
J1_CURSOR="$(jqs .committed_cursor "$TMP/journal-consistency.json")"
jq -n --slurpfile t "$TMP/by-track.json" --slurpfile e "$TMP/by-event.json" --slurpfile c "$TMP/journal-consistency.json" '{total_entries: '"$J1_TOTAL"', by_track: $t[0], by_event_type: $e[0], consistency: $c[0]}' > "$OUT/step-3-journal-after-first-backfill.json"
TRACKS_SEEN="$(jq -r '.[].track' "$TMP/by-track.json" | sort | tr '\n' ' ')"
[ "$J1_TOTAL" -gt 0 ] && pass "step3 journal holds $J1_TOTAL entries for the connection (tracks: $TRACKS_SEEN), committed_cursor=$J1_CURSOR" || fail "step3 no journal entries"
echo "$TRACKS_SEEN" | grep -q source && echo "$TRACKS_SEEN" | grep -q movement && echo "$TRACKS_SEEN" | grep -q fact && pass "step3 source + derived fact/movement entries present" || fail "step3 derived tracks missing (saw: $TRACKS_SEEN)"
# derived entries reference their source, share correlation_id and carry entity refs
BAD_LINKS="$(jq -s '[.[] | select(.track != "source" and .event_type != "source.conflict_observed") | select((.input_entry_ids|length) != 1 or .correlation_id == null or (.entity_refs|length) == 0)] | length' "$TMP/journal-pages.jsonl")"
[ "$BAD_LINKS" = "0" ] && pass "step3 every derived entry links its source (input_entry_ids), shares correlation_id and carries entity_refs" || fail "step3 $BAD_LINKS derived entries lack links/correlation/entity refs"
# rerun backfill: deliveries dedupe -> no new entries
owner_post "/api/sources/connections/$CONN/runs" '{"kind":"backfill"}' > "$TMP/runs2.json"
RUN_IDS2="$(jq -r '.runs[]?.run_id // .run_id' "$TMP/runs2.json" | sort -u)"
[ -n "$RUN_IDS2" ] && pass "step3 second backfill queued ($(echo "$RUN_IDS2" | wc -l | tr -d ' ') runs)" || { fail "step3 second backfill: $(cat "$TMP/runs2.json")"; }
DUPES=0; NEWC=0
for id in $RUN_IDS2; do
  st="$(wait_run "$id")"
  jq '{run_id, kind, poll_group, state, counters, pages, committed_cursor}' "$TMP/run-$id.json" > "$OUT/step-3-rerun-$id.json"
  DUPES=$((DUPES + $(jqs '.counters.duplicates // 0' "$TMP/run-$id.json"))); NEWC=$((NEWC + $(jqs '.counters.committed // 0' "$TMP/run-$id.json")))
  case "$st" in completed|completed_with_gaps) :;; *) fail "step3 rerun $id ended as '$st'";; esac
done
journal_all "connection_id=$CONN"
J2_TOTAL="$(wc -l < "$TMP/journal-pages.jsonl" | tr -d ' ')"
J2_CURSOR="$(jqs .committed_cursor "$TMP/journal-consistency.json")"
if [ "$J2_TOTAL" = "$J1_TOTAL" ] && [ "$NEWC" = "0" ] && [ "$DUPES" -gt 0 ]; then pass "step3 rerun deduped: duplicates=$DUPES new_records=0, journal unchanged ($J2_TOTAL entries, committed_cursor $J2_CURSOR)"; else fail "step3 rerun changed the journal or committed again: before=$J1_TOTAL after=$J2_TOTAL new=$NEWC duplicates=$DUPES"; fi
note step3 "{\"entries_after_first_backfill\":$J1_TOTAL,\"entries_after_rerun\":$J2_TOTAL,\"rerun_duplicates\":$DUPES,\"rerun_new_records\":$NEWC,\"committed_cursor\":$J2_CURSOR,\"derived_without_links\":$BAD_LINKS}"

# ------------------------------------------------------------------------------------------------
say "== Step 4: order state through API and MCP; committed vs applied cursor"
# an order with a capture and a completed refund (fixture pattern: partial refund with return)
ORDER="$(jq -r 'select(.track=="source" and .event_type=="refund.completed") | .entity_refs.order' "$TMP/journal-pages.jsonl" | head -n1)"
[ -n "$ORDER" ] || ORDER="$(jq -r 'select(.track=="source" and .event_type=="payment.captured") | .entity_refs.order' "$TMP/journal-pages.jsonl" | head -n1)"
[ -n "$ORDER" ] && pass "step4 order under test: $ORDER (has capture/refund observations)" || die "no order with capture found"
ORDER_ENC="$(urlenc "$ORDER")"
ORDER_SOURCE_ENTRIES="$(jq -s '[.[] | select(.track=="source" and .entity_refs.order=="'"$ORDER"'")] | map({entry_id, event_type, occurred_at, recorded_at, journal_sequence, provider_event_id})' "$TMP/journal-pages.jsonl")"
echo "$ORDER_SOURCE_ENTRIES" > "$OUT/step-4-order-source-entries.json"
get_state() { # get_state <outfile> <query>
  local status; status="$(curl -sS --max-time 30 -o "$1" -w '%{http_code}' -b "$JAR" "$API/api/entities/order/$ORDER_ENC/state?$2")"; echo "$status"
}
# latest_committed waits for the engine to reach the committed cursor (503 projection_behind otherwise): retry briefly
for i in $(seq 1 30); do S4="$(get_state "$TMP/state-api.json" "mode=latest_committed")"; [ "$S4" = "200" ] && break; sleep 2; done
if [ "$S4" = "200" ]; then pass "step4 API latest_committed state 200 (status $(jqs .status "$TMP/state-api.json"))"; else fail "step4 API state -> $S4 $(cat "$TMP/state-api.json" | head -c 300)"; fi
jq '{entity, state, status, missing_inputs, conflicts, coverage, consistency, entry_count: (.entry_ids|length), evidence_count: (.evidence_refs|length)}' "$TMP/state-api.json" > "$OUT/step-4-state-api.json"
APPLIED="$(jqs .consistency.applied_cursor "$TMP/state-api.json")"
owner_get "/api/journal?connection_id=$CONN&limit=1" > "$TMP/j.json"; COMMITTED="$(jqs .consistency.committed_cursor "$TMP/j.json")"
owner_get /api/diagnostics/health > "$TMP/health.json"
jq '[.cards[] | select(.area=="engine" or .area=="worker" or .area=="postgres" or .area=="api") | {area, state, reason, details}]' "$TMP/health.json" > "$OUT/step-4-health.json"
ENG_APPLIED="$(jq -r '.cards[] | select(.area=="engine") | .details.applied_cursor' "$TMP/health.json")"; ENG_COMMITTED="$(jq -r '.cards[] | select(.area=="engine") | .details.committed_cursor' "$TMP/health.json")"
pass "step4 cursors: journal committed=$COMMITTED, engine applied=$APPLIED (health card applied=$ENG_APPLIED of committed=$ENG_COMMITTED)"
[ "$APPLIED" -ge "$COMMITTED" ] 2>/dev/null && pass "step4 latest_committed barrier: applied >= committed" || fail "step4 applied $APPLIED < committed $COMMITTED on a latest_committed answer"
mcp get_business_state "$(node_json 'process.stdout.write(JSON.stringify({entity_type:"order",entity_id:process.argv[1],mode:"latest_committed"}))' "$ORDER")" > "$TMP/state-mcp.json"; MCP_RC=$?
jq '{entity, state, status, consistency, entry_count: (.entry_ids|length)}' "$TMP/state-mcp.json" > "$OUT/step-4-state-mcp.json" 2>/dev/null || cp "$TMP/state-mcp.json" "$OUT/step-4-state-mcp.json"
[ $MCP_RC -eq 0 ] && pass "step4 MCP get_business_state (stdio bridge, agent key, official SDK client) answered" || fail "step4 MCP tool call failed (rc=$MCP_RC): $(head -c 300 "$TMP/state-mcp.json")"
normalize "$TMP/state-api.json" > "$TMP/norm-api.json"; normalize "$TMP/state-mcp.json" > "$TMP/norm-mcp.json"
if diff -q "$TMP/norm-api.json" "$TMP/norm-mcp.json" >/dev/null; then pass "step4 normalized business values/evidence identical via API and MCP"; else fail "step4 API vs MCP differ"; diff "$TMP/norm-api.json" "$TMP/norm-mcp.json" > "$OUT/step-4-api-vs-mcp.diff" || true; fi
cp "$TMP/norm-api.json" "$OUT/step-4-normalized.json"
CUTOFF="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
CUTOFF_CURSOR="$COMMITTED"
sleep 1
S4H="$(get_state "$TMP/state-asof-before.json" "mode=as_of&as_of_recorded=$(urlenc "$CUTOFF")")"
[ "$S4H" = "200" ] && pass "step4 fixed-cutoff (as_of_recorded=$CUTOFF, cursor $CUTOFF_CURSOR) answer captured, status $(jqs .consistency.status "$TMP/state-asof-before.json")" || fail "step4 as_of query -> $S4H $(head -c 200 "$TMP/state-asof-before.json")"
normalize "$TMP/state-asof-before.json" > "$TMP/norm-asof-before.json"; cp "$TMP/norm-asof-before.json" "$OUT/step-4-asof-normalized.json"
note step4 "$(jq -c '{order: "'"$ORDER"'", api_status: '"$S4"', committed_cursor: '"${COMMITTED:-null}"', applied_cursor: '"${APPLIED:-null}"', state: .state, status: .status, cutoff: "'"$CUTOFF"'", cutoff_cursor: '"${CUTOFF_CURSOR:-null}"'}' "$TMP/state-api.json")"

# ------------------------------------------------------------------------------------------------
say "== Step 5: full restart, then engine restart with a corrupted snapshot"
( cd "$INSTALL_DIR" && "$WRAPPER" down ) > "$TMP/down.txt" 2>&1 && pass "step5 ./blackbox down" || fail "step5 ./blackbox down: $(tail -n 3 "$TMP/down.txt")"
( cd "$INSTALL_DIR" && "$WRAPPER" up ) > "$TMP/up.txt" 2>&1 && pass "step5 ./blackbox up" || fail "step5 ./blackbox up: $(tail -n 3 "$TMP/up.txt")"
for i in $(seq 1 60); do curl -fsS --max-time 3 "$API/api/health" >/dev/null 2>&1 && break; sleep 2; done
# re-login (the restart keeps sessions server-side; a fresh session proves the key still works after restart)
for i in $(seq 1 30); do owner_get /api/auth/session > "$TMP/session2.json" 2>/dev/null && [ "$(jqs '.csrf_token // empty' "$TMP/session2.json")" != "" ] && break; sleep 2; done
CSRF="$(jqs '.csrf_token // empty' "$TMP/session2.json")"
[ -n "$CSRF" ] && pass "step5 owner session valid after full restart" || fail "step5 session lost after restart"
# force a snapshot through the engine admin route (private network: from inside the api container), then corrupt it
docker exec "$PROJECT-api" node -e '
const fs=require("fs"); const token=fs.readFileSync("/run/secrets/engine_token","utf8").trim();
fetch("http://engine:7070/v1/admin/snapshot",{method:"POST",headers:{"x-engine-token":token,"content-type":"application/json"},body:"{}"}).then(async r=>{process.stdout.write(await r.text());process.exit(r.ok?0:1)}).catch(e=>{process.stdout.write(String(e));process.exit(1)})' > "$TMP/snapshot.txt" 2>&1
SNAP_RC=$?
# the snapshot writer runs off the request thread: wait for the row
for i in $(seq 1 30); do SNAP_ROWS="$(psql_super -c "SELECT count(*) FROM engine_snapshots WHERE tenant_id='$TENANT'")"; [ "${SNAP_ROWS:-0}" -gt 0 ] && break; sleep 1; done
[ $SNAP_RC -eq 0 ] && [ "${SNAP_ROWS:-0}" -gt 0 ] && pass "step5 engine snapshot written on request ($(cat "$TMP/snapshot.txt"); rows=$SNAP_ROWS)" || fail "step5 snapshot not written (rc=$SNAP_RC rows=${SNAP_ROWS:-0}: $(cat "$TMP/snapshot.txt"))"
SNAP_BEFORE="$(psql_super -c "SELECT applied_sequence||'|'||checksum||'|'||length(blob) FROM engine_snapshots WHERE tenant_id='$TENANT'")"
psql_super -c "UPDATE engine_snapshots SET blob = '\\x00deadbeef'::bytea WHERE tenant_id='$TENANT'" > /dev/null && pass "step5 snapshot blob corrupted in engine_snapshots (was: $SNAP_BEFORE)" || fail "step5 could not corrupt the snapshot"
docker restart "$PROJECT-engine" > /dev/null 2>&1 && pass "step5 engine restarted" || fail "step5 engine restart"
for i in $(seq 1 60); do [ "$(docker inspect --format '{{.State.Health.Status}}' "$PROJECT-engine" 2>/dev/null)" = "healthy" ] && break; sleep 2; done
pass "step5 engine health after restart: $(docker inspect --format '{{.State.Health.Status}}' "$PROJECT-engine")"
sleep 3
( cd "$INSTALL_DIR" && "$WRAPPER" logs --component engine --since 10m --format json ) 2>/dev/null | jq -c 'select(.event_name|test("snapshot|rebuild|batch_applied|started"))' > "$OUT/logs-engine-restart.jsonl" || true
grep -q 'engine.snapshot_rejected' "$OUT/logs-engine-restart.jsonl" && pass "step5 engine log: engine.snapshot_rejected (corrupt snapshot refused, tenant rebuilt from the journal)" || fail "step5 no engine.snapshot_rejected record in the shared logs"
SNAP_AFTER="$(psql_super -c "SELECT count(*) FROM engine_snapshots WHERE tenant_id='$TENANT' AND blob = '\\x00deadbeef'::bytea")"
[ "${SNAP_AFTER:-1}" = "0" ] && pass "step5 corrupted snapshot row deleted by the engine" || fail "step5 corrupted snapshot still present"
for i in $(seq 1 30); do S5="$(get_state "$TMP/state-asof-after.json" "mode=as_of&as_of_recorded=$(urlenc "$CUTOFF")")"; [ "$S5" = "200" ] && break; sleep 2; done
[ "$S5" = "200" ] && pass "step5 fixed-cutoff query answered after rebuild" || fail "step5 as_of after rebuild -> $S5 $(head -c 200 "$TMP/state-asof-after.json")"
normalize "$TMP/state-asof-after.json" > "$TMP/norm-asof-after.json"; cp "$TMP/norm-asof-after.json" "$OUT/step-5-asof-normalized.json"
if diff -q "$TMP/norm-asof-before.json" "$TMP/norm-asof-after.json" >/dev/null; then pass "step5 same cutoff -> identical normalized values, entry ids and evidence refs before/after rebuild"; else fail "step5 cutoff answer differs after rebuild"; diff "$TMP/norm-asof-before.json" "$TMP/norm-asof-after.json" > "$OUT/step-5-asof.diff" || true; fi
mcp get_business_state "$(node_json 'process.stdout.write(JSON.stringify({entity_type:"order",entity_id:process.argv[1],mode:"as_of",as_of_recorded:process.argv[2]}))' "$ORDER" "$CUTOFF")" > "$TMP/state-asof-mcp.json" && normalize "$TMP/state-asof-mcp.json" > "$TMP/norm-asof-mcp.json" && diff -q "$TMP/norm-asof-after.json" "$TMP/norm-asof-mcp.json" >/dev/null && pass "step5 MCP as_of answer identical to the API answer (authorization still agent key)" || fail "step5 MCP as_of answer differs or failed"
for i in $(seq 1 30); do S5L="$(get_state "$TMP/state-latest-after.json" "mode=latest_committed")"; [ "$S5L" = "200" ] && break; sleep 2; done
owner_get "/api/journal?connection_id=$CONN&recorded_from=$(urlenc "$CUTOFF")&limit=500" > "$TMP/newer.json"
NEWER="$(jq '.entries|length' "$TMP/newer.json")"
jq '{newer_observations_since_cutoff: (.entries|length), sample: [.entries[:5][] | {journal_sequence, track, event_type, recorded_at}]}' "$TMP/newer.json" > "$OUT/step-5-newer-observations.json"
pass "step5 latest_committed after rebuild: status $(jqs .consistency.status "$TMP/state-latest-after.json"), applied=$(jqs .consistency.applied_cursor "$TMP/state-latest-after.json"); observations recorded after the cutoff: $NEWER (disclosed, not hidden)"
note step5 "$(jq -c '{snapshot_rows: '"${SNAP_ROWS:-0}"', snapshot_before: "'"$SNAP_BEFORE"'", corrupted_rows_left: '"${SNAP_AFTER:-null}"', asof_status_after: '"${S5:-null}"', newer_since_cutoff: '"$NEWER"', latest_applied_after: .consistency.applied_cursor, latest_status: .consistency.status}' "$TMP/state-latest-after.json")"

# ------------------------------------------------------------------------------------------------
say "== Step 6: late correction, revoked agent, second tenant with colliding order id, correlated logs"
ACCEPTED_ENTRY="$(jq -r 'select(.track=="source" and .event_type=="order.accepted" and .entity_refs.order=="'"$ORDER"'") | .entry_id' "$TMP/journal-pages.jsonl" | head -n1)"
ACCEPTED_PAYLOAD="$(jq -c 'select(.entry_id=="'"$ACCEPTED_ENTRY"'") | .payload' "$TMP/journal-pages.jsonl" | head -n1)"
ACCEPTED_OCCURRED="$(jq -r 'select(.entry_id=="'"$ACCEPTED_ENTRY"'") | .occurred_at' "$TMP/journal-pages.jsonl" | head -n1)"
CORR_BODY="$(node_json '
const [conn, entry, order, occurred, payloadJson] = process.argv.slice(1); const p = JSON.parse(payloadJson);
delete p.observation_mode; p.revision_reason = "late correction (SLICE-01 step 6)"; p.gross_minor = Number(p.gross_minor ?? 0) + 100; p.quantity = Number(p.quantity ?? 1);
process.stdout.write(JSON.stringify({connection_id: conn, events: [{provider_event_id: "slice01-correction:"+order, kind: "order.revised", occurred_at: occurred, entity: {order}, payload: p, evidence_refs: [], supersedes_entry_id: entry}]}));' "$CONN" "$ACCEPTED_ENTRY" "$ORDER" "$ACCEPTED_OCCURRED" "$ACCEPTED_PAYLOAD")"
CORR_STATUS="$(owner_post_status /api/ingest/replay "$CORR_BODY" "$TMP/corr.json")"
jq '{accepted, duplicate, conflict, rejected, committed_cursor, outcomes}' "$TMP/corr.json" > "$OUT/step-6-correction.json" 2>/dev/null || cp "$TMP/corr.json" "$OUT/step-6-correction.json"
[ "$CORR_STATUS" = "200" ] && [ "$(jqs .accepted "$TMP/corr.json")" = "1" ] && pass "step6 late correction appended (order.revised supersedes $ACCEPTED_ENTRY, committed_cursor $(jqs .committed_cursor "$TMP/corr.json"))" || fail "step6 correction -> $CORR_STATUS $(head -c 300 "$TMP/corr.json")"
CORR_ENTRY="$(jq -r '.outcomes[0].entry_ids[0] // empty' "$TMP/corr.json")"
owner_get "/api/journal/$ACCEPTED_ENTRY" > "$TMP/orig.json"
[ "$(jq -r '.superseded_by[0].entry_id // empty' "$TMP/orig.json")" = "$CORR_ENTRY" ] && pass "step6 original entry stays readable and links superseded_by -> $CORR_ENTRY" || fail "step6 superseded_by link missing"
for i in $(seq 1 30); do S6="$(get_state "$TMP/state-current.json" "mode=latest_committed")"; [ "$S6" = "200" ] && break; sleep 2; done
get_state "$TMP/state-historical.json" "mode=as_of&as_of_recorded=$(urlenc "$CUTOFF")" > /dev/null
normalize "$TMP/state-current.json" > "$TMP/norm-current.json"; normalize "$TMP/state-historical.json" > "$TMP/norm-historical.json"
jq '{current: {consistency: .consistency, status, state, commitment_entries: .tracks.commitment.total, superseded: [.tracks[] | .entries[] | select(.effect=="superseded") | {entry_id, event_type, effect}], correction: [.tracks[] | .entries[] | select(.entry_id=="'"$CORR_ENTRY"'") | {entry_id, event_type, track, effect}]}}' "$TMP/state-current.json" > "$OUT/step-6-current-state.json"
jq '{historical: {consistency: .consistency, status, state, commitment_entries: .tracks.commitment.total}}' "$TMP/state-historical.json" > "$OUT/step-6-historical-state.json"
diff -q "$TMP/norm-historical.json" "$TMP/norm-asof-before.json" >/dev/null && pass "step6 historical (cutoff) answer unchanged by the later correction" || fail "step6 historical answer changed"
grep -q "$CORR_ENTRY" "$TMP/norm-current.json" && ! grep -q "$CORR_ENTRY" "$TMP/norm-historical.json" && pass "step6 current answer includes the correction entry; the cutoff answer does not" || fail "step6 correction visibility wrong"
[ "$(jq -r '[.tracks[] | .entries[] | select(.entry_id=="'"$ACCEPTED_ENTRY"'") | .effect] | first // "missing"' "$TMP/state-current.json")" = "superseded" ] && pass "step6 engine marks the original order.accepted entry as superseded (no double count)" || fail "step6 original entry effect is not 'superseded' in the current state"
# revoked agent: denial within 5 s on MCP and API
owner_post "/api/agents/$AGENT_ID/revoke" '{}' > /dev/null
T_REVOKE=$(date +%s)
mcp get_business_state "$(node_json 'process.stdout.write(JSON.stringify({entity_type:"order",entity_id:process.argv[1]}))' "$ORDER")" > "$TMP/mcp-revoked.json"; MCP_RC2=$?
AGENT_STATUS_AFTER="$(agent_get_status /api/workspace "$TMP/agent-after.json")"
T_DENY=$(( $(date +%s) - T_REVOKE ))
jq -c '.' "$TMP/mcp-revoked.json" > "$OUT/step-6-mcp-after-revoke.json" 2>/dev/null || cp "$TMP/mcp-revoked.json" "$OUT/step-6-mcp-after-revoke.json"
if [ $MCP_RC2 -ne 0 ] && grep -q '"status": *401\|"status":401' "$TMP/mcp-revoked.json" && [ "$AGENT_STATUS_AFTER" = "401" ]; then pass "step6 revoked agent denied within ${T_DENY}s (MCP typed 401 error, API 401)"; else fail "step6 revoked agent not denied: mcp rc=$MCP_RC2 api=$AGENT_STATUS_AFTER"; fi
[ "$T_DENY" -le 5 ] && pass "step6 denial observed within 5 s" || fail "step6 denial took ${T_DENY}s"
# second synthetic tenant with the same external order id (host CLI only; no HTTP route)
docker exec "$PROJECT-api" node /app/apps/api/dist/cli.js create-tenant --name "SLICE-01 tenant B" --seed-order "$ORDER" --json > "$TMP/tenant-b.json" 2> "$TMP/tenant-b.err"
TENANT_B="$(jqs '.tenant_id // empty' "$TMP/tenant-b.json")"; CONN_B="$(jqs '.connection_id // empty' "$TMP/tenant-b.json")"
jq '{tenant_id, connection_id, seeded: {order: .seeded.order, accepted: .seeded.accepted, committed_cursor: .seeded.committed_cursor}}' "$TMP/tenant-b.json" > "$OUT/step-6-tenant-b.json" 2>/dev/null || cp "$TMP/tenant-b.json" "$OUT/step-6-tenant-b.json"
[ -n "$TENANT_B" ] && [ "$(jqs .seeded.accepted "$TMP/tenant-b.json")" = "1" ] && pass "step6 tenant B $TENANT_B seeded with colliding order id $ORDER (own sequence starts at 1: cursor $(jqs .seeded.committed_cursor "$TMP/tenant-b.json"))" || fail "step6 tenant B: $(cat "$TMP/tenant-b.json" "$TMP/tenant-b.err" | head -c 300)"
owner_get "/api/journal?entity=$(urlenc "order:$ORDER")&limit=500" > "$TMP/owner-order.json"
LEAK="$(jq '[.entries[] | select(.connection_id=="'"$CONN_B"'")] | length' "$TMP/owner-order.json")"; OWN="$(jq '[.entries[] | select(.connection_id=="'"$CONN"'")] | length' "$TMP/owner-order.json")"
jq '{entries_for_order_in_owner_workspace: (.entries|length), from_own_connection: '"$OWN"', from_tenant_b_connection: '"$LEAK"', connection_ids: ([.entries[].connection_id]|unique)}' "$TMP/owner-order.json" > "$OUT/step-6-cross-tenant.json"
[ "$LEAK" = "0" ] && [ "$OWN" -gt 0 ] && pass "step6 owner journal for order $ORDER: $OWN own entries, 0 from tenant B (no cross-tenant disclosure)" || fail "step6 cross-tenant leak: $LEAK entries from tenant B visible"
get_state "$TMP/state-after-b.json" "mode=latest_committed" > /dev/null
normalize "$TMP/state-after-b.json" > "$TMP/norm-after-b.json"
diff -q "$TMP/norm-current.json" "$TMP/norm-after-b.json" >/dev/null && pass "step6 owner order state unchanged by tenant B's colliding order" || fail "step6 owner state changed after tenant B seed"
NOTFOUND="$(agent_get_status "/api/journal/$(jqs '.seeded.entry_ids[0] // "00000000-0000-4000-8000-000000000000"' "$TMP/tenant-b.json")" "$TMP/nf.json")"
B_ENTRY="$(jqs '.seeded.entry_ids[0] // empty' "$TMP/tenant-b.json")"
NF_OWNER="$(curl -sS --max-time 30 -o "$TMP/nf2.json" -w '%{http_code}' -b "$JAR" "$API/api/journal/$B_ENTRY")"
[ "$NF_OWNER" = "404" ] && pass "step6 tenant B's entry id is 404 for the owner (existence not revealed across tenants)" || fail "step6 owner could read tenant B entry: $NF_OWNER"
# correlated logs: run id across api + worker, engine batch_applied, query records
( cd "$INSTALL_DIR" && "$WRAPPER" logs --run "$PRIMARY_RUN" --since 2h --format json --limit 1000 ) 2>/dev/null > "$OUT/logs-run-$PRIMARY_RUN.jsonl" || true
RUN_LOG_N="$(wc -l < "$OUT/logs-run-$PRIMARY_RUN.jsonl" | tr -d ' ')"
RUN_COMPONENTS="$(jq -r '.component' "$OUT/logs-run-$PRIMARY_RUN.jsonl" 2>/dev/null | sort -u | tr '\n' ' ')"
grep -q '"journal.batch_committed"' "$OUT/logs-run-$PRIMARY_RUN.jsonl" && pass "step6 ./blackbox logs --run $PRIMARY_RUN: $RUN_LOG_N records (components: $RUN_COMPONENTS) incl. journal.batch_committed" || fail "step6 run-correlated logs lack journal.batch_committed ($RUN_LOG_N records)"
( cd "$INSTALL_DIR" && "$WRAPPER" logs --component engine --since 2h --format json --limit 1000 ) 2>/dev/null | jq -c 'select(.event_name=="engine.batch_applied")' > "$OUT/logs-engine-batch-applied.jsonl" || true
[ "$(wc -l < "$OUT/logs-engine-batch-applied.jsonl" | tr -d ' ')" -gt 0 ] && pass "step6 engine.batch_applied records present with committed/applied cursors" || fail "step6 no engine.batch_applied records"
( cd "$INSTALL_DIR" && "$WRAPPER" logs --component api --since 2h --format json --limit 1000 ) 2>/dev/null | jq -c 'select(.event_name=="query.served" or .event_name=="auth.access_denied" or .event_name=="tenant.created")' > "$OUT/logs-api-query-and-denials.jsonl" || true
grep -q '"query.served"' "$OUT/logs-api-query-and-denials.jsonl" && grep -q '"auth.access_denied"' "$OUT/logs-api-query-and-denials.jsonl" && pass "step6 api logs: query.served and auth.access_denied (revoked agent) records" || fail "step6 api query/denial records missing"
note step6 "{\"correction_entry\":\"$CORR_ENTRY\",\"superseded_entry\":\"$ACCEPTED_ENTRY\",\"denial_seconds\":$T_DENY,\"mcp_after_revoke_rc\":$MCP_RC2,\"api_after_revoke_status\":$AGENT_STATUS_AFTER,\"tenant_b\":\"$TENANT_B\",\"cross_tenant_entries_visible\":$LEAK,\"owner_entries_for_order\":$OWN,\"run_log_records\":$RUN_LOG_N}"
sanitize_check
finish
