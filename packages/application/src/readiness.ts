import type { Pool, TenantClient } from "@blackbox/database";
import { withTenant } from "@blackbox/database";
import { loadEventsContract, loadQuestionContracts } from "./contracts.js";
import { JournalService } from "./journal.js";

export type ReadinessStatus = "ready" | "partial" | "blocked";

export interface SourceReadiness {
  connection_id: string;
  provider: string;
  capability_id: string;
  status: string;
  last_successful_check_at: string | null;
  last_new_event_at: string | null;
  next_check_at: string | null;
  next_check_reason: string | null;
  coverage_from: string | null;
  coverage_to: string | null;
  coverage_state: string;
  history_kind: string;
  limitations: string[];
}

export interface QuestionReadiness {
  question_id: string;
  intent: string;
  status: ReadinessStatus;
  required: string[];
  optional: string[];
  missing: string[];
  missing_optional: string[];
  reasons: string[];
  sources: SourceReadiness[];
}

export interface WorkspaceReadiness {
  datasets_present: string[];
  datasets_missing: string[];
  dataset_sources: Record<string, SourceReadiness[]>;
  questions: QuestionReadiness[];
  observed_at: string;
}

/** Internal datasets that are satisfied by derived state rather than by a producer family. */
const INTERNAL_DATASETS = new Set(["coverage", "identity"]);

/**
 * Per-question readiness derived from datasets actually present (events.json families ↔
 * question-data-contracts datasets) and capability_health rows — never from the number of green
 * source cards. Rules (documented in docs/architecture.md):
 * - a dataset is present when at least one source entry of one of its families is committed;
 * - `identity` is present when committed entries carry entity links;
 * - `coverage` is present when at least one capability_health row reports a successful check;
 * - ready: all required present; partial: some required present; blocked: none present.
 */
export class ReadinessService {
  private readonly journal: JournalService;
  constructor(private readonly pool: Pool) {
    this.journal = new JournalService(pool);
  }

  async compute(tenantId: string): Promise<WorkspaceReadiness> {
    return withTenant(this.pool, tenantId, (c) => this.computeIn(c, tenantId));
  }

  async computeIn(c: TenantClient, tenantId: string): Promise<WorkspaceReadiness> {
    const events = loadEventsContract();
    const contracts = loadQuestionContracts();
    const present = await this.journal.presentEventTypes(c);
    const datasetsPresent = new Set<string>();
    for (const p of present) {
      const ds = events.families[p.event_type]?.dataset;
      if (ds) datasetsPresent.add(ds);
    }
    const links = await c.query("SELECT 1 FROM journal_entries WHERE entity_refs <> '{}'::jsonb LIMIT 1");
    if ((links.rowCount ?? 0) > 0) datasetsPresent.add("identity");
    const health = await c.query<{
      connection_id: string;
      provider: string;
      capability_id: string;
      status: string;
      last_successful_check_at: Date | null;
      last_new_event_at: Date | null;
      next_check_at: Date | null;
      next_check_reason: string | null;
      coverage_from: Date | null;
      coverage_to: Date | null;
      coverage_state: string;
      history_kind: string;
      limitations: string[];
    }>(
      `SELECT h.connection_id, cn.provider, h.capability_id, h.status, h.last_successful_check_at, h.last_new_event_at, h.next_check_at, h.next_check_reason,
              h.coverage_from, h.coverage_to, h.coverage_state, h.history_kind, h.limitations
         FROM capability_health h JOIN connections cn ON cn.connection_id = h.connection_id
        WHERE h.tenant_id = $1 AND cn.status <> 'disconnected'`,
      [tenantId],
    );
    const sources: SourceReadiness[] = health.rows.map((h) => ({
      connection_id: h.connection_id,
      provider: h.provider,
      capability_id: h.capability_id,
      status: h.status,
      last_successful_check_at: h.last_successful_check_at?.toISOString() ?? null,
      last_new_event_at: h.last_new_event_at?.toISOString() ?? null,
      next_check_at: h.next_check_at?.toISOString() ?? null,
      next_check_reason: h.next_check_reason,
      coverage_from: h.coverage_from?.toISOString() ?? null,
      coverage_to: h.coverage_to?.toISOString() ?? null,
      coverage_state: h.coverage_state,
      history_kind: h.history_kind,
      limitations: Array.isArray(h.limitations) ? h.limitations : [],
    }));
    if (sources.some((s) => s.last_successful_check_at)) datasetsPresent.add("coverage");
    const datasetSources: Record<string, SourceReadiness[]> = {};
    for (const s of sources) (datasetSources[s.capability_id] ??= []).push(s);
    const allDatasets = contracts.datasets.map((d) => d.id);
    const questions: QuestionReadiness[] = contracts.questions.map((q) => {
      const missing = q.required_datasets.filter((d) => !datasetsPresent.has(d));
      const presentRequired = q.required_datasets.filter((d) => datasetsPresent.has(d) && !INTERNAL_DATASETS.has(d));
      const missingOptional = q.optional_datasets.filter((d) => !datasetsPresent.has(d));
      const status: ReadinessStatus = missing.length === 0 ? "ready" : presentRequired.length > 0 ? "partial" : "blocked";
      const reasons: string[] = [];
      if (missing.length > 0) reasons.push(`missing required datasets: ${missing.join(", ")}`);
      if (missingOptional.length > 0) reasons.push(`optional datasets absent (answer may be partial): ${missingOptional.join(", ")}`);
      const qSources = [...new Set([...q.required_datasets, ...q.optional_datasets])].flatMap((d) => datasetSources[d] ?? []);
      for (const s of qSources) {
        if (s.status === "degraded" || s.status === "unavailable") reasons.push(`source ${s.provider}/${s.capability_id} is ${s.status}`);
        if (s.coverage_state === "partial" || s.coverage_state === "unavailable") reasons.push(`coverage for ${s.capability_id} is ${s.coverage_state}`);
      }
      return { question_id: q.id, intent: q.intent, status, required: q.required_datasets, optional: q.optional_datasets, missing, missing_optional: missingOptional, reasons, sources: qSources };
    });
    return {
      datasets_present: allDatasets.filter((d) => datasetsPresent.has(d)),
      datasets_missing: allDatasets.filter((d) => !datasetsPresent.has(d)),
      dataset_sources: datasetSources,
      questions,
      observed_at: new Date().toISOString(),
    };
  }

  async forIntent(tenantId: string, intent: string): Promise<QuestionReadiness | null> {
    const all = await this.compute(tenantId);
    return all.questions.find((q) => q.intent === intent) ?? null;
  }
}
