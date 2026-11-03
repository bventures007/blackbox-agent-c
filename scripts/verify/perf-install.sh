#!/usr/bin/env bash
# PILOT-09 perf install: fresh installation of a performance-test archive into an EMPTY folder (extract, doctor, setup
# with the owner key captured to <install>/owner.key 0600 via scripts/release/setup-with-key-capture.py, up, status,
# compose ps, engine environment check), a loopback PostgreSQL proxy container (127.0.0.1:PGPROXY_PORT -> postgres:5432
# on the project's internal backend network; host-only, used by the corpus generator / host CLI / bb_engine checks) and
# the labeled golden demo so ./blackbox verify has a representative answer. Never prints a key.
# Usage: scripts/verify/perf-install.sh <archive.tar.gz>   (env: INST, P, PORT, PGPROXY_PORT, EV)
set -uo pipefail
REPO=/Users/benediktsauter/GitHub/blackbox-agent-c; ARCHIVE="${1:?archive}"
INST="${INST:-$HOME/blackbox-pilot-perf}"; P="${P:-blackbox-agent-c-perf}"; PORT="${PORT:-19180}"; PGPROXY_PORT="${PGPROXY_PORT:-19197}"
EV="${EV:-$REPO/reports/evidence/PILOT-09-perf}"; mkdir -p "$EV" "$INST"
[ -z "$(ls -A "$INST")" ] || { echo "install dir not empty: $INST" >&2; exit 2; }
cd "$INST"
{
echo "# perf install started $(date -u +%FT%TZ) load $(uptime | sed 's/.*load averages: //'); archive $ARCHIVE ($(stat -f %z "$ARCHIVE") bytes, sha256 $(shasum -a 256 "$ARCHIVE" | cut -c1-64)); commit $(git -C $REPO rev-parse HEAD)"
echo "# docker: $(docker info --format 'CPUs={{.NCPU}} MemTotal={{.MemTotal}} ServerVersion={{.ServerVersion}} OS={{.OperatingSystem}} Kernel={{.KernelVersion}}')"; echo "# host: $(sysctl -n machdep.cpu.brand_string), $(sysctl -n hw.ncpu) cores, $(( $(sysctl -n hw.memsize) / 1073741824 )) GiB, $(sw_vers -productName) $(sw_vers -productVersion); foreign containers running: $(docker ps --format '{{.Names}}' | grep -vc "^$P-")"
echo "# tar -xzf --strip-components=1"; tar -xzf "$ARCHIVE" --strip-components=1 && ls | tr '\n' ' '; echo
echo "# release.json"; cat release.json | tr -d '\n' | cut -c1-900; echo
echo "# ./blackbox doctor (before setup)"; ./blackbox doctor 2>&1 | tail -25; echo "# doctor exit: ${PIPESTATUS[0]}"
echo "# ./blackbox setup --port $PORT --project $P (pty; key -> $INST/owner.key 0600; transcript redacted -> $EV/setup-transcript-redacted.txt)"
T0=$(date +%s); python3 "$REPO/scripts/release/setup-with-key-capture.py" "$INST" "$INST/owner.key" "$EV/setup-transcript-redacted.txt" --port "$PORT" --project "$P" | grep -v 'bbk_' | tail -3; echo "# setup exit: ${PIPESTATUS[0]} after $(( $(date +%s) - T0 )) s"
[ -s owner.key ] && echo "# owner.key: $(stat -f '%Sp %z bytes' owner.key)" || echo "# owner.key: NOT captured"
echo "# ./blackbox up"; T0=$(date +%s); ./blackbox up 2>&1 | tail -3; echo "# up exit: ${PIPESTATUS[0]} after $(( $(date +%s) - T0 )) s"
echo "# ./blackbox status"; ./blackbox status 2>&1 | tail -12; echo "# status exit: ${PIPESTATUS[0]}"
echo "# docker compose -p $P ps"; docker compose -p "$P" ps --format '{{.Name}}\t{{.Image}}\t{{.Status}}'
echo "# image digests"; for s in api worker engine backup; do echo "  $s: $(docker inspect --format '{{.Id}} {{index .RepoTags 0}}' "$(docker inspect --format '{{.Config.Image}}' $P-$s 2>/dev/null || docker inspect --format '{{.Config.Image}}' $P-backup-scheduler)" 2>/dev/null | head -1)"; done
echo "# engine environment (contract: ENGINE_RSS_TARGET_MB=1024, MALLOC_ARENA_MAX=2, RUST_LOG=info) and limits"; docker inspect $P-engine --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(ENGINE_|MALLOC_ARENA_MAX|RUST_LOG|LOG_LEVEL)' | sort | sed 's/^/  /'; docker inspect $P-engine --format '  mem_limit={{.HostConfig.Memory}} read_only={{.HostConfig.ReadonlyRootfs}} user={{.Config.User}}'
docker inspect $P-api --format '  api mem_limit={{.HostConfig.Memory}}'; docker inspect $P-postgres --format '  postgres cmd={{.Config.Cmd}}'
echo "# ./blackbox doctor (after up)"; ./blackbox doctor 2>&1 | tail -25; echo "# doctor exit: ${PIPESTATUS[0]}"
echo "# api health: $(curl -s -m 5 http://127.0.0.1:$PORT/api/health)"
echo "# loopback PostgreSQL proxy $P-pgproxy: 127.0.0.1:$PGPROXY_PORT -> postgres:5432 (network ${P}_backend)"
docker rm -f $P-pgproxy >/dev/null 2>&1
docker run -d --name $P-pgproxy --restart unless-stopped -p 127.0.0.1:$PGPROXY_PORT:5432 node:22-bookworm-slim node -e "const net=require('net');net.createServer(s=>{const u=net.connect(5432,'postgres');s.pipe(u);u.pipe(s);s.on('error',()=>u.destroy());u.on('error',()=>s.destroy())}).listen(5432,'0.0.0.0')" >/dev/null && docker network connect "${P}_backend" $P-pgproxy && echo "  started: $(docker ps --format '{{.Names}} {{.Status}} {{.Ports}}' | grep $P-pgproxy)"
sleep 2; echo "  bb_api through the proxy: $(node -e "const pg=require('$REPO/node_modules/pg');const fs=require('fs');const c=new pg.Client({host:'127.0.0.1',port:$PGPROXY_PORT,user:'bb_api',password:fs.readFileSync('$INST/secrets/pg_api_password','utf8').trim(),database:'blackbox'});c.connect().then(()=>c.query('SELECT current_user AS u, (SELECT count(*)::int FROM tenants) AS tenants')).then(r=>console.log(JSON.stringify(r.rows[0]))).then(()=>c.end()).catch(e=>{console.log('ERR',e.message)})" 2>&1)"
echo "# ./blackbox demo --confirm (labeled golden scenario into demo connections)"; ./blackbox demo --confirm 2>&1 | tail -3; echo "# demo exit: ${PIPESTATUS[0]}"
echo "# ./blackbox verify"; ./blackbox verify 2>&1 | tail -4; echo "# verify exit: ${PIPESTATUS[0]}"
echo "# finished $(date -u +%FT%TZ) load $(uptime | sed 's/.*load averages: //')"
} > "$EV/install.txt" 2>&1
grep -cE 'bb[ka]_[A-Za-z0-9_-]{20,}' "$EV/install.txt" "$EV/setup-transcript-redacted.txt" | sed 's/^/secret-pattern lines: /'; grep -E '^# |^  ' "$EV/install.txt" | cut -c1-250
