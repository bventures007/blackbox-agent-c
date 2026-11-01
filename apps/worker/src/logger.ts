/**
 * Worker logging through the shared `@blackbox/logging` contract (packages/contracts/log-record.json):
 * allowlisted keys, redaction, 512-char clipping, 16 KiB cap, JSON on stderr and — when a logs
 * directory is configured — `records-YYYYMMDD-HH-worker.jsonl` in the common logs directory so
 * `./blackbox logs --run <id>` correlates worker, api and engine records (ADR-0006). The api
 * collector owns index.json; the worker writer leaves it untouched.
 */
import { createLogger as createSharedLogger, FileCollector, type LogFields, type Logger as SharedLogger } from '@blackbox/logging';
import type pino from 'pino';

export interface LogContext {
  tenant_id?: string | null; connection_id?: string | null; capability_id?: string | null; run_id?: string | null;
  operation_id?: string | null; attempt?: number | null; trace_id?: string | null; span_id?: string | null;
  duration_ms?: number | null; record_count?: number | null; error_code?: string | null; retryable?: boolean | null;
  next_retry_at?: string | null; action_code?: string | null; journal_batch_id?: string | null; committed_cursor?: number | null; applied_cursor?: number | null;
}

export interface Logger {
  log(level: 'debug' | 'info' | 'warn' | 'error', event_name: string, message: string, ctx?: LogContext): void;
  child(ctx: LogContext): Logger;
  level: string;
  /** Flushes buffered file records (shutdown). */
  close(): void;
}

const LEVEL_MAP = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' } as const;

function clean(ctx: LogContext): LogFields {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) if (v !== undefined && v !== null) out[k] = v;
  return out as LogFields;
}

export function createLogger(opts: { component: string; service_version: string; instance_id: string; level?: string; destination?: pino.DestinationStream; logs_dir?: string | null }): Logger {
  const level = (opts.level ?? 'info').toUpperCase();
  const minLevel = (['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(level) ? level : 'INFO') as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  const collector = opts.logs_dir ? new FileCollector({ dir: opts.logs_dir, suffix: 'worker', maintainIndex: false }) : null;
  const shared = createSharedLogger({ component: opts.component, serviceVersion: opts.service_version, instanceId: opts.instance_id, level: minLevel, stream: opts.destination as unknown as NodeJS.WritableStream | undefined, sinks: collector ? [collector] : [] });
  let current = minLevel as string;
  const make = (base: SharedLogger): Logger => ({
    get level() { return current; },
    set level(v: string) { current = v; },
    log(lvl, event_name, message, ctx = {}) {
      const fields = clean(ctx);
      if (lvl === 'debug') base.debug(event_name, message, fields);
      else if (lvl === 'info') base.info(event_name, message, fields);
      else if (lvl === 'warn') base.warn(event_name, message, fields);
      else base.error(event_name, message, fields);
    },
    child(ctx) { return make(base.child(clean(ctx))); },
    close() { collector?.close(); },
  });
  return make(shared);
}
