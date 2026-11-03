import { z } from "zod";
import type { Logger } from "@blackbox/logging";
import { loadQuestionContracts, type QuestionContract } from "./contracts.js";
import { EngineError, type ConsistencyRequest, type EngineClient } from "./engine.js";
import type { QuestionReadiness, ReadinessService } from "./readiness.js";

/** Entity identifier parameters contributed by each dataset a question depends on. */
/**
 * Per-intent parameter contract mirrored from the engine (crates/query/src/intents.rs `param_specs`):
 * the engine rejects unknown names, so the API must advertise and validate exactly this set. A unit test
 * parses intents.rs and fails when the two drift apart. Types: str | int | decimal | bool | time | str_list.
 */
type EngineParamType = "str" | "int" | "decimal" | "bool" | "time" | "str_list";
type EngineParam = { name: string; type: EngineParamType; required: boolean };
const P = (name: string, type: EngineParamType, required = false): EngineParam => ({ name, type, required });
const NOW = P("now", "time");
const ORDER_FILTER = P("order_id", "str");
const CUSTOMER_FILTER = P("customer_id", "str");
const CURRENCY_FILTER = P("currency", "str");
export const ENGINE_PARAMS: Record<string, EngineParam[]> = {
  "inventory.available_to_sell": [P("item_id", "str", true), P("requested_quantity", "decimal"), P("location_id", "str"), NOW],
  "orders.fulfillable": [P("item_id", "str"), P("priority", "str_list"), NOW],
  "orders.reservation_variance": [ORDER_FILTER, NOW],
  "orders.inbound_delay_impact": [P("promise_id", "str"), P("include_undelayed", "bool"), NOW],
  "shipments.attention": [ORDER_FILTER, P("stale_after_seconds", "int"), NOW],
  "shipments.promise_risk": [ORDER_FILTER, P("risk_hours", "int"), NOW],
  "orders.partial_delivery_gaps": [ORDER_FILTER, NOW],
  "customer.delivery_reply": [P("order_id", "str"), CUSTOMER_FILTER, NOW],
  "invoices.outstanding": [CUSTOMER_FILTER, CURRENCY_FILTER, P("due_before", "time"), NOW],
  "orders.missing_invoice": [ORDER_FILTER, P("rule", "str"), NOW],
  "invoices.order_amount_variance": [ORDER_FILTER, P("invoice_id", "str"), NOW],
  "invoices.dispatch_evidence": [P("invoice_id", "str"), NOW],
  "orders.payment_state": [ORDER_FILTER, CUSTOMER_FILTER, NOW],
  "payments.recovered_attempts": [ORDER_FILTER, NOW],
  "invoices.payment_variance": [P("invoice_id", "str"), CUSTOMER_FILTER, NOW],
  "receivables.review_queue": [CURRENCY_FILTER, CUSTOMER_FILTER, NOW],
  "providers.money_positions": [CURRENCY_FILTER, P("account_ref", "str"), NOW],
  "payouts.gross_to_net": [P("payout_id", "str", true), NOW],
  "payouts.missing_bank_confirmation": [CURRENCY_FILTER, P("tolerance_minor", "int"), NOW],
  "providers.holds_and_releases": [CURRENCY_FILTER, P("account_ref", "str"), NOW],
  "returns.lifecycle": [ORDER_FILTER, P("return_id", "str"), NOW],
  "credits.refund_gaps": [ORDER_FILTER, NOW],
  "cancellations.outstanding_steps": [P("order_id", "str", true), NOW],
  "refunds.chargeback_overlap": [ORDER_FILTER, P("transaction_id", "str"), NOW],
};
/** Product-level narrowing of an engine parameter's type (never widening; the engine still validates). */
const API_PARAM_OVERRIDES: Record<string, Record<string, z.ZodTypeAny>> = {
  "inventory.available_to_sell": { requested_quantity: z.number().positive().max(1_000_000_000) },
};
/** Product-level requirement on top of the engine's optional parameter (the UI asks for an order). */
const API_REQUIRED_EXTRA: Record<string, string[]> = { "customer.delivery_reply": ["order_id"], "inventory.available_to_sell": ["requested_quantity"] };

function zodFor(t: EngineParamType): z.ZodTypeAny {
  switch (t) {
    case "str":
      return z.string().min(1).max(200);
    case "int":
      return z.number().int().min(-1_000_000_000).max(1_000_000_000);
    case "decimal":
      return z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000);
    case "bool":
      return z.boolean();
    case "time":
      return z.string().datetime({ offset: true });
    case "str_list":
      return z.array(z.string().min(1).max(200)).max(500);
  }
}

/**
 * Parameters the API itself consumes (consistency cutoff and paging); they are never forwarded to the engine,
 * which rejects unknown names.
 */
const API_PARAMS: Record<string, z.ZodTypeAny> = {
  as_of: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().max(2000).optional(),
};
const API_PARAM_NAMES = new Set(Object.keys(API_PARAMS));

export interface QuestionTemplate {
  id: string;
  intent: string;
  group: string;
  question: string;
  required_datasets: string[];
  optional_datasets: string[];
  params_schema: { type: "object"; properties: Record<string, { type: string; required: boolean; format?: string }>; required: string[]; additionalProperties: false };
  supported: boolean;
  query_rule: string;
}

export interface BuiltIntent {
  question: QuestionContract;
  schema: z.ZodObject<Record<string, z.ZodTypeAny>>;
  template: QuestionTemplate;
}

function describe(schema: z.ZodTypeAny): { type: string; format?: string } {
  const inner = schema instanceof z.ZodOptional ? (schema as z.ZodOptional<z.ZodTypeAny>).unwrap() : schema;
  if (inner instanceof z.ZodNumber) return { type: "number" };
  if (inner instanceof z.ZodArray) return { type: "array" };
  if (inner instanceof z.ZodBoolean) return { type: "boolean" };
  return { type: "string" };
}

/**
 * Builds one zod schema per intent from the 24 questions in specs/question-data-contracts.json:
 * entity parameters are derived from the question's required/optional datasets, common scope
 * parameters apply everywhere and a small override table adds intent-specific requirements.
 * Unknown parameters are rejected (strict) — free text never reaches the engine.
 */
export function buildIntents(): Map<string, BuiltIntent> {
  const contracts = loadQuestionContracts();
  const out = new Map<string, BuiltIntent>();
  for (const q of contracts.questions) {
    const engineParams = ENGINE_PARAMS[q.intent];
    if (!engineParams) throw new Error(`intent ${q.intent}: no engine parameter contract mirrored in ENGINE_PARAMS`);
    const shape: Record<string, z.ZodTypeAny> = { ...API_PARAMS };
    const required = [...engineParams.filter((p) => p.required).map((p) => p.name), ...(API_REQUIRED_EXTRA[q.intent] ?? [])];
    for (const p of engineParams) {
      const base = API_PARAM_OVERRIDES[q.intent]?.[p.name] ?? zodFor(p.type);
      shape[p.name] = required.includes(p.name) ? base : base.optional();
    }
    const schema = z.object(shape).strict();
    const properties: QuestionTemplate["params_schema"]["properties"] = {};
    for (const [k, v] of Object.entries(shape)) properties[k] = { ...describe(v), required: required.includes(k) };
    const group = q.id.split("-")[0] ?? "other";
    out.set(q.intent, {
      question: q,
      schema,
      template: {
        id: q.id,
        intent: q.intent,
        group,
        question: q.question,
        required_datasets: q.required_datasets,
        optional_datasets: q.optional_datasets,
        params_schema: { type: "object", properties, required, additionalProperties: false },
        supported: true,
        query_rule: q.query_rule,
      },
    });
  }
  return out;
}

export class QuestionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, status: number, message: string, details?: unknown) {
    super(message);
    this.name = "QuestionError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface QuestionAnswer {
  status: "complete" | "partial" | "insufficient_data" | "conflict" | "unsupported" | "unavailable";
  intent: string;
  question_id: string;
  params: Record<string, unknown>;
  result: unknown;
  calculation: unknown;
  evidence_refs: string[];
  entry_ids: string[];
  missing_inputs: string[];
  conflicts: unknown[];
  coverage: unknown;
  consistency: unknown;
  readiness: QuestionReadiness | null;
  page: unknown;
  error?: { code: string; message: string; retryable: boolean; retry_after_ms: number | null };
}

/** Shared question service for API and MCP: validates params, calls the engine, attaches readiness. */
export class QuestionService {
  readonly intents: Map<string, BuiltIntent>;
  constructor(
    private readonly engine: EngineClient,
    private readonly readiness: ReadinessService,
    private readonly log: Logger,
  ) {
    this.intents = buildIntents();
  }

  templates(): QuestionTemplate[] {
    return [...this.intents.values()].map((i) => i.template);
  }

  /** Literal title/entity match over the templates only (no free text leaves the process). */
  search(q: string): QuestionTemplate[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return this.templates().filter((t) => t.question.toLowerCase().includes(needle) || t.intent.includes(needle) || t.id.includes(needle));
  }

  validate(intent: string, params: unknown): { built: BuiltIntent; params: Record<string, unknown> } {
    const built = this.intents.get(intent);
    if (!built) throw new QuestionError("unsupported_intent", 422, `intent '${intent}' is not one of the 24 supported intents`);
    const parsed = built.schema.safeParse(params ?? {});
    if (!parsed.success) throw new QuestionError("invalid_params", 422, "question parameters are invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    return { built, params: parsed.data as Record<string, unknown> };
  }

  async answer(tenantId: string, intent: string, rawParams: unknown, consistency?: Partial<ConsistencyRequest>, principalKind: "owner" | "agent" = "owner", principalId?: string): Promise<QuestionAnswer> {
    const { built, params } = this.validate(intent, rawParams);
    const engineParams: Record<string, unknown> = Object.fromEntries(Object.entries(params).filter(([k]) => !API_PARAM_NAMES.has(k)));
    const cons: ConsistencyRequest = { mode: consistency?.mode ?? (params.as_of ? "as_of" : "latest_committed"), cursor: consistency?.cursor ?? null, as_of_recorded: consistency?.as_of_recorded ?? (typeof params.as_of === "string" ? params.as_of : null), as_of_effective: consistency?.as_of_effective ?? (typeof params.as_of === "string" ? params.as_of : null), deadline_ms: Math.min(5000, consistency?.deadline_ms ?? 5000) };
    const started = process.hrtime.bigint();
    try {
      const res = (await this.engine.query({ tenant_id: tenantId, intent, params: engineParams, consistency: cons, principal_id: principalId, page: { limit: typeof params.limit === "number" ? params.limit : 100, cursor: typeof params.cursor === "string" ? params.cursor : null } })) as Record<string, unknown>;
      const consistencyOut = res.consistency as { applied_cursor?: number } | undefined;
      // Readiness attached to the answer is never older than the answer's cursor (memo at/beyond it: no database work).
      const readiness = await this.readiness.forIntent(tenantId, intent, { knownCursor: typeof consistencyOut?.applied_cursor === "number" ? consistencyOut.applied_cursor : null });
      const base = { intent, question_id: built.question.id, params, readiness };
      this.log.info("query.served", "Question served", { tenant_id: tenantId, operation_id: built.question.id, duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6), applied_cursor: consistencyOut?.applied_cursor, action_code: principalKind });
      return {
        ...base,
        status: (res.status as QuestionAnswer["status"]) ?? "unknown",
        result: res.result ?? null,
        calculation: res.calculation ?? null,
        evidence_refs: (res.evidence_refs as string[]) ?? [],
        entry_ids: (res.entry_ids as string[]) ?? [],
        missing_inputs: (res.missing_inputs as string[]) ?? [],
        conflicts: (res.conflicts as unknown[]) ?? [],
        coverage: res.coverage ?? { datasets_present: readiness ? readiness.required.filter((d) => !readiness.missing.includes(d)) : [], datasets_missing: readiness?.missing ?? [] },
        consistency: res.consistency ?? null,
        page: res.page ?? null,
      };
    } catch (err) {
      if (err instanceof EngineError) {
        this.log.warn("query.unavailable", "Question could not be evaluated by the engine", { tenant_id: tenantId, operation_id: built.question.id, error_code: err.code, retryable: err.retryable, duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6) });
        if (err.code === "invalid_params" || err.code === "unsupported_intent" || err.code === "too_large") throw new QuestionError(err.code, 422, err.message);
        const readiness = await this.readiness.forIntent(tenantId, intent);
        const base = { intent, question_id: built.question.id, params, readiness };
        return {
          ...base,
          status: "unavailable",
          result: null,
          calculation: null,
          evidence_refs: [],
          entry_ids: [],
          missing_inputs: readiness?.missing ?? [],
          conflicts: [],
          coverage: { datasets_present: readiness ? readiness.required.filter((d) => !readiness.missing.includes(d)) : [], datasets_missing: readiness?.missing ?? [] },
          consistency: { status: err.code === "projection_behind" ? "projection_behind" : "unavailable", applied_cursor: null, required_cursor: null },
          page: null,
          error: { code: err.code, message: err.message, retryable: err.retryable, retry_after_ms: err.retryAfterMs },
        };
      }
      throw err;
    }
  }
}
