-- 0000_roles.sql — runtime roles. Executed by the wrapper/migrator as the bootstrap superuser with
-- psql variables :api_password :worker_password :engine_password (never command-line arguments in logs).
-- Idempotent: safe to re-run; passwords are rotated by ./blackbox setup/upgrade only when provided.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bb_migrate') THEN CREATE ROLE bb_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bb_api')     THEN CREATE ROLE bb_api     LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bb_worker')  THEN CREATE ROLE bb_worker  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bb_engine')  THEN CREATE ROLE bb_engine  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
END $$;

-- Planner/RLS interaction (ADR-0008, measured under PILOT-09): PostgreSQL evaluates a non-LEAKPROOF operator only
-- above the row-level-security barrier, so as bb_api/bb_worker (tenant_scope policy) `entity_refs @> $1` could never
-- become an index condition on journal_entries_entity_idx (GIN) and every entity read scanned the whole tenant journal;
-- under any policy (bb_engine included) its selectivity could not use the column statistics (default 1 %), producing
-- BitmapAnd plans over the complete tenant. jsonb_contains(jsonb, jsonb) raises no value-dependent error and has no
-- side effects; the tenant policy still filters every returned row. Superuser-only (pg_catalog function), idempotent,
-- reversible with `ALTER FUNCTION pg_catalog.jsonb_contains(jsonb, jsonb) NOT LEAKPROOF`.
ALTER FUNCTION pg_catalog.jsonb_contains(jsonb, jsonb) LEAKPROOF;
