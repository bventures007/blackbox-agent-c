-- 0000_roles.sql — runtime roles. Executed by the wrapper/migrator as the bootstrap superuser with
-- psql variables :api_password :worker_password :engine_password (never command-line arguments in logs).
-- Idempotent: safe to re-run; passwords are rotated by ./blackbox setup/upgrade only when provided.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bb_migrate') THEN CREATE ROLE bb_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bb_api')     THEN CREATE ROLE bb_api     LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bb_worker')  THEN CREATE ROLE bb_worker  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bb_engine')  THEN CREATE ROLE bb_engine  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
END $$;
