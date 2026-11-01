import type { Pool } from "@blackbox/database";
import type { AuthService, DataKey, OwnerSession, AgentContext } from "@blackbox/auth";
import type { Logger, FileCollector, DebugGate } from "@blackbox/logging";
import type { BankCsvService, ConnectionService, DemoService, EngineClient, EvidenceStore, ImportPlanService, IngestionService, JournalService, QuestionService, ReadinessService, ReviewService, SignedInputService } from "@blackbox/application";
import type { ApiConfig } from "./config.js";

export interface AppContext {
  config: ApiConfig;
  pool: Pool;
  logger: Logger;
  collector: FileCollector;
  debugGate: DebugGate;
  auth: AuthService;
  dataKey: DataKey | null;
  dataKeyError: { code: string; message: string; action: string } | null;
  evidence: EvidenceStore;
  ingestion: IngestionService | null;
  journal: JournalService;
  readiness: ReadinessService;
  importPlans: ImportPlanService;
  engine: EngineClient;
  questions: QuestionService;
  bankCsv: BankCsvService;
  signed: SignedInputService | null;
  review: ReviewService;
  connections: ConnectionService | null;
  demo: DemoService | null;
  startedAt: Date;
  runtime: { mcpLastRequestAt: string | null; lastDbProbe: { at: string; ok: boolean; error?: string } | null };
}

export type RequestAuth = { kind: "owner"; session: OwnerSession; sessionId: string } | { kind: "agent"; agent: AgentContext };

declare module "fastify" {
  interface FastifyRequest {
    auth: RequestAuth | null;
    rawBody: string;
    traceId: string;
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;
  constructor(status: number, code: string, message: string, options: { retryable?: boolean; details?: unknown; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const notFound = (what = "resource"): HttpError => new HttpError(404, "not_found", `${what} not found`);
export const unauthenticated = (): HttpError => new HttpError(401, "unauthenticated", "authentication required");
export const forbidden = (message = "forbidden"): HttpError => new HttpError(403, "forbidden", message);
export const validation = (message: string, details?: unknown): HttpError => new HttpError(422, "validation", message, { details });
