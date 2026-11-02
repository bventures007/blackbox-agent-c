#!/usr/bin/env bash
# DIST-02 / INSTALL-01 journey from an independently served landing host into an EMPTY folder:
# read the manifest, fetch the exact advertised artifact, verify size + SHA-256, extract, doctor, setup (owner key
# captured to a 0600 file outside the repo via scripts/release/setup-with-key-capture.py; transcript redacted),
# up, status, compose ps, doctor. Evidence to <evidence-dir>/fresh-install.txt (+ setup transcript). Never prints a key.
#   scripts/verify/fresh-install.sh <landing-url> <empty-install-dir> <evidence-dir> [setup args...]
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
LANDING="${1%/}"; DIR="$2"; EV="$(mkdir -p "$3" && cd "$3" && pwd -P)"; shift 3
mkdir -p "$DIR" "$EV"; [ -z "$(ls -A "$DIR")" ] || { echo "install dir not empty: $DIR" >&2; exit 2; }
cd "$DIR"
{
  echo "# landing: $LANDING   install dir: $DIR (empty)   started: $(date -u +%FT%TZ)   load: $(uptime | sed 's/.*load averages: //')"
  curl -fsS "$LANDING/release-manifest.json" -o release-manifest.json
  NAME="$(python3 -c 'import json;print(json.load(open("release-manifest.json"))["artifact_filename"])')"
  URL="$(python3 -c 'import json,urllib.parse;m=json.load(open("release-manifest.json"));print(urllib.parse.urljoin("'"$LANDING"'/release-manifest.json", m["download_url"]))')"
  SHA="$(python3 -c 'import json;print(json.load(open("release-manifest.json"))["sha256"])')"
  BYTES="$(python3 -c 'import json;print(json.load(open("release-manifest.json"))["byte_size"])')"
  echo "# advertised: $NAME $BYTES bytes sha256 $SHA from $URL"
  curl -fsSL -o "$NAME" -w "# download: http_code=%{http_code} bytes=%{size_download} seconds=%{time_total}\n" "$URL"
  ACT="$(shasum -a 256 "$NAME" | awk '{print $1}')"; ACTB="$(stat -f %z "$NAME")"
  echo "# downloaded: $ACTB bytes sha256 $ACT -> $([ "$ACT" = "$SHA" ] && [ "$ACTB" = "$BYTES" ] && echo MATCH || echo MISMATCH)"
  [ "$ACT" = "$SHA" ] || { echo "# ABORT: checksum mismatch"; exit 2; }
  echo "# tar -xzf $NAME --strip-components=1"; tar -xzf "$NAME" --strip-components=1 && ls | tr '\n' ' '; echo
  echo "# ./blackbox doctor (before setup)"; ./blackbox doctor; echo "# doctor exit: $?"
  echo "# ./blackbox setup $* (pty; key -> $DIR/owner.key 0600; transcript redacted -> $EV/setup-transcript-redacted.txt)"
  T0=$(date +%s); python3 "$REPO/scripts/release/setup-with-key-capture.py" "$DIR" "$DIR/owner.key" "$EV/setup-transcript-redacted.txt" "$@" | grep -v 'bbk_' | tail -3; echo "# setup exit: ${PIPESTATUS[0]} after $(( $(date +%s) - T0 )) s"
  [ -s owner.key ] && echo "# owner.key: $(stat -f '%Sp %z bytes' owner.key)" || echo "# owner.key: NOT captured"
  echo "# ./blackbox up"; T0=$(date +%s); ./blackbox up; echo "# up exit: $? after $(( $(date +%s) - T0 )) s"
  echo "# ./blackbox status"; ./blackbox status; echo "# status exit: $?"
  P="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env)"; echo "# docker compose -p ${P:-blackbox-agent-c} ps"; docker compose -p "${P:-blackbox-agent-c}" ps
  echo "# ./blackbox doctor (after up)"; ./blackbox doctor; echo "# doctor exit: $?"
  echo "# finished: $(date -u +%FT%TZ)"
} > "$EV/fresh-install.txt" 2>&1
grep -c 'bbk_' "$EV/fresh-install.txt" "$EV/setup-transcript-redacted.txt" 2>/dev/null | sed 's/^/# key-pattern lines in evidence: /'
grep -E '^# ' "$EV/fresh-install.txt" | tail -14
