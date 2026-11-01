import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ApiConfig {
  /** 127.0.0.1 on a host; 0.0.0.0 only inside the Compose container whose port Docker publishes on the host loopback alone. */
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  databaseUrl: string;
  /** bb_migrate connection string (CLI migrate / doctor); null when not configured. */
  migrateDatabaseUrl: string | null;
  /** Directory holding the maintenance fences written by the host wrapper (writers.paused.json, evidence-access.json). */
  fenceDir: string | null;
  secretsDir: string;
  evidenceDir: string;
  logsDir: string;
  snapshotDir: string;
  engineUrl: string;
  engineToken: string | undefined;
  engineTokenFile: string | undefined;
  webDist: string;
  landingDist: string;
  serviceVersion: string;
  instanceId: string | undefined;
  logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
  logCapBytes: number;
  logRetentionDays: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of [path.join(here, "..", "package.json"), path.join(here, "..", "..", "package.json")]) {
      if (existsSync(candidate)) return (JSON.parse(readFileSync(candidate, "utf8")) as { version?: string }).version ?? "0.0.0";
    }
  } catch {
    /* ignore */
  }
  return "0.0.0";
}

function readSecretFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Builds a connection string from the PG* convention used by the Compose release (passwords as
 * secret files, never in the environment or argv): PGHOST/PGPORT/PGDATABASE + role + password file.
 */
export function databaseUrlFromEnv(env: NodeJS.ProcessEnv, user: string | undefined, passwordFile: string | undefined): string | undefined {
  if (!user) return undefined;
  const password = readSecretFile(passwordFile);
  if (password === undefined) return undefined;
  const host = env.PGHOST ?? "127.0.0.1";
  const port = env.PGPORT ?? "5432";
  const db = env.PGDATABASE ?? "blackbox";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
}

/** Resolves the environment aliases used by the Compose release into the canonical variables. */
export function normalizeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (!out.DATABASE_URL) out.DATABASE_URL = databaseUrlFromEnv(env, env.PGUSER ?? "bb_api", env.PGPASSWORD_FILE);
  if (!out.MIGRATE_DATABASE_URL) out.MIGRATE_DATABASE_URL = databaseUrlFromEnv(env, env.PGMIGRATE_USER, env.PGMIGRATE_PASSWORD_FILE);
  if (!out.SECRETS_DIR && env.DATA_KEY_FILE) out.SECRETS_DIR = path.dirname(env.DATA_KEY_FILE);
  if (!out.LOGS_DIR && env.LOG_DIR) out.LOGS_DIR = env.LOG_DIR;
  if (!out.WEB_DIST && env.WEB_DIST_DIR) out.WEB_DIST = env.WEB_DIST_DIR;
  if (!out.LANDING_DIST && env.LANDING_DIST_DIR) out.LANDING_DIST = env.LANDING_DIST_DIR;
  if (!out.SERVICE_VERSION && env.BLACKBOX_VERSION && env.BLACKBOX_VERSION !== "dev") out.SERVICE_VERSION = env.BLACKBOX_VERSION;
  return out;
}

/**
 * Reads the API configuration from the environment. The listener is loopback-only: any HOST
 * other than 127.0.0.1 (including 0.0.0.0, ::, localhost aliases or LAN addresses) is refused
 * with a clear error — public/LAN binding is unsupported, not a hidden config shortcut.
 */
export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): ApiConfig {
  const env = normalizeEnv(rawEnv);
  const host = env.HOST ?? "127.0.0.1";
  // Inside the Compose container the listener must bind the container interface so that Docker's
  // loopback-only publish (127.0.0.1:19180 on the host; the wrapper refuses any other bind) can reach
  // it; the container has no other route in. This is the single documented exception.
  const containerBind = env.BLACKBOX_CONTAINER_BIND === "1" && host === "0.0.0.0";
  if (host !== "127.0.0.1" && !containerBind) {
    throw new ConfigError(`HOST=${host} is not supported: the local pilot binds only to 127.0.0.1. Public or LAN exposure is explicitly unsupported (IDENTITY-ACCESS-AND-RECOVERY.md).`);
  }
  const port = Number(env.PORT ?? "19180");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ConfigError("PORT must be an integer between 1024 and 65535");
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError("DATABASE_URL (bb_api role) or PGHOST/PGUSER/PGPASSWORD_FILE is required");
  const secretsDir = env.SECRETS_DIR;
  if (!secretsDir) throw new ConfigError("SECRETS_DIR is required");
  const evidenceDir = env.EVIDENCE_DIR;
  if (!evidenceDir) throw new ConfigError("EVIDENCE_DIR is required");
  const logsDir = env.LOGS_DIR;
  if (!logsDir) throw new ConfigError("LOGS_DIR is required");
  const engineUrl = env.ENGINE_URL ?? "http://engine:7070";
  if (engineUrl !== "stub" && !/^https?:\/\//.test(engineUrl)) throw new ConfigError("ENGINE_URL must be an http(s) URL or 'stub'");
  const logLevel = (env.LOG_LEVEL ?? "INFO").toUpperCase();
  if (!["DEBUG", "INFO", "WARN", "ERROR"].includes(logLevel)) throw new ConfigError("LOG_LEVEL must be DEBUG|INFO|WARN|ERROR");
  const logCapBytes = Number(env.LOG_CAP_BYTES ?? String(100 * 1024 * 1024));
  const logRetentionDays = Number(env.LOG_RETENTION_DAYS ?? "7");
  if (!(logCapBytes >= 1024 * 1024 && logCapBytes <= 100 * 1024 * 1024)) throw new ConfigError("LOG_CAP_BYTES must be between 1 MiB and 100 MiB");
  if (!(logRetentionDays >= 1 && logRetentionDays <= 7)) throw new ConfigError("LOG_RETENTION_DAYS must be between 1 and 7");
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    host: containerBind ? "0.0.0.0" : "127.0.0.1",
    port,
    databaseUrl,
    migrateDatabaseUrl: env.MIGRATE_DATABASE_URL ?? null,
    fenceDir: env.FENCE_DIR ?? null,
    secretsDir,
    evidenceDir,
    logsDir,
    snapshotDir: env.SNAPSHOT_DIR ?? path.join(evidenceDir, "..", "snapshots"),
    engineUrl,
    engineToken: env.ENGINE_TOKEN,
    engineTokenFile: env.ENGINE_TOKEN_FILE,
    webDist: env.WEB_DIST ?? path.resolve(here, "..", "..", "web", "dist"),
    landingDist: env.LANDING_DIST ?? path.resolve(here, "..", "..", "landing", "dist"),
    serviceVersion: env.SERVICE_VERSION ?? readVersion(),
    instanceId: env.INSTANCE_ID,
    logLevel: logLevel as ApiConfig["logLevel"],
    logCapBytes,
    logRetentionDays,
  };
}
