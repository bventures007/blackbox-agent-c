import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Applies plain SQL migrations in file order using a `schema_migrations` table. Runs as the
 * migration role (bb_migrate, owner of all objects). 0000_roles.sql is excluded: it needs the
 * bootstrap superuser and is executed by `bootstrap.ts`.
 */
export async function runMigrations(connectionString: string, options: { dir?: string; log?: (line: string) => void } = {}): Promise<MigrationResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => {});
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.startsWith("0000_")).sort();
  const client = new pg.Client({ connectionString, application_name: "blackbox-migrate" });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    // One migrator at a time (upgrade lease): a second concurrent run waits, then sees the rows.
    await client.query("SELECT pg_advisory_lock(7245001)");
    try {
      const done = await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations");
      const doneMap = new Map(done.rows.map((r) => [r.name, r.checksum]));
      for (const file of files) {
        const sql = await readFile(path.join(dir, file), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const existing = doneMap.get(file);
        if (existing) {
          if (existing !== checksum) {
            throw new Error(`migration ${file} was modified after it was applied (checksum mismatch); refusing to continue`);
          }
          skipped.push(file);
          continue;
        }
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw new Error(`migration ${file} failed: ${(err as Error).message}`);
        }
        applied.push(file);
        log(`applied ${file}`);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(7245001)").catch(() => {});
    }
  } finally {
    await client.end();
  }
  return { applied, skipped };
}

/** Lists migration names that are present on disk but not yet applied (doctor/health use). */
export async function pendingMigrations(connectionString: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.startsWith("0000_")).sort();
  const client = new pg.Client({ connectionString, application_name: "blackbox-migrate-check" });
  await client.connect();
  try {
    const exists = await client.query("SELECT to_regclass('public.schema_migrations') AS t");
    if (!exists.rows[0]?.t) return files;
    const done = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const doneSet = new Set(done.rows.map((r) => r.name));
    return files.filter((f) => !doneSet.has(f));
  } finally {
    await client.end();
  }
}
