import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Host-wrapper maintenance fences (docs/operations.md): files under FENCE_DIR (/data/state) written
 * by `./blackbox backup|restore|upgrade`. The API refuses writes while writers are paused and
 * withholds raw evidence while a restore's redaction policy is unreconciled. The files are the
 * contract; their absence means "no fence".
 */
export const WRITERS_PAUSED_FILE = "writers.paused.json";
export const EVIDENCE_ACCESS_FILE = "evidence-access.json";

export interface WritersFence {
  reason: string;
  since: string | null;
  owner: string | null;
}

export interface EvidenceFence {
  blocked: boolean;
  reason: string;
  since: string | null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // An unreadable fence file still fences: fail closed.
    return {};
  }
}

export function readWritersFence(fenceDir: string | null): WritersFence | null {
  if (!fenceDir) return null;
  const j = readJson(path.join(fenceDir, WRITERS_PAUSED_FILE));
  if (!j) return null;
  return { reason: typeof j.reason === "string" ? j.reason : "maintenance", since: typeof j.since === "string" ? j.since : null, owner: typeof j.owner === "string" ? j.owner : null };
}

export function readEvidenceFence(fenceDir: string | null): EvidenceFence | null {
  if (!fenceDir) return null;
  const j = readJson(path.join(fenceDir, EVIDENCE_ACCESS_FILE));
  if (!j) return null;
  const blocked = j.blocked === undefined ? true : Boolean(j.blocked);
  if (!blocked) return null;
  return { blocked: true, reason: typeof j.reason === "string" ? j.reason : "evidence_access_blocked", since: typeof j.since === "string" ? j.since : null };
}

/** Routes that must keep working while writers are fenced (sign-in/out, read-only diagnostics). */
export function isFenceExempt(method: string, url: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const p = url.split("?")[0] ?? url;
  return p === "/api/auth/login" || p === "/api/auth/logout" || p.startsWith("/api/diagnostics/");
}
