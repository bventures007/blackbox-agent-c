# @blackbox/testing

Integration-test harness: creates a per-suite database by cloning a migrated template on the dev
PostgreSQL (`docker run -d --name blackbox-agent-c-devpg -e POSTGRES_PASSWORD=devpg -p 127.0.0.1:19183:5432 postgres:16-alpine`,
override with `TEST_PG_SUPERUSER_URL`), a temporary install (secrets/evidence/logs/snapshots), an
API instance on a free loopback port with the engine stub, and `ApiClient` (node:http with cookie
jar, CSRF and bearer handling, forgeable headers).
