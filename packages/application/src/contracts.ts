import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads the binding JSON contracts from the repository (packages/contracts, specs, GOLDEN).
 * The repo root is located by walking up from this file until packages/contracts/events.json
 * exists, or from BLACKBOX_REPO_ROOT when set (Compose images copy the contract files).
 */
export function repoRoot(): string {
  if (process.env.BLACKBOX_REPO_ROOT && existsSync(path.join(process.env.BLACKBOX_REPO_ROOT, "packages/contracts/events.json"))) {
    return process.env.BLACKBOX_REPO_ROOT;
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "packages/contracts/events.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("repository root with packages/contracts/events.json not found; set BLACKBOX_REPO_ROOT");
}

export type Track = "source" | "fact" | "commitment" | "movement" | "reservation";
export const TRACKS: readonly Track[] = ["source", "fact", "commitment", "movement", "reservation"];

export interface EventFamily {
  dataset: string;
  tracks: Track[];
  golden_example: { example_payload: Record<string, unknown>; connection: string } | null;
}

export interface EventsContract {
  schema_version: number;
  families: Record<string, EventFamily>;
  internal: Record<string, { tracks: Track[]; rule: string }>;
}

export interface QuestionContract {
  id: string;
  question: string;
  intent: string;
  required_datasets: string[];
  optional_datasets: string[];
  projection_ids: string[];
  query_rule: string;
  access_path: string;
  mcp_contract: { tool: string; intent: string; shared_with: string; evidence_tools: string[] };
  test_contract: { sufficient: { given: Record<string, unknown>; expected: Record<string, unknown> }; missing: { given: Record<string, unknown>; expected: Record<string, unknown> }; additional_cases: string[]; common_suite: string[] };
}

export interface DatasetContract {
  id: string;
  required_fields: string[];
  provider_candidates: string[];
  journal_event_families: string[];
  projection_ids: string[];
  journal_tracks: Track[];
}

export interface QuestionDataContracts {
  schema_version: string;
  common_result_envelope: string[];
  providers: Array<{ id: string; name: string; release_scope: string; ingestion?: string }>;
  datasets: DatasetContract[];
  questions: QuestionContract[];
}

export interface GoldenEvent {
  id: string;
  connection: string;
  provider_event_id: string;
  occurred_at: string;
  entity: Record<string, string>;
  kind: string;
  payload: Record<string, unknown>;
  evidence_refs: string[];
}

export interface GoldenFixture {
  version: string;
  synthetic: boolean;
  currency: string;
  test_clock: string;
  events: GoldenEvent[];
  checkpoints: Array<{ after: string; expected: Record<string, number | string> }>;
}

let eventsCache: EventsContract | null = null;
let questionsCache: QuestionDataContracts | null = null;
let goldenCache: GoldenFixture | null = null;

export function loadEventsContract(): EventsContract {
  if (!eventsCache) eventsCache = JSON.parse(readFileSync(path.join(repoRoot(), "packages/contracts/events.json"), "utf8")) as EventsContract;
  return eventsCache;
}

export function loadQuestionContracts(): QuestionDataContracts {
  if (!questionsCache) questionsCache = JSON.parse(readFileSync(path.join(repoRoot(), "specs/question-data-contracts.json"), "utf8")) as QuestionDataContracts;
  return questionsCache;
}

export function loadGoldenFixture(): GoldenFixture {
  if (!goldenCache) goldenCache = JSON.parse(readFileSync(path.join(repoRoot(), "GOLDEN-ORDER-TO-CASH.json"), "utf8")) as GoldenFixture;
  return goldenCache;
}

export function loadEngineRpcContract(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot(), "packages/contracts/engine-rpc.json"), "utf8")) as Record<string, unknown>;
}

/** Maps every known family to its dataset (events.json) — used by readiness. */
export function familyDataset(kind: string): string | null {
  return loadEventsContract().families[kind]?.dataset ?? null;
}
