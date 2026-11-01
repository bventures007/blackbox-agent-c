import type { Pool } from "@blackbox/database";
import { withTenant } from "@blackbox/database";

export type ImportPreset = "last_30_days" | "this_year" | "last_12_months" | "custom" | "from_now";

export interface ImportPlanInput {
  preset: ImportPreset;
  from?: string | null; // YYYY-MM-DD (custom)
  to?: string | null; // optional explicit cutoff (RFC3339); default now
  timezone: string;
  include_open_context: boolean;
  include_opening_state?: boolean;
}

export interface ResolvedPlan {
  preset: ImportPreset;
  timezone: string;
  requested_from: string | null;
  initial_cutoff: string;
  include_open_context: boolean;
  include_opening_state: boolean;
  strict_from_now: boolean;
  local_from_label: string | null;
  local_cutoff_label: string;
  restrictions: string[];
}

export interface ImportPlan extends ResolvedPlan {
  plan_id: string;
  plan_revision: number;
  tenant_id: string;
  connection_id: string;
  created_by: string | null;
  created_at: string;
  superseded_at: string | null;
}

export class ImportPlanError extends Error {
  readonly code = "validation";
  constructor(message: string) {
    super(message);
    this.name = "ImportPlanError";
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `tz` relative to UTC at the given instant. */
export function tzOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Local wall time in `tz` → UTC instant (DST gaps/overlaps resolved by two-step correction). */
export function localToUtc(tz: string, y: number, m: number, d: number, h = 0, mi = 0, s = 0): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const off1 = tzOffsetMs(tz, new Date(guess));
  const first = guess - off1;
  const off2 = tzOffsetMs(tz, new Date(first));
  return new Date(guess - off2);
}

export function localParts(tz: string, at: Date): { y: number; m: number; d: number; h: number; mi: number; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const h = Number(get("hour"));
  const mi = Number(get("minute"));
  return { y, m, d, h, mi, label: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")} ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")} ${get("timeZoneName")} (${tz})` };
}

/**
 * Resolves a preset once into a fixed UTC interval [requested_from, initial_cutoff)
 * (IMPORT-ONBOARDING §1): last_30_days = rolling 30×24 h ending at the cutoff; this_year =
 * Jan 1 00:00 local; last_12_months = calendar-month subtraction with end-of-month clamp at local
 * midnight; custom = local midnight of the chosen date; from_now = no history (strict).
 */
export function resolveImportPlan(input: ImportPlanInput, now: Date = new Date()): ResolvedPlan {
  if (!isValidTimezone(input.timezone)) throw new ImportPlanError("timezone must be a valid IANA zone");
  const cutoff = input.to ? new Date(input.to) : now;
  if (Number.isNaN(cutoff.getTime())) throw new ImportPlanError("to must be an RFC3339 timestamp");
  if (cutoff.getTime() > now.getTime() + 60_000) throw new ImportPlanError("cutoff cannot be in the future");
  const tz = input.timezone;
  const local = localParts(tz, cutoff);
  let from: Date | null;
  const restrictions: string[] = [];
  switch (input.preset) {
    case "last_30_days":
      from = new Date(cutoff.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case "this_year":
      from = localToUtc(tz, local.y, 1, 1);
      break;
    case "last_12_months": {
      let y = local.y;
      let m = local.m - 12;
      while (m <= 0) {
        m += 12;
        y -= 1;
      }
      const daysInTarget = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const d = Math.min(local.d, daysInTarget);
      from = localToUtc(tz, y, m, d);
      break;
    }
    case "custom": {
      if (!input.from || !/^\d{4}-\d{2}-\d{2}$/.test(input.from)) throw new ImportPlanError("from must be a date (YYYY-MM-DD) for the custom preset");
      const [y, m, d] = input.from.split("-").map(Number) as [number, number, number];
      const probe = new Date(Date.UTC(y, m - 1, d));
      if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) throw new ImportPlanError("from is not a valid calendar date");
      from = localToUtc(tz, y, m, d);
      if (from.getTime() >= cutoff.getTime()) throw new ImportPlanError("from must be before the cutoff (future dates are rejected)");
      break;
    }
    case "from_now":
      from = null;
      restrictions.push("strict_from_now: no historical records are imported; balances and questions depending on older open items remain partial until history is expanded explicitly");
      break;
    default:
      throw new ImportPlanError("unknown preset");
  }
  const strictFromNow = input.preset === "from_now";
  const includeOpenContext = strictFromNow ? Boolean(input.include_open_context) : input.include_open_context;
  const includeOpening = input.include_opening_state ?? includeOpenContext;
  if (strictFromNow && !includeOpenContext) restrictions.push("opening_state_declined: opening stock/receivable/provider balances are not imported");
  return {
    preset: input.preset,
    timezone: tz,
    requested_from: from ? from.toISOString() : null,
    initial_cutoff: cutoff.toISOString(),
    include_open_context: includeOpenContext,
    include_opening_state: includeOpening,
    strict_from_now: strictFromNow,
    local_from_label: from ? localParts(tz, from).label : null,
    local_cutoff_label: local.label,
    restrictions,
  };
}

export class ImportPlanService {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, connectionId: string, actorId: string | null, input: ImportPlanInput, now = new Date()): Promise<ImportPlan> {
    const resolved = resolveImportPlan(input, now);
    return withTenant(this.pool, tenantId, async (c) => {
      const conn = await c.query("SELECT 1 FROM connections WHERE connection_id = $1", [connectionId]);
      if ((conn.rowCount ?? 0) === 0) throw new ImportPlanError("connection not found");
      await c.query("UPDATE import_plans SET superseded_at = now() WHERE connection_id = $1 AND superseded_at IS NULL", [connectionId]);
      const rev = await c.query<{ next: number }>("SELECT COALESCE(MAX(plan_revision),0)+1 AS next FROM import_plans WHERE connection_id = $1", [connectionId]);
      const r = await c.query<{ plan_id: string; plan_revision: number; created_at: Date }>(
        `INSERT INTO import_plans (tenant_id, connection_id, plan_revision, preset, timezone, requested_from, initial_cutoff, include_open_context, include_opening_state, strict_from_now, local_from_label, local_cutoff_label, restrictions, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING plan_id, plan_revision, created_at`,
        [tenantId, connectionId, Number(rev.rows[0]!.next), resolved.preset, resolved.timezone, resolved.requested_from, resolved.initial_cutoff, resolved.include_open_context, resolved.include_opening_state, resolved.strict_from_now, resolved.local_from_label, resolved.local_cutoff_label, JSON.stringify(resolved.restrictions), actorId],
      );
      // The workspace keeps one suggested history start: first plan sets it; later connections inherit it as a proposal.
      await c.query("INSERT INTO workspace_settings (tenant_id, timezone, history_start) VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO UPDATE SET history_start = COALESCE(workspace_settings.history_start, EXCLUDED.history_start), timezone = EXCLUDED.timezone, updated_at = now()", [tenantId, resolved.timezone, resolved.requested_from]);
      const row = r.rows[0]!;
      return { ...resolved, plan_id: row.plan_id, plan_revision: Number(row.plan_revision), tenant_id: tenantId, connection_id: connectionId, created_by: actorId, created_at: row.created_at.toISOString(), superseded_at: null };
    });
  }

  async current(tenantId: string, connectionId: string): Promise<ImportPlan | null> {
    return withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query("SELECT * FROM import_plans WHERE connection_id = $1 AND superseded_at IS NULL ORDER BY plan_revision DESC LIMIT 1", [connectionId]);
      const row = r.rows[0];
      return row ? rowToPlan(row) : null;
    });
  }

  async proposal(tenantId: string): Promise<{ history_start: string | null; timezone: string }> {
    return withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query<{ history_start: Date | null; timezone: string }>("SELECT history_start, timezone FROM workspace_settings WHERE tenant_id = $1", [tenantId]);
      return { history_start: r.rows[0]?.history_start?.toISOString() ?? null, timezone: r.rows[0]?.timezone ?? "Europe/Berlin" };
    });
  }
}

function rowToPlan(row: Record<string, unknown>): ImportPlan {
  const ts = (v: unknown) => (v ? (v as Date).toISOString() : null);
  return {
    plan_id: row.plan_id as string,
    plan_revision: Number(row.plan_revision),
    tenant_id: row.tenant_id as string,
    connection_id: row.connection_id as string,
    preset: row.preset as ImportPreset,
    timezone: row.timezone as string,
    requested_from: ts(row.requested_from),
    initial_cutoff: ts(row.initial_cutoff)!,
    include_open_context: Boolean(row.include_open_context),
    include_opening_state: Boolean(row.include_opening_state),
    strict_from_now: Boolean(row.strict_from_now),
    local_from_label: (row.local_from_label as string | null) ?? null,
    local_cutoff_label: row.local_cutoff_label as string,
    restrictions: (row.restrictions as string[]) ?? [],
    created_by: (row.created_by as string | null) ?? null,
    created_at: ts(row.created_at)!,
    superseded_at: ts(row.superseded_at),
  };
}
