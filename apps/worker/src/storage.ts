/**
 * Storage pressure: warn below max(10%, 5 GiB), critical below max(2%, 1 GiB) by default; thresholds
 * from the tenant storage_thresholds row (first tenant wins for the installation) or env. Critical
 * pauses new fetch/ingestion jobs; cursors are retained.
 */
import { statfs } from 'node:fs/promises';

export interface StorageThresholds { warn_percent: number; warn_min_bytes: number; critical_percent: number; critical_min_bytes: number }
export const DEFAULT_THRESHOLDS: StorageThresholds = { warn_percent: 10, warn_min_bytes: 5 * 1024 ** 3, critical_percent: 2, critical_min_bytes: 1024 ** 3 };

export interface VolumeObservation { path: string; total_bytes: number | null; free_bytes: number | null; state: 'ok' | 'warning' | 'critical' | 'unknown'; reason: string | null }
export interface StorageState { state: 'ok' | 'warning' | 'critical' | 'unknown'; observed_at: string; volumes: VolumeObservation[]; thresholds: StorageThresholds }

export type StorageProbe = (path: string) => Promise<{ total_bytes: number; free_bytes: number }>;

export const fsProbe: StorageProbe = async (path) => {
  const s = await statfs(path);
  return { total_bytes: Number(s.blocks) * Number(s.bsize), free_bytes: Number(s.bavail) * Number(s.bsize) };
};

/**
 * Bind mounts inside Docker Desktop's VM report the VM's virtual disk (hundreds of TiB) instead of the host volume,
 * so a statfs total above this bound cannot be the Mac's disk: the figure is reported as unknown with a reason rather
 * than as a green 'ok' (host pressure is then only visible to the host-side `./blackbox doctor`, DOC-DISK).
 */
export const IMPLAUSIBLE_TOTAL_BYTES = 64 * 1024 ** 4;
export const IMPLAUSIBLE_REASON = 'container-side figures are not the host disk (Docker Desktop bind mount reports the VM disk); check ./blackbox doctor (DOC-DISK) on the host';

export function classify(total: number, free: number, t: StorageThresholds): 'ok' | 'warning' | 'critical' {
  const warnAt = Math.max(total * (t.warn_percent / 100), t.warn_min_bytes);
  const critAt = Math.max(total * (t.critical_percent / 100), t.critical_min_bytes);
  if (free < critAt) return 'critical';
  if (free < warnAt) return 'warning';
  return 'ok';
}

export async function observeStorage(paths: string[], thresholds: StorageThresholds, probe: StorageProbe = fsProbe): Promise<StorageState> {
  const volumes: VolumeObservation[] = [];
  for (const path of paths) {
    try {
      const { total_bytes, free_bytes } = await probe(path);
      if (total_bytes > IMPLAUSIBLE_TOTAL_BYTES) volumes.push({ path, total_bytes, free_bytes, state: 'unknown', reason: IMPLAUSIBLE_REASON });
      else volumes.push({ path, total_bytes, free_bytes, state: classify(total_bytes, free_bytes, thresholds), reason: null });
    }
    catch (err) { volumes.push({ path, total_bytes: null, free_bytes: null, state: 'unknown', reason: (err as Error).message.slice(0, 200) }); }
  }
  const rank = { ok: 0, unknown: 1, warning: 2, critical: 3 } as const;
  const state = volumes.reduce<'ok' | 'warning' | 'critical' | 'unknown'>((acc, v) => (rank[v.state] > rank[acc] ? v.state : acc), volumes.length ? 'ok' : 'unknown');
  return { state, observed_at: new Date().toISOString(), volumes, thresholds };
}
