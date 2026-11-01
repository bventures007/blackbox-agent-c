import type { Pool } from "@blackbox/database";
import { withTenant } from "@blackbox/database";
import { ConnectionService } from "./connections.js";
import { loadGoldenFixture, type GoldenEvent } from "./contracts.js";
import type { IngestionService, IngestResult } from "./ingestion/service.js";
import type { Observation } from "./mapping/index.js";

/** Golden fixture connection labels → demo providers (shapes, not live connectors). */
export const DEMO_CONNECTIONS: Record<string, { provider: string; display_name: string; datasets: string[] }> = {
  shop: { provider: "shopify", display_name: "Demo shop (Shopify-shaped)", datasets: ["orders", "allocations", "fulfillments", "returns"] },
  stock: { provider: "generic", display_name: "Demo warehouse (generic)", datasets: ["stock", "receipts"] },
  invoice: { provider: "generic", display_name: "Demo invoicing (generic)", datasets: ["invoices"] },
  payment: { provider: "shopify_payments", display_name: "Demo payments (Shopify Payments-shaped)", datasets: ["payments", "provider_ledger", "refunds", "payouts"] },
  carrier: { provider: "generic", display_name: "Demo carrier (generic)", datasets: ["fulfillments", "tracking"] },
  bank_csv: { provider: "bank_csv", display_name: "Demo bank statement (CSV)", datasets: ["bank"] },
};

export class DemoError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "DemoError";
    this.code = code;
    this.status = status;
  }
}

export function goldenToObservation(e: GoldenEvent): Observation {
  return { provider_event_id: e.provider_event_id, kind: e.kind, occurred_at: e.occurred_at, entity: e.entity, payload: e.payload, evidence_refs: e.evidence_refs.map((ref) => fixtureIdToProviderEventId(ref)), correlation_id: `golden:${e.id}` };
}

/** Golden evidence_refs name fixture ids (G01); producers reference provider_event_ids (fixture-01). */
export function fixtureIdToProviderEventId(ref: string): string {
  const m = /^G(\d{2})$/.exec(ref);
  return m ? `fixture-${m[1]}` : ref;
}

/**
 * Loads GOLDEN-ORDER-TO-CASH.json through the replay ingestion path into labeled demo
 * connections of the owner workspace. Idempotent (duplicates are no-ops); refuses to run when
 * non-demo connections already hold data unless `confirm` is set.
 */
export class DemoService {
  private readonly connections: ConnectionService;
  constructor(
    private readonly pool: Pool,
    private readonly ingestion: IngestionService,
    connections: ConnectionService,
  ) {
    this.connections = connections;
  }

  async run(tenantId: string, opts: { confirm?: boolean; upTo?: string } = {}): Promise<{ connections: Record<string, string>; run_id: string; result: IngestResult; checkpoints: number }> {
    const fixture = loadGoldenFixture();
    const existing = await this.connections.list(tenantId);
    const nonDemoWithData = await withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM deliveries d JOIN connections cn ON cn.connection_id = d.connection_id WHERE COALESCE((cn.config_json->>'demo')::boolean, false) = false");
      return Number(r.rows[0]?.n ?? 0);
    });
    if (nonDemoWithData > 0 && !opts.confirm) throw new DemoError("confirmation_required", 409, "non-demo connections already hold data; pass {confirm:true} to add the labeled demo scenario alongside");
    const ids: Record<string, string> = {};
    for (const [label, spec] of Object.entries(DEMO_CONNECTIONS)) {
      const found = existing.find((cn) => cn.config.demo === true && cn.config.demo_label === label && cn.status !== "disconnected");
      if (found) ids[label] = found.connection_id;
      else {
        const created = await this.connections.create(tenantId, { provider: spec.provider, display_name: spec.display_name, config: { demo: true, demo_label: label, fixture: "GOLDEN-ORDER-TO-CASH", fixture_version: fixture.version }, account_ref: `demo:${label}` });
        ids[label] = created.connection.connection_id;
      }
    }
    const events = opts.upTo ? fixture.events.slice(0, fixture.events.findIndex((e) => e.id === opts.upTo) + 1) : fixture.events;
    const total: IngestResult = { accepted: 0, duplicate: 0, conflict: 0, rejected: 0, committed_cursor: null, outcomes: [] };
    // One run per demo load, recorded on the shop connection (the scenario anchor).
    const run = await this.connections.createRun(tenantId, ids.shop!, "demo", null, { requested: events.length, totalsKnown: true });
    for (const e of events) {
      const connectionId = ids[e.connection];
      if (!connectionId) throw new DemoError("fixture_connection_unknown", 500, `fixture connection ${e.connection} has no demo mapping`);
      const r = await this.ingestion.ingest({ tenantId, connectionId, producer: "replay", runId: run.run_id, runKind: "demo", observations: [goldenToObservation(e)] });
      total.accepted += r.accepted;
      total.duplicate += r.duplicate;
      total.conflict += r.conflict;
      total.rejected += r.rejected;
      total.outcomes.push(...r.outcomes);
      if (r.committed_cursor !== null) total.committed_cursor = Math.max(total.committed_cursor ?? 0, r.committed_cursor);
    }
    const from = events[0]?.occurred_at ?? fixture.test_clock;
    const to = fixture.test_clock;
    for (const [label, spec] of Object.entries(DEMO_CONNECTIONS)) {
      for (const ds of spec.datasets) {
        await this.connections.recordCheck(tenantId, ids[label]!, ds, { outcome: total.accepted > 0 ? "success_new" : "success_empty", coverage: { from, to, state: "complete_for_declared_scope", history_kind: "event_history" }, limitations: ["synthetic demo fixture: no live provider"], schedule_seconds: null });
      }
    }
    await this.connections.updateRun(tenantId, run.run_id, { phase: "link_and_process", state: total.rejected > 0 ? "completed_with_gaps" : "completed", outcome: total.rejected > 0 ? "completed_with_gaps" : "completed", finished: true, next_action: "engine_apply_pending" });
    return { connections: ids, run_id: run.run_id, result: total, checkpoints: fixture.checkpoints.length };
  }
}
