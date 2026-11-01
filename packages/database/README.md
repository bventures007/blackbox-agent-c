# @blackbox/database

PostgreSQL access for the backend: `pg` pools per runtime role, tenant-scoped transactions
(`withTenant` sets `app.tenant_id` transaction-locally as the first statement), the authenticator
transaction for credential/session lookup, the plain-SQL migration runner (`schema_migrations`
with checksums, advisory lock) and the superuser bootstrap (`0000_roles.sql`, passwords from
`BB_*_PASSWORD` env). `migrations/` is the binding schema; `src/schema.ts` is a drizzle mirror of
the mutable tables for typing only. See `docs/architecture.md`.
