#!/bin/bash
# Retention: keep the newest <daily> finalized daily generations and the newest <weekly> finalized
# weekly generations (a weekly generation is also a daily one). Deletes only generations whose
# sidecar says finalized:true and whose install_id matches this installation. Never deletes the
# last usable generation and never follows symlinks out of the destination.
set -euo pipefail
. /scripts/common.sh
DEST="${1:?destination}"; INSTALL="${2:-}"; DAILY="${3:-7}"; WEEKLY="${4:-4}"
cd "$DEST"
list=()
for m in blackbox-backup-*.meta.json; do
  [ -f "$m" ] || continue
  [ -L "$m" ] && continue
  f="$(jq -r '.file // empty' "$m")"; fin="$(jq -r '.finalized // false' "$m")"; id="$(jq -r '.install_id // empty' "$m")"
  [ -n "$f" ] && [ -f "$f" ] && [ ! -L "$f" ] && [ "$fin" = "true" ] || continue
  if [ -n "$INSTALL" ] && [ "$id" != "$INSTALL" ]; then continue; fi
  list+=("$m")
done
total=${#list[@]}
[ "$total" -le 1 ] && { log "retention: $total finalized generation(s); nothing to prune"; exit 0; }
# newest first (timestamps sort lexically)
sorted=($(printf '%s\n' "${list[@]}" | sort -r))
keep=()
n=0; for m in "${sorted[@]}"; do [ $n -lt "$DAILY" ] && keep+=("$m"); n=$((n+1)); done
n=0; for m in "${sorted[@]}"; do
  if [ "$(jq -r '.weekly // false' "$m")" = "true" ]; then [ $n -lt "$WEEKLY" ] && keep+=("$m"); n=$((n+1)); fi
done
removed=0
for m in "${sorted[@]}"; do
  skip=false; for k in "${keep[@]}"; do [ "$k" = "$m" ] && skip=true; done
  $skip && continue
  f="$(jq -r '.file' "$m")"
  rm -f -- "$f" "$m"; removed=$((removed+1)); log "retention: removed $f"
done
log "retention: kept $((total-removed)) of $total finalized generation(s) (daily=$DAILY weekly=$WEEKLY)"
