import { z } from "zod";
import type { Logger } from "@blackbox/logging";
import { loadQuestionContracts, type QuestionContract } from "./contracts.js";
import { EngineError, type ConsistencyRequest, type EngineClient } from "./engine.js";
import type { QuestionReadiness, ReadinessService } from "./readiness.js";

/** Entity identifier parameters contributed by each dataset a question depends on. */
const DATASET_PARAMS: Record<string, string[]> = {
  orders: ["order_id", "customer_id"],
  stock: ["item_id", "location_id"],
  allocations: ["reservation_id", "order_id", "item_id"],
  supply: ["supply_id", "item_id"],
  promises: ["promise_id", "order_id"],
  fulfillments: ["shipment_id", "order_id"],
  tracking: ["shipment_id"],
  communications: ["order_id", "customer_id"],
  invoices: ["invoice_id", "order_id", "customer_id"],
  invoice_dispatch: ["invoice_id"],
  payments: ["transaction_id", "order_id"],
  payment_allocations: ["transaction_id", "invoice_id"],
  policy: [],
  cases: ["case_id"],
  provider_ledger: ["transaction_id", "payout_id"],
  positions: ["account_ref"],
  payouts: ["payout_id"],
  bank: ["bank_entry_id", "payout_id"],
  holds: ["hold_id"],
  returns: ["return_id", "order_id"],
  receipts: ["return_id"],
  entitlements: ["entitlement_id", "order_id"],
  refunds: ["refund_id", "transaction_id", "order_id"],
  disputes: ["dispute_id", "transaction_id"],
  coverage: [],
  identity: [],
};

/** Intent-specific additions/requirements (kept small and declarative). */
const INTENT_OVERRIDES: Record<string, { required?: string[]; extra?: Record<string, z.ZodTypeAny> }> = {
  "inventory.available_to_sell": { required: ["item_id", "requested_quantity"], extra: { requested_quantity: z.number().positive().max(1_000_000_000) } },
  "orders.fulfillable": { extra: { priority: z.array(z.string().max(200)).max(500).optional() } },
  "orders.inbound_delay_impact": { extra: { supply_id: z.string().max(200).optional() } },
  "shipments.promise_risk": { extra: { now: z.string().datetime({ offset: true }).optional() } },
  "shipments.attention": { extra: { now: z.string().datetime({ offset: true }).optional() } },
  "receivables.review_queue": { extra: { today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() } },
  "payouts.gross_to_net": { required: ["payout_id"] },
  "payouts.missing_bank_confirmation": { extra: { bank_import_complete_through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() } },
  "providers.holds_and_releases": {},
  "customer.delivery_reply": { required: ["order_id"] },
};

const COMMON_PARAMS: Record<string, z.ZodTypeAny> = {
  as_of: z.string().datetime({ offset: true }).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  unit: z.string().min(1).max(32).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().max(2000).optional(),
};

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
    const override = INTENT_OVERRIDES[q.intent] ?? {};
    const shape: Record<string, z.ZodTypeAny> = { ...COMMON_PARAMS };
    const entityParams = new Set<string>();
    for (const ds of [...q.required_datasets, ...q.optional_datasets]) for (const p of DATASET_PARAMS[ds] ?? []) entityParams.add(p);
    for (const p of entityParams) shape[p] = z.string().min(1).max(200).optional();
    for (const [k, v] of Object.entries(override.extra ?? {})) shape[k] = v;
    const required = override.required ?? [];
    for (const r of required) {
      const existing = shape[r];
      if (!existing) throw new Error(`intent ${q.intent}: required param ${r} has no schema`);
      shape[r] = existing instanceof z.ZodOptional ? (existing as z.ZodOptional<z.ZodTypeAny>).unwrap() : existing;
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

  async answer(tenantId: string, intent: string, rawParams: unknown, consistency?: Partial<ConsistencyRequest>, principalKind: "owner" | "agent" = "owner"): Promise<QuestionAnswer> {
    const { built, params } = this.validate(intent, rawParams);
    const cons: ConsistencyRequest = { mode: consistency?.mode ?? (params.as_of ? "as_of" : "latest_committed"), cursor: consistency?.cursor ?? null, as_of_recorded: consistency?.as_of_recorded ?? null, as_of_effective: consistency?.as_of_effective ?? (typeof params.as_of === "string" ? params.as_of : null), deadline_ms: Math.min(5000, consistency?.deadline_ms ?? 5000) };
    const readiness = await this.readiness.forIntent(tenantId, intent);
    const started = process.hrtime.bigint();
    const base = { intent, question_id: built.question.id, params, readiness };
    try {
      const res = (await this.engine.query({ tenant_id: tenantId, intent, params, consistency: cons, page: { limit: typeof params.limit === "number" ? params.limit : 100, cursor: typeof params.cursor === "string" ? params.cursor : null } })) as Record<string, unknown>;
      const consistencyOut = res.consistency as { applied_cursor?: number } | undefined;
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
