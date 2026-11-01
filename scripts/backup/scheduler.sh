#!/bin/bash
# Persisted backup scheduler (one container, started by `./blackbox up`). Every CHECK_INTERVAL it
# reads status.json; when a destination is enrolled and the newest finalized generation is older than
# 24 h (plus a 30-minute completion allowance), it runs ONE overdue backup. It does not replay missed
# intervals. Writers are fenced through /data/state/writers.paused.json (honored by api/worker).
set -euo pipefail
. /scripts/common.sh
CHECK_INTERVAL="${BACKUP_CHECK_INTERVAL_SECONDS:-600}"
OBJECTIVE="${BACKUP_OBJECTIVE_SECONDS:-86400}"
ALLOWANCE="${BACKUP_ALLOWANCE_SECONDS:-1800}"
FENCE="$STATE_DIR/writers.paused.json"
log "scheduler started (objective ${OBJECTIVE}s, allowance ${ALLOWANCE}s, check every ${CHECK_INTERVAL}s)"
while true; do
  if [ -f "$BACKUP_DESTINATION/$MARKER_NAME" ] && [ -r "$BACKUP_RECIPIENT_FILE" ]; then
    last="$(read_status | jq -r '.last_completed_at // empty')"
    now=$(date -u +%s); due=0
    if [ -z "$last" ]; then due=1; else
      last_s=$(date -u -d "$last" +%s 2>/dev/null || echo 0)
      [ $((now - last_s)) -ge $((OBJECTIVE)) ] && due=1
      [ $((now - last_s)) -ge $((OBJECTIVE + ALLOWANCE)) ] && merge_status '{"status":"overdue"}'
    fi
    if [ "$due" = 1 ] && [ ! -f "$FENCE" ] && [ "$(read_status | jq -r '.status // ""')" != "running" ]; then
      log "backup due; fencing writers"
      jq -n --arg t "$(now_iso)" '{reason:"scheduled_backup", since:$t, owner:"backup-scheduler"}' > "$FENCE.tmp" && mv -f "$FENCE.tmp" "$FENCE"
      sleep 5  # let in-flight worker jobs observe the fence
      /scripts/backup.sh scheduled || log "scheduled backup failed (will retry at next due check)"
      rm -f "$FENCE"
    fi
  else
    merge_status "$(jq -n '{status:"not_configured", configured:false}')" >/dev/null 2>&1 || true
  fi
  sleep "$CHECK_INTERVAL"
done
