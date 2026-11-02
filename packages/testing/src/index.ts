import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { bootstrapRoles, createPool, runMigrations, withTenant, MIGRATIONS_DIR, type Pool } from "@blackbox/database";
import { ensureDataKey } from "@blackbox/auth";
import { createLogger, FileCollector, type Logger } from "@blackbox/logging";
import { buildApp, type BuiltApp, type ApiConfig } from "@blackbox/api";

/**
 * Integration-test harness against the real PostgreSQL started with
 * `docker run -d --name blackbox-agent-c-devpg -e POSTGRES_PASSWORD=devpg -p 127.0.0.1:19183:5432 postgres:16-alpine`.
 * Override with TEST_PG_SUPERUSER_URL. Each suite gets its own database (dropped on teardown).
 */
export const SUPERUSER_URL = process.env.TEST_PG_SUPERUSER_URL ?? "postgres://postgres:devpg@127.0.0.1:19183/postgres";
export const ROLE_PASSWORDS = { migrate: "test-migrate-password-01", api: "test-api-password-000001", worker: "test-worker-password-0001", engine: "test-engine-password-0001" };

export interface TestDatabase {
  name: string;
  urls: { migrate: string; api: string; worker: string; engine: string };
  drop(): Promise<void>;
}

function urlFor(role: string, password: string, db: string): string {
  const u = new URL(SUPERUSER_URL);
  return `postgres://${role}:${encodeURIComponent(password)}@${u.hostname}:${u.port || "5432"}/${db}`;
}

/** Checksum of all migration files: the template database is rebuilt whenever a migration changes. */
function migrationsHash(): string {
  const h = createHash("sha256");
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) h.update(f).update(readFileSync(path.join(MIGRATIONS_DIR, f)));
  return h.digest("hex").slice(0, 12);
}

/**
 * Ensures a fully migrated template database exists (created once per migration set, under an
 * advisory lock so parallel test workers do not race) and returns its name.
 */
async function ensureTemplate(): Promise<string> {
  const name = `bbtest_tpl_${migrationsHash()}`;
  const c = new pg.Client({ connectionString: SUPERUSER_URL });
  await c.connect();
  try {
    await c.query("SELECT pg_advisory_lock(7245009)");
    try {
      const exists = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if ((exists.rowCount ?? 0) === 0) {
        await bootstrapRoles({ superuserUrl: SUPERUSER_URL, database: name, passwords: ROLE_PASSWORDS });
        await runMigrations(urlFor("bb_migrate", ROLE_PASSWORDS.migrate, name));
      } else {
        // Roles/passwords are cluster-level: make sure they match this test run's passwords.
        await bootstrapRoles({ superuserUrl: SUPERUSER_URL, database: name, passwords: ROLE_PASSWORDS });
      }
    } finally {
      await c.query("SELECT pg_advisory_unlock(7245009)");
    }
  } finally {
    await c.end();
  }
  return name;
}

export async function createTestDatabase(prefix = "bbtest"): Promise<TestDatabase> {
  const name = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const template = await ensureTemplate();
  const c = new pg.Client({ connectionString: SUPERUSER_URL });
  await c.connect();
  try {
    await c.query("SELECT pg_advisory_lock(7245010)"); // CREATE DATABASE ... TEMPLATE needs no concurrent template use
    try {
      await c.query(`CREATE DATABASE "${name}" TEMPLATE "${template}" OWNER bb_migrate`);
    } finally {
      await c.query("SELECT pg_advisory_unlock(7245010)");
    }
    await c.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    await c.query(`GRANT CONNECT ON DATABASE "${name}" TO bb_migrate, bb_api, bb_worker, bb_engine`);
  } finally {
    await c.end();
  }
  const urls = { migrate: urlFor("bb_migrate", ROLE_PASSWORDS.migrate, name), api: urlFor("bb_api", ROLE_PASSWORDS.api, name), worker: urlFor("bb_worker", ROLE_PASSWORDS.worker, name), engine: urlFor("bb_engine", ROLE_PASSWORDS.engine, name) };
  return {
    name,
    urls,
    drop: async () => {
      const d = new pg.Client({ connectionString: SUPERUSER_URL });
      await d.connect();
      try {
        await d.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [name]);
        await d.query(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await d.end();
      }
    },
  };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export interface TestInstall {
  root: string;
  secretsDir: string;
  evidenceDir: string;
  logsDir: string;
  snapshotDir: string;
  cleanup(): void;
}

export function createTestInstall(): TestInstall {
  const root = mkdtempSync(path.join(os.tmpdir(), "blackbox-test-"));
  const secretsDir = path.join(root, "secrets");
  const evidenceDir = path.join(root, "evidence");
  const logsDir = path.join(root, "logs");
  const snapshotDir = path.join(root, "snapshots");
  for (const d of [evidenceDir, logsDir, snapshotDir]) mkdirSync(d, { recursive: true });
  ensureDataKey(secretsDir);
  return { root, secretsDir, evidenceDir, logsDir, snapshotDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface TestApp {
  db: TestDatabase;
  install: TestInstall;
  built: BuiltApp;
  baseUrl: string;
  port: number;
  pool: Pool;
  logger: Logger;
  collector: FileCollector;
  config: ApiConfig;
  /** Runs owner setup and returns the key. */
  setupOwner(displayName?: string): Promise<{ key: string; tenant_id: string; principal_id: string }>;
  /** Creates a second synthetic tenant directly in the database (TENANT-* tests). */
  createTenant(displayName: string): Promise<string>;
  stop(): Promise<void>;
}

export async function startTestApp(options: { engineUrl?: string; logLevel?: ApiConfig["logLevel"]; db?: TestDatabase; install?: TestInstall } = {}): Promise<TestApp> {
  const db = options.db ?? (await createTestDatabase());
  const install = options.install ?? createTestInstall();
  const port = await freePort();
  const config: ApiConfig = {
    host: "127.0.0.1",
    port,
    publicPort: port,
    databaseUrl: db.urls.api,
    migrateDatabaseUrl: db.urls.migrate,
    fenceDir: null,
    backupStatusFile: null,
    secretsDir: install.secretsDir,
    evidenceDir: install.evidenceDir,
    logsDir: install.logsDir,
    snapshotDir: install.snapshotDir,
    engineUrl: options.engineUrl ?? "stub",
    engineToken: undefined,
    engineTokenFile: undefined,
    webDist: path.join(install.root, "no-web"),
    landingDist: path.join(install.root, "no-landing"),
    serviceVersion: "test",
    instanceId: "test-instance",
    logLevel: options.logLevel ?? "INFO",
    logCapBytes: 100 * 1024 * 1024,
    logRetentionDays: 7,
  };
  const collector = new FileCollector({ dir: install.logsDir, flushIntervalMs: 20 });
  const silent = { write: () => true } as unknown as NodeJS.WritableStream;
  const logger = createLogger({ component: "api", serviceVersion: "test", instanceId: "test-instance", level: config.logLevel, sinks: [collector], stream: process.env.TEST_LOG_STDERR ? process.stderr : silent });
  const pool = createPool(db.urls.api, { applicationName: "blackbox-test-api", max: 6 });
  const built = await buildApp({ config, pool, logger, collector });
  await built.app.listen({ host: "127.0.0.1", port });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    db,
    install,
    built,
    baseUrl,
    port,
    pool,
    logger,
    collector,
    config,
    async setupOwner(displayName = "Studio Nord") {
      const r = await built.ctx.auth.setup({ displayName });
      if (r.status !== "created") throw new Error("setup did not create the owner");
      return { key: r.key, tenant_id: r.tenant_id, principal_id: r.principal_id };
    },
    async createTenant(displayName) {
      const { randomUUID } = await import("node:crypto");
      const id = randomUUID();
      await withTenant(pool, id, async (c) => {
        await c.query("INSERT INTO tenants (tenant_id, display_name) VALUES ($1, $2)", [id, displayName]);
        await c.query("INSERT INTO tenant_sequences (tenant_id, last_sequence) VALUES ($1, 0)", [id]);
        await c.query("INSERT INTO workspace_settings (tenant_id) VALUES ($1)", [id]);
        await c.query("INSERT INTO storage_thresholds (tenant_id) VALUES ($1)", [id]);
      });
      return id;
    },
    async stop() {
      await built.app.close();
      collector.close();
      await pool.end().catch(() => {});
      await db.drop().catch(() => {});
      install.cleanup();
    },
  };
}

/** Minimal HTTP client with cookie jar + CSRF handling for owner sessions and bearer for agents. */
export class ApiClient {
  cookie: string | null = null;
  csrf: string | null = null;
  bearer: string | null = null;
  constructor(readonly baseUrl: string) {}

  /** Uses node:http (not fetch) so forbidden headers such as Origin/Host can be forged in tests. */
  async request(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; headers: Headers; json: unknown; text: string }> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookie) headers.cookie = this.cookie;
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    if (this.csrf && method !== "GET") {
      if (!("x-blackbox-csrf" in headers)) headers["x-blackbox-csrf"] = this.csrf;
      if (!("origin" in headers)) headers.origin = this.baseUrl;
    }
    const u = new URL(`${this.baseUrl}${url}`);
    if (!("host" in headers)) headers.host = u.host;
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const res = await new Promise<{ status: number; headers: Headers; text: string }>((resolve, reject) => {
      const req = http.request({ host: u.hostname, port: Number(u.port), path: `${u.pathname}${u.search}`, method, headers, setHost: false }, (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(r.headers)) if (typeof v === "string") h.set(k, v);
          else if (Array.isArray(v)) h.set(k, v.join(", "));
          resolve({ status: r.statusCode ?? 0, headers: h, text: Buffer.concat(chunks).toString("utf8") });
        });
      });
      req.on("error", reject);
      req.setTimeout(30_000, () => req.destroy(new Error("request timeout")));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const m = /bb_session=([^;]*)/.exec(setCookie);
      if (m) this.cookie = m[1] ? `bb_session=${m[1]}` : null;
    }
    let json: unknown = null;
    try {
      json = res.text ? JSON.parse(res.text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, json, text: res.text };
  }

  get(url: string, headers?: Record<string, string>) {
    return this.request("GET", url, undefined, headers);
  }
  post(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request("POST", url, body ?? {}, headers);
  }
  patch(url: string, body?: unknown) {
    return this.request("PATCH", url, body ?? {});
  }
  delete(url: string) {
    return this.request("DELETE", url);
  }

  async login(key: string, remember = false): Promise<void> {
    const r = await this.request("POST", "/api/auth/login", { key, remember }, { origin: this.baseUrl });
    if (r.status !== 204) throw new Error(`login failed: ${r.status} ${r.text}`);
    const s = await this.get("/api/auth/session");
    if (s.status !== 200) throw new Error(`session failed: ${s.status} ${s.text}`);
    this.csrf = (s.json as { csrf_token: string }).csrf_token;
  }
}

export async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
