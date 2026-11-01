/**
 * Host-wrapper writer fence: while FENCE_DIR/writers.paused.json exists (backup, restore, upgrade)
 * the worker schedules nothing and lets queued jobs wait, keeping checkpoints untouched.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const WRITERS_PAUSED_FILE = 'writers.paused.json';

export function writersPaused(fence_dir: string | null): { reason: string; since: string | null } | null {
  if (!fence_dir) return null;
  const file = path.join(fence_dir, WRITERS_PAUSED_FILE);
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { reason?: string; since?: string };
    return { reason: typeof j.reason === 'string' ? j.reason : 'maintenance', since: typeof j.since === 'string' ? j.since : null };
  } catch {
    return { reason: 'maintenance', since: null }; // unreadable fence still fences (fail closed)
  }
}

/** Waits (polling) until the fence clears or `max_ms` elapses; returns true when clear. */
export async function waitForWriters(fence_dir: string | null, max_ms: number, poll_ms = 2000): Promise<boolean> {
  const until = Date.now() + max_ms;
  while (writersPaused(fence_dir)) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, poll_ms));
  }
  return true;
}
