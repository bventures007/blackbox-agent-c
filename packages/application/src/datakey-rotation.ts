import type pg from "pg";
import { decryptSecret, reencryptSecret, type DataKey } from "@blackbox/auth";
import { CONNECTION_SECRET_PURPOSE } from "./connections.js";
import { PRODUCER_SECRET_PURPOSE } from "./signed.js";

/**
 * Installation data-key rotation (PILOT-07, docs/operations.md "Data-key rotation").
 *
 * Re-seals every stored secret (connection secrets, signed-producer HMAC secrets) from the live key
 * generation to the candidate generation inside ONE database transaction, verifies that every
 * re-sealed blob opens with the candidate key before COMMIT, and appends a `data_key.rotated`
 * security-audit event per tenant. Nothing on the host changes here: the wrapper swaps the key files
 * only after this transaction committed, and recreates the containers so they mount the new file.
 * A failure anywhere rolls the whole transaction back, so the database never holds a mix of
 * generations and the live key stays valid. Key material never leaves the process; counts only.
 */
export interface RotationReport {
  from_version: number;
  to_version: number;
  tenants: number;
  connections: number;
  producers: number;
  verified: number;
}

export class RotationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RotationError";
    this.code = code;
  }
}

async function setTenant(c: pg.PoolClient, tenantId: string): Promise<void> {
  await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

/** Re-seals all secrets of `tenantIds` from `current` to `next` in one transaction. */
export async function rotateDataKey(pool: pg.Pool, current: DataKey, next: DataKey, tenantIds: string[]): Promise<RotationReport> {
  if (next.version !== current.version + 1) throw new RotationError("version_sequence", `candidate version ${next.version} must be exactly ${current.version + 1}`);
  if (next.key.equals(current.key)) throw new RotationError("same_key", "candidate key material equals the live key");
  const report: RotationReport = { from_version: current.version, to_version: next.version, tenants: 0, connections: 0, producers: 0, verified: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const tenantId of tenantIds) {
      await setTenant(client, tenantId);
      report.tenants += 1;
      const conns = await client.query<{ connection_id: string; secret_ciphertext: Buffer; secret_key_version: number | null }>("SELECT connection_id, secret_ciphertext, secret_key_version FROM connections WHERE tenant_id = $1 AND secret_ciphertext IS NOT NULL FOR UPDATE", [tenantId]);
      for (const row of conns.rows) {
        if ((row.secret_key_version ?? 1) !== current.version) throw new RotationError("mixed_generations", `connection ${row.connection_id} is sealed with key version ${row.secret_key_version}, live key is ${current.version}; complete or restore the previous rotation first`);
        const aad = { tenantId, purpose: CONNECTION_SECRET_PURPOSE };
        const sealed = reencryptSecret(current, next, row.secret_ciphertext, aad);
        await client.query("UPDATE connections SET secret_ciphertext = $2, secret_key_version = $3, updated_at = now() WHERE connection_id = $1 AND tenant_id = $4", [row.connection_id, sealed, next.version, tenantId]);
        report.connections += 1;
      }
      const prods = await client.query<{ producer_id: string; secret_ciphertext: Buffer; secret_key_version: number }>("SELECT producer_id, secret_ciphertext, secret_key_version FROM producer_credentials WHERE tenant_id = $1 FOR UPDATE", [tenantId]);
      for (const row of prods.rows) {
        if (row.secret_key_version !== current.version) throw new RotationError("mixed_generations", `producer ${row.producer_id} is sealed with key version ${row.secret_key_version}, live key is ${current.version}`);
        const aad = { tenantId, purpose: PRODUCER_SECRET_PURPOSE };
        const sealed = reencryptSecret(current, next, row.secret_ciphertext, aad);
        await client.query("UPDATE producer_credentials SET secret_ciphertext = $2, secret_key_version = $3 WHERE producer_id = $1 AND tenant_id = $4", [row.producer_id, sealed, next.version, tenantId]);
        report.producers += 1;
      }
      // Verify before anything is retired: every re-sealed blob must open with the candidate key.
      report.verified += await verifyTenant(client, tenantId, next);
      await client.query("INSERT INTO security_audit (tenant_id, event, actor_kind, actor_id, channel, metadata) VALUES ($1, 'data_key.rotated', 'host', NULL, 'host_cli', $2)", [tenantId, JSON.stringify({ from_version: current.version, to_version: next.version, connections: conns.rows.length, producers: prods.rows.length })]);
    }
    await client.query("COMMIT");
    return report;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function verifyTenant(c: pg.PoolClient, tenantId: string, key: DataKey): Promise<number> {
  let n = 0;
  const conns = await c.query<{ connection_id: string; secret_ciphertext: Buffer; secret_key_version: number | null }>("SELECT connection_id, secret_ciphertext, secret_key_version FROM connections WHERE tenant_id = $1 AND secret_ciphertext IS NOT NULL", [tenantId]);
  for (const row of conns.rows) {
    if ((row.secret_key_version ?? 1) !== key.version) throw new RotationError("verify_version", `connection ${row.connection_id} carries key version ${row.secret_key_version}, expected ${key.version}`);
    decryptSecret(key, row.secret_ciphertext, { tenantId, purpose: CONNECTION_SECRET_PURPOSE });
    n += 1;
  }
  const prods = await c.query<{ producer_id: string; secret_ciphertext: Buffer; secret_key_version: number }>("SELECT producer_id, secret_ciphertext, secret_key_version FROM producer_credentials WHERE tenant_id = $1", [tenantId]);
  for (const row of prods.rows) {
    if (row.secret_key_version !== key.version) throw new RotationError("verify_version", `producer ${row.producer_id} carries key version ${row.secret_key_version}, expected ${key.version}`);
    decryptSecret(key, row.secret_ciphertext, { tenantId, purpose: PRODUCER_SECRET_PURPOSE });
    n += 1;
  }
  return n;
}

/** Read-only check that every stored secret of the given tenants opens with the live key. */
export async function verifyDataKey(pool: pg.Pool, live: DataKey, tenantIds: string[]): Promise<{ tenants: number; verified: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let verified = 0;
    for (const tenantId of tenantIds) {
      await setTenant(client, tenantId);
      verified += await verifyTenant(client, tenantId, live);
    }
    await client.query("COMMIT");
    return { tenants: tenantIds.length, verified };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
