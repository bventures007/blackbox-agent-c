import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import type { TenantClient } from "@blackbox/database";

export const DEFAULT_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024; // bounded raw observation size

export interface StoredEvidence {
  evidence_id: string;
  content_hash: string;
  byte_size: number;
  storage_ref: string;
}

export interface EvidenceMeta {
  evidence_id: string;
  tenant_id: string;
  connection_id: string | null;
  kind: string;
  media_type: string;
  byte_size: number;
  content_hash: string;
  storage_ref: string;
  received_at: string;
  evidence_class: string;
}

export type EvidenceAccess = { status: "available"; meta: EvidenceMeta; content: Buffer } | { status: "redacted" | "expired" | "unavailable"; meta: EvidenceMeta | null; reason: string };

/**
 * Raw observation storage on the evidence volume (EVIDENCE_DIR/<tenant>/<yyyymm>/<id>.<ext>).
 * Journal rows reference evidence by opaque uuid; content is never replaced under an existing id.
 * Redaction/expiry is checked through the evidence_redactions ledger on every read.
 */
export class EvidenceStore {
  constructor(
    readonly dir: string,
    readonly maxBytes = DEFAULT_EVIDENCE_MAX_BYTES,
  ) {}

  private pathFor(tenantId: string, storageRef: string): string {
    // storage_ref is an opaque relative path produced here; reject traversal defensively.
    if (storageRef.includes("..") || path.isAbsolute(storageRef)) throw new Error("invalid storage_ref");
    return path.join(this.dir, tenantId, storageRef);
  }

  /** Writes content and inserts the immutable journal_evidence row inside the caller's transaction. */
  async store(client: TenantClient, input: { tenantId: string; connectionId: string | null; kind: string; mediaType: string; content: Buffer; evidenceClass?: string }): Promise<StoredEvidence> {
    if (input.content.length > this.maxBytes) throw new Error(`evidence exceeds the ${this.maxBytes} byte bound`);
    const hash = createHash("sha256").update(input.content).digest("hex");
    const now = new Date();
    const month = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const ext = input.mediaType === "application/json" ? "json" : input.mediaType === "text/csv" ? "csv" : "bin";
    const id = (await client.query<{ id: string }>("SELECT gen_random_uuid()::text AS id")).rows[0]!.id;
    const storageRef = `${month}/${id}.${ext}`;
    const full = this.pathFor(input.tenantId, storageRef);
    mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
    writeFileSync(full, input.content, { flag: "wx", mode: 0o600 });
    try {
      await client.query(
        "INSERT INTO journal_evidence (evidence_id, tenant_id, connection_id, kind, media_type, byte_size, content_hash, storage_ref, evidence_class) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [id, input.tenantId, input.connectionId, input.kind, input.mediaType, input.content.length, hash, storageRef, input.evidenceClass ?? "provider_payload"],
      );
    } catch (err) {
      // The row failed: remove the orphan file so a rolled-back transaction leaves nothing behind.
      try {
        unlinkSync(full);
      } catch {
        /* ignore */
      }
      throw err;
    }
    return { evidence_id: id, content_hash: hash, byte_size: input.content.length, storage_ref: storageRef };
  }

  async get(client: TenantClient, tenantId: string, evidenceId: string): Promise<EvidenceAccess> {
    const r = await client.query<{
      evidence_id: string;
      tenant_id: string;
      connection_id: string | null;
      kind: string;
      media_type: string;
      byte_size: string;
      content_hash: string;
      storage_ref: string;
      received_at: Date;
      evidence_class: string;
    }>("SELECT * FROM journal_evidence WHERE evidence_id = $1 AND tenant_id = $2", [evidenceId, tenantId]);
    const row = r.rows[0];
    if (!row) return { status: "unavailable", meta: null, reason: "evidence_not_found" };
    const meta: EvidenceMeta = {
      evidence_id: row.evidence_id,
      tenant_id: row.tenant_id,
      connection_id: row.connection_id,
      kind: row.kind,
      media_type: row.media_type,
      byte_size: Number(row.byte_size),
      content_hash: row.content_hash,
      storage_ref: row.storage_ref,
      received_at: row.received_at.toISOString(),
      evidence_class: row.evidence_class,
    };
    const red = await client.query<{ action: "redacted" | "expired" | "restricted"; reason: string }>("SELECT action, reason FROM evidence_redactions WHERE evidence_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 1", [evidenceId, tenantId]);
    const latest = red.rows[0];
    if (latest) {
      const status = latest.action === "expired" ? "expired" : "redacted";
      return { status, meta, reason: latest.reason };
    }
    // Retention policy by evidence class (default 90 days from local receipt).
    const pol = await client.query<{ days: number }>("SELECT days FROM retention_policies WHERE tenant_id = $1 AND evidence_class = $2", [tenantId, row.evidence_class]);
    const days = pol.rows[0]?.days ?? 90;
    if (Date.now() - row.received_at.getTime() > days * 24 * 3600 * 1000) {
      return { status: "expired", meta, reason: `retention_policy_${days}_days` };
    }
    const full = this.pathFor(tenantId, row.storage_ref);
    if (!existsSync(full)) return { status: "unavailable", meta, reason: "evidence_content_missing" };
    const content = readFileSync(full);
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== row.content_hash) return { status: "unavailable", meta, reason: "evidence_integrity_mismatch" };
    return { status: "available", meta, content };
  }

  /** Audited redaction: appends to the ledger and removes live content (journal rows untouched). */
  async redact(client: TenantClient, input: { tenantId: string; evidenceId: string; action: "redacted" | "expired" | "restricted"; reason: string; actorId: string | null; policyRef?: string; auditEntryId?: string | null }): Promise<boolean> {
    const r = await client.query<{ storage_ref: string }>("SELECT storage_ref FROM journal_evidence WHERE evidence_id = $1 AND tenant_id = $2", [input.evidenceId, input.tenantId]);
    const row = r.rows[0];
    if (!row) return false;
    await client.query("INSERT INTO evidence_redactions (tenant_id, evidence_id, action, reason, actor_id, policy_ref, audit_entry_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [input.tenantId, input.evidenceId, input.action, input.reason, input.actorId, input.policyRef ?? null, input.auditEntryId ?? null]);
    const full = this.pathFor(input.tenantId, row.storage_ref);
    try {
      if (existsSync(full)) unlinkSync(full);
    } catch {
      /* content removal is best effort; ledger blocks access regardless */
    }
    return true;
  }

  usage(): { bytes: number; available: boolean } {
    try {
      statSync(this.dir);
      return { bytes: dirSize(this.dir), available: true };
    } catch {
      return { bytes: 0, available: false };
    }
  }
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  }
  return total;
}
