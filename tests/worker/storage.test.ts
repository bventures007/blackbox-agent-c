/**
 * PILOT-06: storage observation. Implausible container-side totals (Docker Desktop bind mounts report the VM's
 * virtual disk) are reported as unknown with a reason instead of a green 'ok'; real pressure classifies as before.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, IMPLAUSIBLE_TOTAL_BYTES, classify, observeStorage } from '../../apps/worker/src/storage.ts';

describe('storage observation (PILOT-06)', () => {
  it('classifies real volumes by max(percent, floor)', () => {
    const t = DEFAULT_THRESHOLDS;
    expect(classify(1000 * 1024 ** 3, 500 * 1024 ** 3, t)).toBe('ok');
    expect(classify(1000 * 1024 ** 3, 50 * 1024 ** 3, t)).toBe('warning'); // between 2 % (20 GiB) and 10 % (100 GiB)
    expect(classify(1000 * 1024 ** 3, 0.5 * 1024 ** 3, t)).toBe('critical');
    expect(classify(40 * 1024 ** 3, 0.9 * 1024 ** 3, t)).toBe('critical'); // floor wins over 2 %
  });
  it('reports Docker-Desktop-style implausible totals as unknown with a reason, never as ok', async () => {
    const s = await observeStorage(['/data/evidence', '/data/logs'], DEFAULT_THRESHOLDS, async (path) =>
      path === '/data/logs' ? { total_bytes: 900 * 1024 ** 3, free_bytes: 180 * 1024 ** 3 } : { total_bytes: 237 * 1024 ** 4, free_bytes: 46 * 1024 ** 4 });
    expect(IMPLAUSIBLE_TOTAL_BYTES).toBe(64 * 1024 ** 4);
    expect(s.volumes[0]).toMatchObject({ path: '/data/evidence', state: 'unknown' });
    expect(s.volumes[0].reason).toMatch(/not the host disk/);
    expect(s.volumes[1]).toMatchObject({ path: '/data/logs', state: 'ok', reason: null });
    expect(s.state).toBe('unknown'); // unknown outranks ok (never green without a trustworthy figure)
  });
});
