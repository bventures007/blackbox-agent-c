import { statfs } from "node:fs/promises";
import { withTenant } from "@blackbox/database";
import type { AppContext } from "./context.js";

/** Docker Desktop bind mounts report the VM's virtual disk (hundreds of TiB), never the Mac's volume. */
export const IMPLAUSIBLE_TOTAL_BYTES = 64 * 1024 ** 4;
export const IMPLAUSIBLE_REASON = "container-side figures are not the host disk (Docker Desktop bind mount); check ./blackbox doctor (DOC-DISK) on the host";

export type VolumeState = "ok" | "warning" | "critical" | "unknown" | "unavailable";
export interface VolumeFigures { total_bytes?: number; free_bytes?: number; state: VolumeState; reason?: string }

/** Thresholds row of the workspace (owner-editable through PATCH /api/settings/storage) and the three volumes' states. */
export async function observeVolumes(ctx: AppContext, tenantId: string): Promise<{ thresholds: Record<string, unknown> | undefined; volumes: Record<string, VolumeFigures> }> {
  const thresholds = await withTenant(ctx.pool, tenantId, async (c) => (await c.query("SELECT * FROM storage_thresholds WHERE tenant_id = $1", [tenantId])).rows[0] as Record<string, unknown> | undefined);
  const volumes: Record<string, VolumeFigures> = {};
  for (const [name, dir] of [["evidence", ctx.config.evidenceDir], ["logs", ctx.config.logsDir], ["snapshots", ctx.config.snapshotDir]] as const) {
    try {
      const s = await statfs(dir);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      const warnAt = Math.max((Number(thresholds?.warn_percent ?? 10) / 100) * total, Number(thresholds?.warn_min_bytes ?? 5368709120));
      const critAt = Math.max((Number(thresholds?.critical_percent ?? 2) / 100) * total, Number(thresholds?.critical_min_bytes ?? 1073741824));
      if (total > IMPLAUSIBLE_TOTAL_BYTES) volumes[name] = { total_bytes: total, free_bytes: free, state: "unknown", reason: IMPLAUSIBLE_REASON };
      else volumes[name] = { total_bytes: total, free_bytes: free, state: free < critAt ? "critical" : free < warnAt ? "warning" : "ok" };
    } catch (err) {
      volumes[name] = { state: "unavailable", reason: (err as NodeJS.ErrnoException).code ?? "stat_failed" };
    }
  }
  return { thresholds, volumes };
}

/** Names of volumes in the critical state (PILOT-06: critical capacity pauses new ingestion; reads stay available). */
export async function criticalVolumes(ctx: AppContext, tenantId: string): Promise<string[]> {
  const { volumes } = await observeVolumes(ctx, tenantId);
  return Object.entries(volumes).filter(([, v]) => v.state === "critical").map(([k]) => k);
}
