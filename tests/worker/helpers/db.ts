/**
 * Test database bootstrap against the dedicated container:
 *   docker run -d --name blackbox-agent-c-workerpg -e POSTGRES_PASSWORD=workerpg -p 127.0.0.1:19185:5432 postgres:16-alpine
 * Applies 0000 (superuser), then every other migration as bb_migrate, and returns a bb_worker pool.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createWorkerPool, withTenant, sealSecret, type SecretKeyring } from '@blackbox/connectors';

export const SUPERUSER_URL = process.env.WORKER_TEST_SUPERUSER_URL ?? 'postgres://postgres:workerpg@127.0.0.1:19185/postgres';
/** host:port of the throwaway container (WORKER_TEST_SUPERUSER_URL may move it to another loopback port). */
const PG_HOSTPORT = `${new URL(SUPERUSER_URL).hostname}:${new URL(SUPERUSER_URL).port || '5432'}`;
export const WORKER_PASSWORD = 'workerpg_worker_test_password';
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'database', 'migrations');
export const KEYRING: SecretKeyring = { version: 1, key: Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex'), path: 'test://data.key' };

export interface TestDb { name: string; workerUrl: string; pool: pg.Pool; superuser: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>; close: () => Promise<void> }

export async function createTestDatabase(prefix = 'bb_worker_test'): Promise<TestDb> {
  const name = `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const admin = new pg.Client({ connectionString: SUPERUSER_URL });
  await admin.connect();
  await admin.query(await readFile(path.join(MIGRATIONS_DIR, '0000_roles.sql'), 'utf8'));
  for (const [role, pw] of [['bb_migrate', 'migrate_test_password_000'], ['bb_api', 'api_test_password_000000'], ['bb_worker', WORKER_PASSWORD], ['bb_engine', 'engine_test_password_0000']]) {
    await admin.query(`ALTER ROLE ${role} PASSWORD '${pw}'`);
  }
  await admin.query(`CREATE DATABASE ${name} OWNER bb_migrate`);
  await admin.end();
  const dbSuper = new pg.Client({ connectionString: SUPERUSER_URL.replace(/\/postgres$/, `/${name}`) });
  await dbSuper.connect();
  await dbSuper.query('REVOKE ALL ON DATABASE ' + name + ' FROM PUBLIC');
  await dbSuper.query(`GRANT CONNECT ON DATABASE ${name} TO bb_migrate, bb_api, bb_worker, bb_engine`);
  await dbSuper.query('SET ROLE bb_migrate');
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.startsWith('0000_')).sort();
  for (const f of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
    try { await dbSuper.query(sql); } catch (err) { throw new Error(`migration ${f} failed: ${(err as Error).message}`); }
  }
  await dbSuper.query('RESET ROLE');
  const workerUrl = `postgres://bb_worker:${WORKER_PASSWORD}@${PG_HOSTPORT}/${name}`;
  const pool = createWorkerPool(workerUrl, 4);
  return {
    name, workerUrl, pool,
    superuser: (sql, params) => dbSuper.query(sql, params),
    close: async () => { await pool.end(); await dbSuper.end(); const a = new pg.Client({ connectionString: SUPERUSER_URL }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end(); },
  };
}

export async function createTenant(db: TestDb, display_name: string): Promise<string> {
  const tenant_id = randomUUID();
  await withTenant(db.pool, tenant_id, async (c) => {
    await c.query('INSERT INTO tenants (tenant_id, display_name) VALUES ($1, $2)', [tenant_id, display_name]);
    await c.query('INSERT INTO tenant_sequences (tenant_id, last_sequence) VALUES ($1, 0)', [tenant_id]);
  });
  return tenant_id;
}

export interface ConnectionSpec { provider: string; base_url?: string; shop_domain?: string; secret?: Record<string, unknown>; account_ref?: string | null; page_size?: number }

export async function createConnection(db: TestDb, tenant_id: string, spec: ConnectionSpec): Promise<string> {
  const sealed = sealSecret(spec.secret ?? { access_token: 'shpat_fixture_0123456789abcdef' }, KEYRING, tenant_id);
  return withTenant(db.pool, tenant_id, async (c) => {
    const r = await c.query<{ connection_id: string }>(
      `INSERT INTO connections (tenant_id, provider, account_ref, display_name, status, config_json, secret_ciphertext, secret_key_version) VALUES ($1, $2, $3, $4, 'configured', $5, $6, $7) RETURNING connection_id`,
      [tenant_id, spec.provider, spec.account_ref ?? null, `${spec.provider} test`, JSON.stringify({ shop_domain: spec.shop_domain ?? 'fixture-42.myshopify.com', base_url: spec.base_url, page_size: spec.page_size ?? 7 }), sealed.ciphertext, sealed.key_version]);
    return r.rows[0]!.connection_id;
  });
}

export async function createPlan(db: TestDb, tenant_id: string, connection_id: string, plan: { requested_from: string; initial_cutoff: string; include_open_context?: boolean; strict_from_now?: boolean; preset?: string }): Promise<string> {
  return withTenant(db.pool, tenant_id, async (c) => {
    const r = await c.query<{ plan_id: string }>(
      `INSERT INTO import_plans (tenant_id, connection_id, preset, timezone, requested_from, initial_cutoff, include_open_context, include_opening_state, strict_from_now) VALUES ($1, $2, $3, 'Europe/Berlin', $4, $5, $6, true, $7) RETURNING plan_id`,
      [tenant_id, connection_id, plan.preset ?? 'last_30_days', plan.strict_from_now ? null : plan.requested_from, plan.initial_cutoff, plan.include_open_context ?? true, plan.strict_from_now ?? false]);
    return r.rows[0]!.plan_id;
  });
}

export async function tenantQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(db: TestDb, tenant_id: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return withTenant(db.pool, tenant_id, async (c) => (await c.query<T>(sql, params)).rows);
}
