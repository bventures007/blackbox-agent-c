/**
 * Wall-clock versus monotonic time. Timers that fired before a suspension are not trusted: the
 * scheduler compares the wall-clock delta with the monotonic delta on every tick.
 */
export interface Clock {
  now(): Date;
  monotonicMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
};

/** Test clock: advance wall and monotonic time independently to simulate sleep/wake or clock changes. */
export class FakeClock implements Clock {
  constructor(private wall: number, private mono = 0) {}
  now(): Date { return new Date(this.wall); }
  monotonicMs(): number { return this.mono; }
  /** Normal passage of time: both advance. */
  tick(ms: number): void { this.wall += ms; this.mono += ms; }
  /** Suspension: wall clock advances, monotonic clock does not. */
  suspend(ms: number): void { this.wall += ms; }
  /** Manual clock change: wall only (can be negative). */
  setWall(ms: number): void { this.wall = ms; }
}

export interface SuspensionDetector { observe(clock: Clock): { suspended: boolean; gap_ms: number; wall_now: Date } }

export function suspensionDetector(threshold_ms: number): SuspensionDetector {
  let lastWall: number | null = null; let lastMono: number | null = null;
  return {
    observe(clock) {
      const wall = clock.now().getTime(); const mono = clock.monotonicMs();
      let gap = 0;
      if (lastWall !== null && lastMono !== null) gap = (wall - lastWall) - (mono - lastMono);
      lastWall = wall; lastMono = mono;
      return { suspended: Math.abs(gap) >= threshold_ms, gap_ms: gap, wall_now: new Date(wall) };
    },
  };
}
