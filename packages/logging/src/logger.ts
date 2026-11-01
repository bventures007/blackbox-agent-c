import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { DebugGate } from "./debug.js";
import { LEVEL_RANK, LOG_SCHEMA_VERSION, type LogFields, type LogLevel, type LogRecord } from "./record.js";
import { sanitizeRecord } from "./redact.js";

export interface LogSink {
  /** Receives a fully sanitized record. Must never throw and must not block. */
  write(record: LogRecord): void;
}

export interface LoggerOptions {
  component: string;
  serviceVersion: string;
  instanceId?: string;
  /** Minimum level emitted for non-debug records (default INFO). */
  level?: LogLevel;
  /** Destination for the pino JSON stream (default process.stderr). */
  stream?: NodeJS.WritableStream;
  /** Extra sinks (file collector, SSE fan-out). */
  sinks?: LogSink[];
  debugGate?: DebugGate;
  now?: () => Date;
}

export interface Logger {
  readonly component: string;
  readonly instanceId: string;
  readonly events: EventEmitter;
  readonly debugGate: DebugGate;
  debug(eventName: string, message: string, fields?: LogFields): void;
  info(eventName: string, message: string, fields?: LogFields): void;
  warn(eventName: string, message: string, fields?: LogFields): void;
  error(eventName: string, message: string, fields?: LogFields): void;
  /** Binds fields (tenant_id, connection_id, run_id, trace_id...) for every subsequent record. */
  child(fields: LogFields, component?: string): Logger;
  addSink(sink: LogSink): void;
  /** Counter of records suppressed by the aggregation/rate limiter and sink drops. */
  stats(): { emitted: number; suppressed: number };
  flush(): Promise<void>;
}

/** Repeated identical failures (same component+event_name+error_code) are aggregated per minute. */
const REPEAT_WINDOW_MS = 60_000;
const REPEAT_LIMIT = 20;

export function createLogger(options: LoggerOptions): Logger {
  const stream = options.stream ?? process.stderr;
  const pinoLogger = pino(
    {
      level: "trace",
      base: undefined,
      timestamp: false,
      messageKey: "message",
      formatters: { level: (label) => ({ level: label.toUpperCase() }) },
    },
    stream as pino.DestinationStream,
  );
  const sinks: LogSink[] = [...(options.sinks ?? [])];
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const debugGate = options.debugGate ?? new DebugGate();
  const now = options.now ?? (() => new Date());
  const instanceId = options.instanceId ?? randomUUID();
  const minRank = LEVEL_RANK[options.level ?? "INFO"];
  const repeats = new Map<string, { windowStart: number; count: number; suppressed: number }>();
  let emitted = 0;
  let suppressed = 0;

  function build(component: string, bound: LogFields, level: LogLevel, eventName: string, message: string, fields: LogFields | undefined): LogRecord {
    const ts = now().toISOString();
    const merged: Record<string, unknown> = { ...bound, ...(fields ?? {}) };
    const candidate: Record<string, unknown> = {
      ...merged,
      schema_version: LOG_SCHEMA_VERSION,
      record_id: randomUUID(),
      occurred_at: ts,
      observed_at: ts,
      level,
      event_name: eventName,
      message,
      component,
      service_version: options.serviceVersion,
      instance_id: instanceId,
      scope: merged.tenant_id ? "workspace" : "installation",
    };
    return sanitizeRecord(candidate);
  }

  function emit(component: string, bound: LogFields, level: LogLevel, eventName: string, message: string, fields?: LogFields): void {
    if (level === "DEBUG") {
      const ctx = { connection_id: fields?.connection_id ?? bound.connection_id, run_id: fields?.run_id ?? bound.run_id };
      if (!debugGate.isEnabled(component, ctx)) return;
    } else if (LEVEL_RANK[level] < minRank) {
      return;
    }
    if (level === "WARN" || level === "ERROR") {
      const key = `${component}|${eventName}|${fields?.error_code ?? ""}`;
      const t = Date.now();
      let r = repeats.get(key);
      if (!r || t - r.windowStart > REPEAT_WINDOW_MS) {
        if (r && r.suppressed > 0) {
          // Emit one aggregated summary for the previous window.
          write(build(component, bound, level, `${eventName}.repeated`, `Repeated ${r.suppressed} identical records suppressed in the last minute`, { ...fields, record_count: r.suppressed }));
        }
        r = { windowStart: t, count: 0, suppressed: 0 };
        repeats.set(key, r);
      }
      r.count += 1;
      if (r.count > REPEAT_LIMIT) {
        r.suppressed += 1;
        suppressed += 1;
        return;
      }
    }
    write(build(component, bound, level, eventName, message, fields));
  }

  function write(record: LogRecord): void {
    emitted += 1;
    try {
      const { message, level, ...rest } = record;
      const method = level.toLowerCase() as "debug" | "info" | "warn" | "error";
      pinoLogger[method](rest, message);
    } catch {
      /* stderr failures must never break the caller */
    }
    for (const sink of sinks) {
      try {
        sink.write(record);
      } catch {
        /* sinks are best effort; collector reports its own drops */
      }
    }
    try {
      events.emit("record", record);
    } catch {
      /* listeners must not break emission */
    }
  }

  function make(component: string, bound: LogFields): Logger {
    return {
      component,
      instanceId,
      events,
      debugGate,
      debug: (e, m, f) => emit(component, bound, "DEBUG", e, m, f),
      info: (e, m, f) => emit(component, bound, "INFO", e, m, f),
      warn: (e, m, f) => emit(component, bound, "WARN", e, m, f),
      error: (e, m, f) => emit(component, bound, "ERROR", e, m, f),
      child: (fields, childComponent) => make(childComponent ?? component, { ...bound, ...fields }),
      addSink: (sink) => {
        sinks.push(sink);
      },
      stats: () => ({ emitted, suppressed }),
      flush: () =>
        new Promise<void>((resolve) => {
          pinoLogger.flush(() => resolve());
        }),
    };
  }

  return make(options.component, {});
}

/** A no-op logger for tests and tools that must stay silent (MCP stdout protection). */
export function createSilentLogger(component = "silent"): Logger {
  const sink: NodeJS.WritableStream = { write: () => true } as unknown as NodeJS.WritableStream;
  return createLogger({ component, serviceVersion: "0.0.0", stream: sink, level: "ERROR" });
}
