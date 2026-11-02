#!/usr/bin/env bash
# PILOT-10: no network egress while all 24 local question templates are answered. Method: (a) inside the api, worker and
# engine containers, the set of established TCP peers outside loopback/RFC1918/link-local from /proc/net/tcp{,6} before,
# during and after the burst; (b) on the host, the Docker VM's outbound connections (com.docker.backend, lsof) to
# non-private peers before/after; (c) /proc/net/dev byte counters of every container interface before/after (the api's
# published-port traffic from this host is loopback-NATed and appears there; it is listed, not claimed as egress).
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; API=${API:-http://127.0.0.1:19180}; OWNER=${OWNER:-$HOME/blackbox-pilot-fresh/owner.key}; P=${P:-blackbox-agent-c}; EV=$REPO/reports/evidence/PILOT-10
oapi() { python3 "$REPO/scripts/verify/owner-api.py" "$API" "$OWNER" "$@"; }
peers() { for c in api worker engine; do docker exec $P-$c sh -c 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null' | awk 'NR>1 && $4=="01"{print $3}' | python3 -c "
import sys,ipaddress
seen=set()
for l in sys.stdin:
    h,port=l.strip().split(':')
    if len(h)==8: ip=ipaddress.ip_address(int.from_bytes(bytes.fromhex(h),'little'))
    else: b=bytes.fromhex(h); ip=ipaddress.ip_address(b''.join(b[i:i+4][::-1] for i in range(0,16,4)))
    if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_unspecified: continue
    seen.add(f'{ip}:{int(port,16)}')
print('$c', 'external established peers:', sorted(seen) or 'none')"; done; }
hostpeers() { lsof -nP -iTCP -sTCP:ESTABLISHED -a -c com.docker.backend 2>/dev/null | awk 'NR>1{print $9}' | python3 -c "
import sys,ipaddress
ext=set()
for l in sys.stdin:
    try: remote=l.strip().split('->')[1]; ip=remote.rsplit(':',1)[0].strip('[]'); a=ipaddress.ip_address(ip)
    except Exception: continue
    if not (a.is_loopback or a.is_private or a.is_link_local): ext.add(remote)
print('host com.docker.backend external established:', len(ext), sorted(ext)[:8])"; }
dev() { for c in api worker engine; do docker exec $P-$c sh -c "cat /proc/net/dev" | awk -v c=$c 'NR>2{gsub(":","",$1); if($1!="lo") printf "%s %s rx=%s tx=%s\n", c, $1, $2, $10}'; done; }
{
echo "# PILOT-10 egress observation  $(date -u +%FT%TZ)  install $P at $API"
echo "## before"; peers; hostpeers; dev > /tmp/bb-dev-before.txt; cat /tmp/bb-dev-before.txt
echo "## burst: every template of GET /api/questions asked once through the owner API (example params from the GOLDEN demo; a template whose parameters cannot be guessed answers a validation/unknown status — still a local answer)"
oapi GET /api/questions | tail -1 > /tmp/bb-questions.json
python3 - "$API" "$OWNER" "$REPO" <<'PY'
import json,subprocess,sys
api,owner,repo=sys.argv[1:4]
qs=json.load(open('/tmp/bb-questions.json'))['questions']
guess={'item_id':'CUP-OLV','requested_quantity':100,'order_id':'#1001','invoice_id':'INV-1001','transaction_id':'TX-1001','payout_id':'PO-1001','customer_id':'C-1','shipment_id':'SHP-1001','supplier_id':'S-1','sku':'CUP-OLV','quantity':100,'from':'2026-10-01T00:00:00Z','to':'2026-11-02T00:00:00Z','as_of':'2026-10-31T10:00:00Z','currency':'EUR','days':30,'bank_entry_id':'BANK-1','return_id':'RET-1001','credit_note_id':'CN-1001','window_days':30}
summary=[]
for q in qs:
    props=(q.get('params_schema') or {}).get('properties',{})
    req=set((q.get('params_schema') or {}).get('required') or []); ent={'item_id','order_id','invoice_id','transaction_id','payout_id','customer_id','shipment_id','supplier_id','return_id','credit_note_id'}
    params={k:guess[k] for k in props if k in guess and (k in req or k in ent)}
    out=subprocess.run(['python3',f'{repo}/scripts/verify/owner-api.py',api,owner,'POST',f"/api/questions/{q['intent']}",json.dumps({'params':params})],capture_output=True,text=True).stdout.strip().split('\n')
    st=out[0] if out else '?'
    try: body=json.loads(out[-1]); status=body.get('status') or body.get('error',{}).get('code')
    except Exception: status='?'
    summary.append((q['id'],q['intent'],st,status))
for s in summary: print('  %-14s %-40s http %s -> %s' % s)
print('asked', len(summary), 'templates; local answers (complete/partial/unknown/conflict/unsupported):', sum(1 for s in summary if s[3] in ('complete','partial','unknown','conflict','unsupported')), '; validation/other:', sum(1 for s in summary if s[3] not in ('complete','partial','unknown','conflict','unsupported')))
PY
echo "## during (right after the burst)"; peers; hostpeers
sleep 5; echo "## after"; peers; hostpeers; dev > /tmp/bb-dev-after.txt; paste -d' ' /tmp/bb-dev-before.txt /tmp/bb-dev-after.txt | awk '{split($3,a,"=");split($4,b,"=");split($7,c,"=");split($8,d,"="); printf "%s %s rx_delta=%d tx_delta=%d\n",$1,$2,c[2]-a[2],d[2]-b[2]}'
echo "## interfaces: $(docker network inspect ${P}_egress --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null) are on the egress network; backend network is internal (no route out). The api interface facing the published port carries this host's own request/response bytes."
echo "# finished $(date -u +%FT%TZ)"
} > "$EV/egress-observation.txt" 2>&1
grep -cE 'bb[ka]_[A-Za-z0-9_-]{20,}' "$EV/egress-observation.txt" | sed 's/^/secret-pattern lines: /'; grep -E '^#|external|asked|delta' "$EV/egress-observation.txt" | cut -c1-200
