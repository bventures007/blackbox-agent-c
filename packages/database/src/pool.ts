import pg from "pg";

export type { PoolClient } from "pg";
export type Pool = pg.Pool;

/**
 * Creates a pg Pool for one runtime role. Connection strings come from the environment
 * (DATABASE_URL for bb_api, WORKER_DATABASE_URL for bb_worker, ENGINE_DATABASE_URL for bb_engine);
 * passwords never appear on the command line. Every statement that touches tenant data must run
 * through `withTenant` (tenant.ts), which sets app.tenant_id for exactly one transaction.
 */
export function createPool(connectionString: string, options: { max?: number; applicationName?: string } = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 8,
    application_name: options.applicationName ?? "blackbox",
    // Fail fast instead of hanging a request when PostgreSQL is down.
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
  });
  // Do not let an idle-client error crash the process; callers see errors on their next query.
  pool.on("error", () => {});
  return pool;
}

/** Parses `postgres://user:pass@host:port/db` into a redacted label for logs (no password). */
export function describeConnection(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    return `${u.username || "?"}@${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "invalid-connection-string";
  }
}
