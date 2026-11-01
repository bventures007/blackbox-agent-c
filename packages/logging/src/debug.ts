/**
 * In-memory mirror of the `debug_sessions` table. The logger consults it on every DEBUG emit;
 * expiry is enforced here (server side), never by a browser timer. `reset()` runs at process start
 * so a restart always returns to INFO (DIAG-05).
 */
export interface DebugSession {
  debug_id: string;
  tenant_id: string;
  component: string;
  connection_id?: string | null;
  run_id?: string | null;
  expires_at: string; // RFC3339
}

export const DEBUG_MAX_MINUTES = 15;

export class DebugGate {
  private sessions = new Map<string, DebugSession>();
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  reset(): void {
    this.sessions.clear();
  }

  set(session: DebugSession): void {
    this.sessions.set(session.debug_id, session);
  }

  remove(debugId: string): void {
    this.sessions.delete(debugId);
  }

  /** Returns active (unexpired) sessions and prunes expired ones. */
  active(): DebugSession[] {
    const now = this.now();
    const out: DebugSession[] = [];
    for (const [id, s] of this.sessions) {
      if (Date.parse(s.expires_at) <= now) this.sessions.delete(id);
      else out.push(s);
    }
    return out;
  }

  /** DEBUG is emitted only while an unexpired session matches component and (if set) connection/run. */
  isEnabled(component: string, context: { connection_id?: string | null; run_id?: string | null } = {}): boolean {
    for (const s of this.active()) {
      if (s.component !== component && s.component !== "*") continue;
      if (s.connection_id && s.connection_id !== context.connection_id) continue;
      if (s.run_id && s.run_id !== context.run_id) continue;
      return true;
    }
    return false;
  }
}
