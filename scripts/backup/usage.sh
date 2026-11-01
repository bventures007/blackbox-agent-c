#!/bin/bash
cat <<'TXT'
blackbox/backup operations image. Invoked by ./blackbox only:
  /scripts/backup.sh [manual|scheduled|pre-upgrade]   create one encrypted generation
  /scripts/restore.sh inspect|unpack|database|ledger|finish
  /scripts/retention.sh <dest> <install_id> <daily> <weekly>
  /scripts/scheduler.sh                               long-running due-check loop
TXT
