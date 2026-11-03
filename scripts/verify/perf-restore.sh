#!/usr/bin/env bash
# PILOT-09 backup -> isolated restore -> authorized-query-ready on the dedicated perf install (contract:
# backup_restore_query_ready_seconds_maximum 600, machine time; operator wait reported separately).
#   backup-config <dir outside data/> (recovery identity captured to KEYS/recovery.key 0600, never printed),
#   ./blackbox backup (fenced generation), ./blackbox restore <gen> --into RDIR --port RPORT --project RP with
#   BLACKBOX_RECOVERY_KEY_FILE (new owner key captured to KEYS/restore-owner.key by pty-capture), then a probe
#   polling every second until an authorized owner query of the restored install answers 200/current and until the
#   restored engine reports every tenant ready. Machine time = wrapper-reported machine processing + probe delta;
#   wall time from the restore command start is reported next to it.
# Usage: scripts/verify/perf-restore.sh   (env: INST, P, PORT, KEYS, DEST, RDIR, RPORT, RP, EV)
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c
INST="${INST:-$HOME/blackbox-pilot-perf}"; P="${P:-blackbox-agent-c-perf}"; PORT="${PORT:-19180}"
KEYS="${KEYS:-$HOME/blackbox-perf-keys-perf}"; DEST="${DEST:-$HOME/blackbox-pilot-perf-backups}"
RDIR="${RDIR:-$HOME/blackbox-pilot-perf-restore}"; RPORT="${RPORT:-19198}"; RP="${RP:-blackbox-agent-c-perf-restore}"
EV="${EV:-$REPO/reports/evidence/PILOT-09-perf}"; OWNER="$INST/owner.key"; API=http://127.0.0.1:$PORT; RAPI=http://127.0.0.1:$RPORT
cd "$INST"; mkdir -p "$EV" "$KEYS"; chmod 0700 "$KEYS"
redact() { sed -E 's/AGE-SECRET-KEY-1[A-Z0-9]+/AGE-SECRET-KEY-1<redacted>/g; s/bbk_[A-Za-z0-9_-]{20,}/bbk_<redacted>/g; s/bba_[A-Za-z0-9_-]{20,}/bba_<redacted>/g'; }
load() { uptime | sed 's/.*load averages: //'; }
oapi() { python3 "$REPO/scripts/verify/owner-api.py" "$1" "$2" "${@:3}"; }
{
echo "# perf backup/restore started $(date -u +%FT%TZ) load $(load); commit $(git -C $REPO rev-parse HEAD)"
echo "## sizes before the backup: evidence $(du -sk data/evidence | cut -f1) KiB, snapshots $(du -sk data/snapshots | cut -f1) KiB, pgdata volume $(docker system df -v 2>/dev/null | grep "${P}_pgdata" | awk '{print $3}')"
docker compose -p $P exec -T postgres psql -X -U postgres -d blackbox -Atc "SELECT pg_size_pretty(pg_database_size('blackbox')), (SELECT count(*) FROM journal_entries), (SELECT count(*) FROM tenants)" | sed 's/^/database size | journal_entries | tenants: /'
if [ ! -f "$DEST/.blackbox-backup-destination" ]; then
  echo "## ./blackbox backup-config $DEST --label perf  (recovery identity -> $KEYS/recovery.key 0600, redacted here)"
  umask 077; mkdir -p "$DEST"; ./blackbox backup-config "$DEST" --label perf > "$KEYS/.backup-config.out" 2>&1; echo "exit $?"
  grep -o 'AGE-SECRET-KEY-1[A-Z0-9]*' "$KEYS/.backup-config.out" | head -n1 > "$KEYS/recovery.key"; chmod 0600 "$KEYS/recovery.key"; redact < "$KEYS/.backup-config.out"; rm -f "$KEYS/.backup-config.out"
  echo "recovery.key: $(stat -f '%Sp %z bytes' "$KEYS/recovery.key")"
fi
echo "## ./blackbox backup"; T0=$(date +%s); ./blackbox backup 2>&1 | redact | tail -12; echo "backup exit ${PIPESTATUS[0]} after $(( $(date +%s) - T0 )) s"
GEN="$(ls -t "$DEST"/*.tar.age | head -n1)"; echo "generation: $(basename "$GEN") ($(stat -f %z "$GEN") bytes); sidecar: $(tr -d '\n' < "${GEN%.tar.age}.meta.json" | cut -c1-240)"
echo "## ./blackbox restore $(basename "$GEN") --into $RDIR --port $RPORT --project $RP  (BLACKBOX_RECOVERY_KEY_FILE=$KEYS/recovery.key; new owner key -> $KEYS/restore-owner.key)"
rm -rf "$RDIR"; docker compose -p $RP down -v >/dev/null 2>&1
T0=$(date +%s); T0MS=$(python3 -c 'import time;print(int(time.time()*1000))')
BLACKBOX_RECOVERY_KEY_FILE="$KEYS/recovery.key" python3 "$REPO/scripts/verify/pty-capture.py" "$INST" "$KEYS/restore-owner.key" "$EV/restore-transcript-redacted.txt" -- ./blackbox restore "$GEN" --into "$RDIR" --port "$RPORT" --project "$RP"
RC=$?; T1=$(date +%s); echo "restore exit $RC after $(( T1 - T0 )) s wall (command start to exit)"
grep -iE 'machine|operator|elapsed|processing|verif|representative|restored|fence|\[' "$EV/restore-transcript-redacted.txt" | tail -25
echo "## probe: authorized owner query on the restored install (polled every 1 s from the restore command start)"
PROBE=$(python3 - "$RAPI" "$KEYS/restore-owner.key" "$T0MS" "$RP" <<'PY'
import json,sys,time,urllib.request,urllib.error,http.cookiejar,subprocess
api,keyfile,t0ms,rp=sys.argv[1:5]; t0=int(t0ms)/1000
key=open(keyfile).read().strip()
def session():
    jar=http.cookiejar.CookieJar(); op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    def req(m,p,data=None,h=None):
        hh={"content-type":"application/json","origin":api}; hh.update(h or {})
        r=urllib.request.Request(api+p,data=(json.dumps(data).encode() if data is not None else None),method=m,headers=hh)
        try:
            with op.open(r,timeout=10) as resp: return resp.status,resp.read().decode()
        except urllib.error.HTTPError as e: return e.code,e.read().decode()
    st,_=req("POST","/api/auth/login",{"key":key,"remember":False})
    if st!=204: return None
    st,s=req("GET","/api/auth/session"); csrf=json.loads(s)["csrf_token"]
    return lambda m,p,d=None: req(m,p,d,{"x-blackbox-csrf":csrf})
login_at=query_at=engine_at=None; order=None; last=None
while time.time()-t0 < 900:
    try:
        r=session()
        if r:
            if login_at is None: login_at=time.time()
            if order is None:
                st,b=r("GET","/api/journal?track=source&event_type=order.accepted&limit=1")
                if st==200:
                    es=json.loads(b).get("entries") or []
                    if es: order=es[0]["entity_refs"]["order"]
            if order and query_at is None:
                st,b=r("GET",f"/api/entities/order/{urllib.request.quote(order,safe='')}/state")
                j=json.loads(b) if b.startswith("{") else {}
                last=(st,(j.get("consistency") or {}).get("status"),(j.get("error") or {}).get("code"))
                if st==200 and (j.get("consistency") or {}).get("status")=="current": query_at=time.time()
            if query_at and engine_at is None:
                st,b=r("GET","/api/diagnostics/health")
                if st==200:
                    c=[x for x in json.loads(b)["cards"] if x["area"]=="engine"]
                    if c and c[0]["state"]=="healthy": engine_at=time.time()
            if query_at and engine_at: break
    except Exception as e: last=str(e)[:80]
    time.sleep(1)
print(json.dumps({"owner_login_ready_s":round(login_at-t0,1) if login_at else None,"authorized_query_ready_s":round(query_at-t0,1) if query_at else None,"engine_all_tenants_ready_s":round(engine_at-t0,1) if engine_at else None,"probe_order":order,"last_probe":last}))
PY
)
echo "probe: $PROBE"
echo "## restored install: status"; (cd "$RDIR" && ./blackbox status 2>&1 | tail -6)
echo "restored secrets differ from the live install? data.key $( [ "$(shasum -a 256 "$RDIR/secrets/data.key" | cut -c1-16)" = "$(shasum -a 256 secrets/data.key | cut -c1-16)" ] && echo 'identical (restored from the backup member keys.tar.age, same installation key generation)' || echo 'DIFFERENT')"
echo "restored journal_entries/tenants: $(cd "$RDIR" && docker compose -p $RP exec -T postgres psql -X -U postgres -d blackbox -Atc "SELECT (SELECT count(*) FROM journal_entries), (SELECT count(*) FROM tenants)")"
echo "restored fence: $(cat "$RDIR/data/state/writers.paused.json" 2>/dev/null | cut -c1-160); evidence access: $(cat "$RDIR/data/state/evidence-access.json" 2>/dev/null | cut -c1-120)"
MACHINE=$(grep -o 'machine processing: [0-9]*s' "$EV/restore-transcript-redacted.txt" | tail -1 | grep -o '[0-9]*')
OPER=$(grep -o 'operator input: [0-9]*s' "$EV/restore-transcript-redacted.txt" | tail -1 | grep -o '[0-9]*')
python3 - "$MACHINE" "$OPER" "$(( T1 - T0 ))" "$PROBE" "$(basename "$GEN")" "$(stat -f %z "$GEN")" "$(du -sk data/evidence | cut -f1)" "$RC" "$(load)" > "$EV/restore.json" <<'PY'
import json,sys,datetime
m,o,wall,probe,gen,bytes_,evk,rc,load=sys.argv[1:10]; p=json.loads(probe)
m=int(m) if m else None; o=int(o) if o else 0
q=p.get("authorized_query_ready_s"); eng=p.get("engine_all_tenants_ready_s")
machine=None
if q is not None: machine=round(q - o,1)
print(json.dumps({"class":"backup_restore_query_ready","machine_seconds":machine,"machine_seconds_definition":"seconds from the restore command start until an authorized owner query of the restored install answered 200/current, minus the wrapper-reported operator input time","wrapper_machine_processing_seconds":m,"operator_input_seconds":o,"restore_command_wall_seconds":int(wall),"restore_exit_code":int(rc),"authorized_query_ready_seconds_from_command_start":q,"engine_all_tenants_ready_seconds_from_command_start":eng,"owner_login_ready_seconds":p.get("owner_login_ready_s"),"generation":gen,"generation_bytes":int(bytes_),"evidence_dir_kib":int(evk),"host_load_after":load,"measured_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"source":"scripts/verify/perf-restore.sh"},indent=1))
PY
cat "$EV/restore.json"
echo "## stopping the restored stack (folder kept): "; (cd "$RDIR" && ./blackbox down 2>&1 | tail -1)
echo "# finished $(date -u +%FT%TZ) load $(load)"
} > "$EV/restore.txt" 2>&1
grep -cE 'AGE-SECRET-KEY-1[A-Z0-9]{10,}|bb[ka]_[A-Za-z0-9_-]{20,}' "$EV/restore.txt" "$EV/restore-transcript-redacted.txt" | sed 's/^/secret-pattern lines: /'; cut -c1-300 "$EV/restore.txt"
