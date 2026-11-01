/**
 * Structured logs per packages/contracts/log-record.json (schema_version 1): allowlisted keys only,
 * strings clipped to 512 chars, control characters escaped, records capped at 16 KiB, JSON to stderr.
 * packages/logging will replace this once it is built; the record shape is identical.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

const require = createRequire(import.meta.url);
const contract = require('../../../packages/contracts/log-record.json') as { required: string[]; optional: string[]; limits: { max_string: number; max_record_bytes: number } };
const ALLOW = new Set([...contract.required, ...contract.optional]);
const LEVELS: Record<string, string> = { trace: 'DEBUG', debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR', fatal: 'ERROR' };

export interface LogContext {
  tenant_id?: string | null; connection_id?: string | null; capability_id?: string | null; run_id?: string | null;
  operation_id?: string | null; attempt?: number | null; trace_id?: string | null; span_id?: string | null;
  duration_ms?: number | null; record_count?: number | null; error_code?: string | null; retryable?: boolean | null;
  next_retry_at?: string | null; action_code?: string | null; journal_batch_id?: string | null; committed_cursor?: number | null; applied_cursor?: number | null;
}

function clip(value: unknown): unknown {
  if (typeof value === 'string') {
    const escaped = value.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return escaped.length > contract.limits.max_string ? escaped.slice(0, contract.limits.max_string) : escaped;
  }
  return value;
}

export interface Logger {
  log(level: 'debug' | 'info' | 'warn' | 'error', event_name: string, message: string, ctx?: LogContext): void;
  child(ctx: LogContext): Logger;
  level: string;
}

export function createLogger(opts: { component: string; service_version: string; instance_id: string; level?: string; destination?: pino.DestinationStream }): Logger {
  // pino owns the envelope's level key (mapped to the contract's DEBUG/INFO/WARN/ERROR); everything else is the record.
  const base = pino({ level: opts.level ?? 'info', base: null, timestamp: false, messageKey: 'message',
    formatters: { level: (label) => ({ level: LEVELS[label] ?? 'INFO' }), log: (obj) => obj } }, opts.destination ?? pino.destination(2));
  const make = (bound: LogContext): Logger => ({
    get level() { return base.level; },
    set level(v: string) { base.level = v; },
    log(level, event_name, message, ctx = {}) {
      const record: Record<string, unknown> = {
        schema_version: 1, record_id: randomUUID(), occurred_at: new Date().toISOString(), observed_at: new Date().toISOString(),
        event_name, message: clip(message), component: opts.component, service_version: opts.service_version, instance_id: opts.instance_id,
        scope: (ctx.tenant_id ?? bound.tenant_id) ? 'workspace' : 'installation',
      };
      for (const [k, v] of Object.entries({ ...bound, ...ctx })) if (ALLOW.has(k) && v !== undefined && v !== null) record[k] = clip(v);
      let truncated = false;
      let text = JSON.stringify(record);
      if (Buffer.byteLength(text) > contract.limits.max_record_bytes) { truncated = true; record.message = String(record.message).slice(0, 200); record.truncated = true; text = JSON.stringify(record); }
      if (truncated) record.truncated = true;
      base[level](record);
    },
    child(ctx) { return make({ ...bound, ...ctx }); },
  });
  return make({});
}
