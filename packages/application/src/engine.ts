import { readFileSync } from "node:fs";
import type { Logger } from "@blackbox/logging";
import { loadEngineRpcContract, loadEventsContract, loadQuestionContracts } from "./contracts.js";
import type { JournalEntry, JournalService } from "./journal.js";
import { listMappings } from "./mapping/index.js";

/** Typed mirror of packages/contracts/engine-rpc.json. */
export type ConsistencyMode = "latest_committed" | "at_least_cursor" | "as_of" | "stale_explicit";

export interface ConsistencyRequest {
  mode: ConsistencyMode;
  cursor?: number | null;
  as_of_recorded?: string | null;
  as_of_effective?: string | null;
  deadline_ms?: number;
}

export interface ConsistencyResponse {
  applied_cursor: number;
  required_cursor: number | null;
  reducer_version: number;
  status: "current" | "projection_behind" | "historical" | "stale";
  recorded_cutoff: string;
  effective_cutoff: string | null;
}

export interface EnginePage {
  limit?: number;
  cursor?: string | null;
}

export interface EngineStateRequest {
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  consistency: ConsistencyRequest;
}

export interface EngineQueryRequest {
  tenant_id: string;
  intent: string;
  params: Record<string, unknown>;
  consistency: ConsistencyRequest;
  page?: EnginePage;
}

export interface EngineHistoryRequest {
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  page?: EnginePage;
  consistency: ConsistencyRequest;
}

export interface EngineSummaryRequest {
  tenant_id: string;
  kind: "thirty_day_summary";
  from: string;
  to: string;
  currency: string;
  consistency: ConsistencyRequest;
}

export interface EngineHealth {
  status: "healthy" | "catching_up" | "rebuilding" | "degraded" | "unavailable";
  reducer_version: number;
  tenants: Record<string, { applied_cursor: number; committed_cursor: number; lag_entries: number; phase: string }>;
  rss_bytes?: number;
  uptime_seconds?: number;
  heartbeat_at?: string;
  /** Set by the test stub only. */
  stub?: true;
}

export class EngineError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(code: string, status: number, message: string, retryable = false, retryAfterMs: number | null = null) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface EngineClient {
  readonly kind: "http" | "stub";
  health(): Promise<EngineHealth>;
  state(req: EngineStateRequest): Promise<Record<string, unknown>>;
  query(req: EngineQueryRequest): Promise<Record<string, unknown>>;
  history(req: EngineHistoryRequest): Promise<{ entries: JournalEntry[]; page: { next_cursor: string | null; truncated: boolean }; consistency: ConsistencyResponse }>;
  summary(req: EngineSummaryRequest): Promise<Record<string, unknown>>;
  schema(): Promise<Record<string, unknown>>;
}

const STATUS_BY_CODE: Record<string, number> = {
  unauthorized: 503, // an engine auth failure is an installation fault, not the caller's
  tenant_unknown: 404,
  projection_behind: 503,
  deadline_exceeded: 503,
  unsupported_intent: 422,
  invalid_params: 422,
  too_large: 422,
  overloaded: 503,
};

/** HTTP client for the Rust engine (private Compose network), authenticated by X-Engine-Token. */
export class HttpEngineClient implements EngineClient {
  readonly kind = "http" as const;
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly log: Logger,
    private readonly timeoutMs = 6000,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = process.hrtime.bigint();
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-engine-token": this.token },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new EngineError("overloaded", 503, "engine returned a non-JSON response", true);
      }
      if (!res.ok) {
        const err = (json as { error?: { code?: string; message?: string; retryable?: boolean; retry_after_ms?: number | null } })?.error ?? {};
        const code = err.code ?? "overloaded";
        throw new EngineError(code, STATUS_BY_CODE[code] ?? 503, err.message ?? `engine responded ${res.status}`, Boolean(err.retryable), err.retry_after_ms ?? null);
      }
      return json as T;
    } catch (err) {
      if (err instanceof EngineError) throw err;
      const aborted = (err as Error).name === "AbortError";
      this.log.warn("engine.call_failed", aborted ? "Engine call exceeded the deadline" : "Engine unreachable", { error_code: aborted ? "deadline_exceeded" : "engine_unavailable", retryable: true, duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6) });
      throw new EngineError(aborted ? "deadline_exceeded" : "overloaded", 503, aborted ? "engine deadline exceeded" : "query engine unavailable", true);
    } finally {
      clearTimeout(timer);
    }
  }

  health(): Promise<EngineHealth> {
    return this.call<EngineHealth>("GET", "/health");
  }
  state(req: EngineStateRequest): Promise<Record<string, unknown>> {
    return this.call("POST", "/v1/state", req);
  }
  query(req: EngineQueryRequest): Promise<Record<string, unknown>> {
    return this.call("POST", "/v1/query", req);
  }
  history(req: EngineHistoryRequest): Promise<{ entries: JournalEntry[]; page: { next_cursor: string | null; truncated: boolean }; consistency: ConsistencyResponse }> {
    return this.call("POST", "/v1/history", req);
  }
  summary(req: EngineSummaryRequest): Promise<Record<string, unknown>> {
    return this.call("POST", "/v1/summary", req);
  }
  schema(): Promise<Record<string, unknown>> {
    return this.call("GET", "/v1/schema");
  }
}

/**
 * TEST STUB — selected with ENGINE_URL=stub. It is NOT a reducer and computes no financial or
 * stock state: state/query/summary answer `projection_behind` (503) so the API's authorization,
 * scoping, validation and envelope code can be exercised without the Rust engine. `history`
 * replays committed journal entries for the entity; `schema` is built from the contracts.
 */
export class StubEngineClient implements EngineClient {
  readonly kind = "stub" as const;
  constructor(private readonly journal: JournalService) {}

  async health(): Promise<EngineHealth> {
    return { status: "unavailable", reducer_version: 0, tenants: {}, heartbeat_at: new Date().toISOString(), stub: true };
  }

  async state(req: EngineStateRequest): Promise<Record<string, unknown>> {
    const stats = await this.journal.stats(req.tenant_id);
    throw new EngineError("projection_behind", 503, `engine stub: no reducer available (committed_cursor=${stats.committed_cursor}, applied_cursor=0); start the Rust engine for state answers`, true, 1000);
  }

  async query(req: EngineQueryRequest): Promise<Record<string, unknown>> {
    const stats = await this.journal.stats(req.tenant_id);
    throw new EngineError("projection_behind", 503, `engine stub: intent ${req.intent} cannot be evaluated without the Rust engine (committed_cursor=${stats.committed_cursor}, applied_cursor=0)`, true, 1000);
  }

  async history(req: EngineHistoryRequest): Promise<{ entries: JournalEntry[]; page: { next_cursor: string | null; truncated: boolean }; consistency: ConsistencyResponse }> {
    const page = await this.journal.entityHistory(req.tenant_id, req.entity_type, req.entity_id, { cursor: req.page?.cursor ?? null, limit: req.page?.limit ?? 100 });
    return {
      entries: page.entries,
      page: { next_cursor: page.page.next_cursor, truncated: page.page.truncated },
      consistency: { applied_cursor: 0, required_cursor: page.consistency.committed_cursor, reducer_version: 0, status: "projection_behind", recorded_cutoff: new Date().toISOString(), effective_cutoff: null },
    };
  }

  async summary(req: EngineSummaryRequest): Promise<Record<string, unknown>> {
    throw new EngineError("projection_behind", 503, `engine stub: summary ${req.kind} unavailable without the Rust engine`, true, 1000);
  }

  async schema(): Promise<Record<string, unknown>> {
    return buildSchemaFromContracts();
  }
}

/** describe_business_schema payload built from the contracts (used by the stub and as API fallback). */
export function buildSchemaFromContracts(): Record<string, unknown> {
  const events = loadEventsContract();
  const q = loadQuestionContracts();
  const rpc = loadEngineRpcContract();
  return {
    schema_version: 1,
    tracks: ["source", "fact", "commitment", "movement", "reservation"],
    record_types: ["order", "line", "customer", "item", "invoice", "shipment", "transaction", "refund", "payout", "return", "reservation", "bank_entry", "credit", "hold", "dispute", "supply", "promise", "rule", "case"],
    event_families: Object.entries(events.families).map(([kind, f]) => ({ kind, dataset: f.dataset, declared_tracks: f.tracks })),
    mappings: listMappings(),
    internal_events: events.internal,
    datasets: q.datasets.map((d) => ({ id: d.id, required_fields: d.required_fields, journal_event_families: d.journal_event_families, journal_tracks: d.journal_tracks })),
    intents: q.questions.map((x) => ({ id: x.id, intent: x.intent, required_datasets: x.required_datasets, optional_datasets: x.optional_datasets })),
    filterable_fields: ["track", "event_type", "record_id", "entity (type:id)", "occurred_from/occurred_to (effective time)", "recorded_from/recorded_to (recorded time)", "connection_id"],
    units: { money: "integer minor units with ISO 4217 currency", quantity: "decimal string with explicit unit (default piece)" },
    time_semantics: { occurred_at: "effective business time supplied by the source", recorded_at: "server-assigned durable recording time (never backdated)", source_time: "optional provider revision time", cutoffs: "answers report effective and recorded cutoffs plus applied/committed cursors" },
    consistency_modes: (rpc as { consistency?: { modes?: string[] } }).consistency?.modes ?? [],
    limits: (rpc as { limits?: unknown }).limits ?? {},
  };
}

export function createEngineClient(options: { url: string | undefined; token?: string; tokenFile?: string; logger: Logger; journal: JournalService }): EngineClient {
  const url = options.url ?? "http://engine:7070";
  if (url === "stub") return new StubEngineClient(options.journal);
  let token = options.token ?? "";
  if (!token && options.tokenFile) token = readFileSync(options.tokenFile, "utf8").trim();
  if (!token) throw new Error("ENGINE_TOKEN (or ENGINE_TOKEN_FILE) is required when ENGINE_URL is not 'stub'");
  return new HttpEngineClient(url.replace(/\/$/, ""), token, options.logger.child({}, "engine-client"));
}
