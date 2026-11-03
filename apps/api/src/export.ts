import { strToU8, zipSync } from "fflate";
import type { TenantClient } from "@blackbox/database";
import { withTenant, type Pool } from "@blackbox/database";

/**
 * SEC-02: authorized workspace export. Owner-only (session + CSRF, never an agent key). Produces a
 * bounded zip of the owner's own workspace: canonical journal entries (JSON lines, full typed
 * payloads — they are the owner's business records), evidence METADATA only (never raw content;
 * restricted/redacted/expired objects are listed with their ledger status), and the workspace
 * settings/retention policy. Every query runs inside the tenant transaction (RLS + explicit
 * tenant_id predicate), so another workspace's rows can never be included. Each download appends
 * a `security_audit` row `workspace.exported` (actor, categories, counts, bytes); `?preview=1`
 * computes the same inventory without producing the file and without an audit row.
 */
export const WORKSPACE_EXPORT_CATEGORIES = ["journal", "evidence_metadata", "settings"] as const;
export type WorkspaceExportCategory = (typeof WORKSPACE_EXPORT_CATEGORIES)[number];

/** Documented cap on the UNCOMPRESSED content of one export (the zip itself is smaller). */
export const WORKSPACE_EXPORT_MAX_BYTES = 64 * 1024 * 1024;
/** Journal page size per indexed read (journal_entries_tenant_sequence_key keyset). */
const JOURNAL_PAGE = 500;
export const WORKSPACE_EXPORT_FORMAT_VERSION = 1;

export interface WorkspaceExportRequest {
  tenantId: string;
  categories: readonly WorkspaceExportCategory[];
  /** Inclusive lower bound on recorded_at (RFC3339) for journal entries and evidence receipt. */
  from?: string | null;
  /** Exclusive upper bound on recorded_at (RFC3339). */
  to?: string | null;
  serviceVersion: string;
  maxBytes?: number;
}

export interface WorkspaceExportInventory {
  format_version: number;
  categories: WorkspaceExportCategory[];
  from: string | null;
  to: string | null;
  committed_cursor: number;
  counts: { journal_entries: number; evidence_items: number; evidence_restricted: number; settings_sections: number };
  /** Uncompressed bytes of all files in the bundle. */
  size_bytes: number;
  max_bytes: number;
  truncated: boolean;
  /** Last journal sequence included (0 when none); continue with from = recorded_at of the next entry when truncated. */
  last_included_sequence: number;
  /** When truncated: recorded_at of the first entry that did not fit (use it as `from` for a follow-up export). */
  continue_from: string | null;
  files: string[];
}

export interface WorkspaceExport {
  inventory: WorkspaceExportInventory;
  zip: Uint8Array | null;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);

function entryToJson(r: Record<string, unknown>): Record<string, unknown> {
  return {
    entry_id: r.entry_id,
    tenant_id: r.tenant_id,
    journal_sequence: Number(r.journal_sequence),
    track: r.track,
    record_id: r.record_id,
    event_type: r.event_type,
    schema_version: Number(r.schema_version),
    connection_id: r.connection_id ?? null,
    provider: r.provider ?? null,
    account_ref: r.account_ref ?? null,
    provider_event_id: r.provider_event_id ?? null,
    occurred_at: iso(r.occurred_at),
    recorded_at: iso(r.recorded_at),
    source_time: iso(r.source_time),
    entity_refs: r.entity_refs ?? {},
    payload: r.payload ?? {},
    payload_hash: r.payload_hash,
    evidence_refs: r.evidence_refs ?? [],
    input_entry_ids: r.input_entry_ids ?? [],
    derivation_rule: r.derivation_rule ?? null,
    derivation_version: r.derivation_version === null || r.derivation_version === undefined ? null : Number(r.derivation_version),
    supersedes_entry_id: r.supersedes_entry_id ?? null,
    correlation_id: r.correlation_id ?? null,
    causation_id: r.causation_id ?? null,
  };
}

/** Builds the inventory and (unless `previewOnly`) the zip. All reads are tenant-scoped and indexed. */
export async function buildWorkspaceExport(pool: Pool, req: WorkspaceExportRequest, previewOnly: boolean): Promise<WorkspaceExport> {
  const max = req.maxBytes ?? WORKSPACE_EXPORT_MAX_BYTES;
  const categories = [...new Set(req.categories)].filter((c) => WORKSPACE_EXPORT_CATEGORIES.includes(c));
  return withTenant(pool, req.tenantId, async (c) => {
    const files: Record<string, Uint8Array> = {};
    const inventory: WorkspaceExportInventory = {
      format_version: WORKSPACE_EXPORT_FORMAT_VERSION,
      categories,
      from: req.from ?? null,
      to: req.to ?? null,
      committed_cursor: await committedCursor(c, req.tenantId),
      counts: { journal_entries: 0, evidence_items: 0, evidence_restricted: 0, settings_sections: 0 },
      size_bytes: 0,
      max_bytes: max,
      truncated: false,
      last_included_sequence: 0,
      continue_from: null,
      files: [],
    };
    const put = (name: string, content: string) => {
      const bytes = strToU8(content);
      files[name] = bytes;
      inventory.size_bytes += bytes.length;
      inventory.files.push(name);
    };

    // ----- settings (small; written first so a truncated export still carries the policy) -----
    if (categories.includes("settings")) {
      const settings = await readSettings(c, req.tenantId);
      inventory.counts.settings_sections = Object.keys(settings).length;
      put("settings.json", JSON.stringify(settings, null, 2) + "\n");
    }

    // ----- evidence metadata (never content) -----
    if (categories.includes("evidence_metadata")) {
      const rows = await c.query<{
        evidence_id: string;
        connection_id: string | null;
        kind: string;
        media_type: string;
        byte_size: string;
        content_hash: string;
        received_at: Date;
        evidence_class: string;
        ledger_action: string | null;
        ledger_policy: string | null;
        ledger_at: Date | null;
        retention_days: number | null;
      }>(
        `SELECT e.evidence_id, e.connection_id, e.kind, e.media_type, e.byte_size, e.content_hash, e.received_at, e.evidence_class,
                l.action AS ledger_action, l.policy_ref AS ledger_policy, l.created_at AS ledger_at, p.days AS retention_days
           FROM journal_evidence e
           LEFT JOIN LATERAL (SELECT action, policy_ref, created_at FROM evidence_redactions r WHERE r.tenant_id = e.tenant_id AND r.evidence_id = e.evidence_id ORDER BY created_at DESC LIMIT 1) l ON true
           LEFT JOIN retention_policies p ON p.tenant_id = e.tenant_id AND p.evidence_class = e.evidence_class
          WHERE e.tenant_id = $1 AND ($2::timestamptz IS NULL OR e.received_at >= $2) AND ($3::timestamptz IS NULL OR e.received_at < $3)
          ORDER BY e.received_at, e.evidence_id`,
        [req.tenantId, req.from ?? null, req.to ?? null],
      );
      const lines: string[] = [];
      const now = Date.now();
      for (const r of rows.rows) {
        const days = r.retention_days ?? 90;
        const expired = now - r.received_at.getTime() > days * 24 * 3600 * 1000;
        // Ledger action wins (restricted = owner action, redacted = policy, expired = ledgered expiry); otherwise policy expiry; otherwise available.
        const status = r.ledger_action ?? (expired ? "expired" : "available");
        if (status !== "available") inventory.counts.evidence_restricted += 1;
        lines.push(
          JSON.stringify({
            evidence_id: r.evidence_id,
            connection_id: r.connection_id,
            kind: r.kind,
            media_type: r.media_type,
            byte_size: Number(r.byte_size),
            content_hash: r.content_hash,
            received_at: r.received_at.toISOString(),
            evidence_class: r.evidence_class,
            retention_days: days,
            status,
            status_policy_ref: r.ledger_policy ?? (status === "expired" ? `retention_policy_${days}_days` : null),
            status_since: r.ledger_at ? r.ledger_at.toISOString() : null,
            content_included: false,
          }),
        );
      }
      inventory.counts.evidence_items = rows.rows.length;
      put("evidence-metadata.jsonl", lines.join("\n") + (lines.length ? "\n" : ""));
    }

    // ----- journal (indexed keyset pages within the committed snapshot; bounded by the byte cap) -----
    if (categories.includes("journal")) {
      const chunks: string[] = [];
      let after = 0;
      let bytes = 0;
      const snapshot = inventory.committed_cursor;
      outer: for (;;) {
        const r = await c.query(
          `SELECT * FROM journal_entries
            WHERE tenant_id = $1 AND journal_sequence > $2 AND journal_sequence <= $3
              AND ($4::timestamptz IS NULL OR recorded_at >= $4) AND ($5::timestamptz IS NULL OR recorded_at < $5)
            ORDER BY journal_sequence ASC LIMIT $6`,
          [req.tenantId, after, snapshot, req.from ?? null, req.to ?? null, JOURNAL_PAGE],
        );
        if (r.rows.length === 0) break;
        for (const row of r.rows as Record<string, unknown>[]) {
          const line = JSON.stringify(entryToJson(row)) + "\n";
          const len = Buffer.byteLength(line, "utf8");
          if (inventory.size_bytes + bytes + len > max) {
            inventory.truncated = true;
            inventory.continue_from = iso(row.recorded_at);
            break outer;
          }
          chunks.push(line);
          bytes += len;
          inventory.counts.journal_entries += 1;
          inventory.last_included_sequence = Number(row.journal_sequence);
          after = Number(row.journal_sequence);
        }
        if (r.rows.length < JOURNAL_PAGE) break;
      }
      put("journal-entries.jsonl", chunks.join(""));
    }

    put(
      "manifest.json",
      JSON.stringify(
        {
          format: "blackbox-workspace-export",
          format_version: WORKSPACE_EXPORT_FORMAT_VERSION,
          service_version: req.serviceVersion,
          exported_at: new Date().toISOString(),
          tenant_id: req.tenantId,
          categories,
          from: inventory.from,
          to: inventory.to,
          committed_cursor: inventory.committed_cursor,
          counts: inventory.counts,
          truncated: inventory.truncated,
          last_included_sequence: inventory.last_included_sequence,
          continue_from: inventory.continue_from,
          max_bytes: max,
          notes: [
            "journal-entries.jsonl: one canonical journal entry per line (all five tracks), ordered by journal_sequence within the committed cursor at export time.",
            "evidence-metadata.jsonl: evidence metadata only. Raw provider content is never exported; restricted/redacted/expired objects carry their ledger status.",
            "settings.json: workspace, retention policy per evidence class, storage thresholds and backup retention. No secrets, keys or sessions.",
            "A truncated export (byte cap) names continue_from: repeat the export with from = continue_from to fetch the remainder.",
          ],
        },
        null,
        2,
      ) + "\n",
    );
    if (previewOnly) return { inventory, zip: null };
    return { inventory, zip: zipSync(files, { level: 6 }) };
  });
}

async function committedCursor(c: TenantClient, tenantId: string): Promise<number> {
  const r = await c.query<{ last_sequence: string }>("SELECT last_sequence FROM tenant_sequences WHERE tenant_id = $1", [tenantId]);
  return Number(r.rows[0]?.last_sequence ?? 0);
}

async function readSettings(c: TenantClient, tenantId: string): Promise<Record<string, unknown>> {
  const ws = await c.query<{ tenant_id: string; display_name: string; created_at: Date }>("SELECT tenant_id, display_name, created_at FROM tenants WHERE tenant_id = $1", [tenantId]);
  const loc = await c.query<{ locale: string | null; updated_at: Date | null }>("SELECT locale, updated_at FROM workspace_settings WHERE tenant_id = $1", [tenantId]);
  const ret = await c.query<{ evidence_class: string; days: number; source: string; updated_at: Date | null }>("SELECT evidence_class, days, source, updated_at FROM retention_policies WHERE tenant_id = $1 ORDER BY evidence_class", [tenantId]);
  const st = await c.query<Record<string, unknown>>("SELECT warn_percent, warn_min_bytes, critical_percent, critical_min_bytes, log_cap_bytes, log_retention_days FROM storage_thresholds WHERE tenant_id = $1", [tenantId]);
  const bk = await c.query<Record<string, unknown>>("SELECT retention_daily, retention_weekly, last_restore_test_at FROM backup_status WHERE tenant_id = $1", [tenantId]);
  const t = st.rows[0];
  const b = bk.rows[0];
  return {
    workspace: ws.rows[0] ? { tenant_id: ws.rows[0].tenant_id, display_name: ws.rows[0].display_name, locale: loc.rows[0]?.locale === "de" ? "de" : "en", created_at: ws.rows[0].created_at.toISOString() } : null,
    retention: { default_days: 90, classes: Object.fromEntries(ret.rows.map((x) => [x.evidence_class, { days: Number(x.days), source: x.source, updated_at: iso(x.updated_at) }])) },
    storage_thresholds: t ? { warn_percent: Number(t.warn_percent), warn_min_bytes: Number(t.warn_min_bytes), critical_percent: Number(t.critical_percent), critical_min_bytes: Number(t.critical_min_bytes), log_cap_bytes: Number(t.log_cap_bytes), log_retention_days: Number(t.log_retention_days) } : null,
    backups: b ? { retention_daily: Number(b.retention_daily), retention_weekly: Number(b.retention_weekly), last_restore_test_at: iso(b.last_restore_test_at) } : null,
  };
}
