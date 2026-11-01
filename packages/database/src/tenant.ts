import type pg from "pg";

export type TenantClient = pg.PoolClient;

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(value: unknown, what = "id"): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new TenantScopeError(`${what} is not a valid uuid`);
  }
  return value.toLowerCase();
}

/**
 * Runs `fn` inside one transaction whose first statement is
 * `SELECT set_config('app.tenant_id', $1, true)`; the setting is transaction-local (is_local=true),
 * so it is discarded at COMMIT/ROLLBACK and never survives on a pooled connection.
 * The caller must already have verified that the principal belongs to `tenantId`.
 */
export async function withTenant<T>(pool: pg.Pool, tenantId: string, fn: (client: TenantClient) => Promise<T>): Promise<T> {
  const tenant = assertUuid(tenantId, "tenant_id");
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const result = await fn(client);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (err) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* connection may be gone; release below destroys it */
      }
    }
    throw err;
  } finally {
    // Transaction-local settings (is_local=true) are discarded by PostgreSQL at COMMIT/ROLLBACK;
    // nothing survives on the pooled connection (verified by the TENANT-03 integration test).
    client.release();
  }
}

/**
 * Authentication transaction: resolves credentials/sessions before the workspace is known.
 * Only the identity tables allow this context (see 0002_identity.sql); business tables stay
 * closed because app.tenant_id is not set.
 */
export async function withAuthenticator<T>(pool: pg.Pool, fn: (client: TenantClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SELECT set_config('app.auth_context', 'authenticator', true)");
    const result = await fn(client);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (err) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Installation-scoped statements (no tenant tables): throttle, migrations table, health probes. */
export async function withInstallation<T>(pool: pg.Pool, fn: (client: TenantClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }
}
