/**
 * Minimal tenant-scoped transaction helper for the worker role. Mirrors packages/database/src/tenant.ts
 * (set_config('app.tenant_id', $1, true) as the first statement; RESET ALL on release) so the two can be
 * unified once the database package is built as part of the worker's dependency graph.
 */
import pg from 'pg';

export type { PoolClient } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(value: unknown, what = 'id'): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new Error(`${what} is not a valid uuid`);
  return value.toLowerCase();
}

export function createWorkerPool(connectionString: string, max = 4): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, application_name: 'blackbox-worker', connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000 });
  pool.on('error', () => {});
  return pool;
}

export async function withTenant<T>(pool: pg.Pool, tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const tenant = assertUuid(tenantId, 'tenant_id');
  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const result = await fn(client);
    await client.query('COMMIT');
    began = false;
    return result;
  } catch (err) {
    if (began) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    try { await client.query('RESET ALL'); client.release(); } catch { client.release(true); }
  }
}

/** Installation-scoped statements (tables without tenant_id: worker_heartbeat, pgboss). */
export async function withInstallation<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try { const r = await fn(client); await client.query('COMMIT'); return r; }
    catch (err) { await client.query('ROLLBACK').catch(() => undefined); throw err; }
  } finally {
    try { await client.query('RESET ALL'); client.release(); } catch { client.release(true); }
  }
}
