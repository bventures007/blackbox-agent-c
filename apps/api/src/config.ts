import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ApiConfig {
  host: "127.0.0.1";
  port: number;
  databaseUrl: string;
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

/**
 * Reads the API configuration from the environment. The listener is loopback-only: any HOST
 * other than 127.0.0.1 (including 0.0.0.0, ::, localhost aliases or LAN addresses) is refused
 * with a clear error — public/LAN binding is unsupported, not a hidden config shortcut.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const host = env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new ConfigError(`HOST=${host} is not supported: the local pilot binds only to 127.0.0.1. Public or LAN exposure is explicitly unsupported (IDENTITY-ACCESS-AND-RECOVERY.md).`);
  }
  const port = Number(env.PORT ?? "19180");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ConfigError("PORT must be an integer between 1024 and 65535");
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError("DATABASE_URL (bb_api role) is required");
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
    host: "127.0.0.1",
    port,
    databaseUrl,
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
