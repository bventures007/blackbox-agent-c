#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { MIGRATIONS_DIR } from "./migrate.js";

export interface BootstrapOptions {
  /** Superuser connection string (e.g. the Compose postgres service). */
  superuserUrl: string;
  /** Database to create/own for the installation (default: blackbox). */
  database?: string;
  passwords: { migrate: string; api: string; worker: string; engine: string };
  log?: (line: string) => void;
}

const ROLE_ENV: Array<[keyof BootstrapOptions["passwords"], string, string]> = [
  ["migrate", "bb_migrate", "BB_MIGRATE_PASSWORD"],
  ["api", "bb_api", "BB_API_PASSWORD"],
  ["worker", "bb_worker", "BB_WORKER_PASSWORD"],
  ["engine", "bb_engine", "BB_ENGINE_PASSWORD"],
];

/**
 * Executes migrations/0000_roles.sql as the bootstrap superuser, sets the four role passwords
 * from the supplied values (read from the environment by the CLI, never from argv) and ensures the
 * installation database exists and is owned by bb_migrate. Idempotent.
 */
export async function bootstrapRoles(options: BootstrapOptions): Promise<{ database: string; createdDatabase: boolean }> {
  const log = options.log ?? (() => {});
  const database = options.database ?? "blackbox";
  if (!/^[a-z_][a-z0-9_]*$/.test(database)) throw new Error("database name must match ^[a-z_][a-z0-9_]*$");
  const rolesSql = await readFile(path.join(MIGRATIONS_DIR, "0000_roles.sql"), "utf8");
  const client = new pg.Client({ connectionString: options.superuserUrl, application_name: "blackbox-bootstrap" });
  await client.connect();
  let createdDatabase = false;
  try {
    await client.query(rolesSql);
    log("roles ensured");
    for (const [key, role, env] of ROLE_ENV) {
      const pw = options.passwords[key];
      if (!pw || pw.length < 16) throw new Error(`${env} must be set with at least 16 characters`);
      // Pass the password as a bind parameter into a transaction-local setting so it never appears
      // inside the SQL text; the DO block reads it back for ALTER ROLE.
      await client.query("BEGIN");
      await client.query("SELECT set_config('bb.role_password', $1, true)", [pw]);
      await client.query(`DO $$ BEGIN EXECUTE format('ALTER ROLE ${role} PASSWORD %L', current_setting('bb.role_password', true)); END $$`);
      await client.query("COMMIT");
    }
    log("role passwords set");
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${database}" OWNER bb_migrate`);
      createdDatabase = true;
      log(`database ${database} created`);
    } else {
      await client.query(`ALTER DATABASE "${database}" OWNER TO bb_migrate`);
    }
    // Runtime roles may connect; schema objects are created by bb_migrate in migrations.
    await client.query(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE "${database}" TO bb_migrate, bb_api, bb_worker, bb_engine`);
  } finally {
    await client.end();
  }
  // The public schema of a fresh PG16 database is owned by pg_database_owner, i.e. bb_migrate,
  // so migrations can create objects and grant usage; nothing else to do here.
  return { database, createdDatabase };
}

export function passwordsFromEnv(env: NodeJS.ProcessEnv = process.env): BootstrapOptions["passwords"] {
  const get = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${name} is required (set it in the environment or a secrets file; never pass it on the command line)`);
    return v;
  };
  return { migrate: get("BB_MIGRATE_PASSWORD"), api: get("BB_API_PASSWORD"), worker: get("BB_WORKER_PASSWORD"), engine: get("BB_ENGINE_PASSWORD") };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const superuserUrl = process.env.BB_SUPERUSER_URL;
  if (!superuserUrl) {
    process.stderr.write("BB_SUPERUSER_URL is required\n");
    process.exit(2);
  }
  bootstrapRoles({ superuserUrl, database: process.env.BB_DATABASE, passwords: passwordsFromEnv(), log: (l) => process.stderr.write(`bootstrap: ${l}\n`) })
    .then((r) => {
      process.stdout.write(JSON.stringify(r) + "\n");
    })
    .catch((err) => {
      process.stderr.write(`bootstrap failed: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
