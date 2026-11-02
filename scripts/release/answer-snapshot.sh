#!/usr/bin/env bash
# INSTALL-02 helper: sign in with the owner key file and record the order-01 answer envelope (status,
# result, consistency cursors, evidence count) so two snapshots taken before and after `./blackbox down`
# + `./blackbox up` can be compared byte-for-byte. The key is read from a file and never printed.
#   answer-snapshot.sh <base-url> <owner-key-file> <out.json>
set -euo pipefail
BASE="${1:?base url}"; KEYFILE="${2:?owner key file}"; OUT="${3:?out file}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
KEY="$(tr -d '\n' < "$KEYFILE")"
curl -fsS -c "$JAR" -H 'content-type: application/json' -H "Origin: $BASE" -d "{\"key\":\"$KEY\",\"remember\":false}" "$BASE/api/auth/login" -o /dev/null
CSRF="$(curl -fsS -b "$JAR" "$BASE/api/auth/session" | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrf_token"])')"
curl -fsS -b "$JAR" -H 'content-type: application/json' -H "X-Blackbox-CSRF: $CSRF" -H "Origin: $BASE" -X POST \
  -d '{"params":{"item_id":"CUP-OLV","requested_quantity":100},"consistency":{"mode":"latest_committed"}}' \
  "$BASE/api/questions/inventory.available_to_sell" | python3 -c '
import sys, json
d = json.load(sys.stdin)
snap = {"intent": d["intent"], "status": d["status"], "result": d["result"], "calculation": d["calculation"], "missing_inputs": d["missing_inputs"], "conflicts": d["conflicts"],
        "applied_cursor": d["consistency"].get("applied_cursor"), "required_cursor": d["consistency"].get("required_cursor"), "reducer_version": d["consistency"].get("reducer_version"),
        "evidence_count": len(d["evidence_refs"]), "evidence_refs_sorted": sorted(d["evidence_refs"]), "datasets_present": d["coverage"]["datasets_present"]}
json.dump(snap, open(sys.argv[1], "w"), indent=2, sort_keys=True)
print("status=%s available=%s applied_cursor=%s evidence=%s" % (snap["status"], (snap["result"] or {}).get("available"), snap["applied_cursor"], snap["evidence_count"]))
' "$OUT"
curl -fsS -b "$JAR" -H "X-Blackbox-CSRF: $CSRF" -H "Origin: $BASE" -X POST "$BASE/api/auth/logout" -o /dev/null || true
