#!/bin/sh
# Blackbox api image entrypoint. Default: the API server. The host wrapper runs one-off CLI commands as
# `compose run --rm api node /app/apps/api/dist/cli.js <cmd>`; an explicit `node ...` argument vector is
# executed as given instead of being appended to the server command.
set -e
if [ "${1:-}" = "node" ]; then
  exec "$@"
fi
exec node /app/apps/api/dist/server.js "$@"
