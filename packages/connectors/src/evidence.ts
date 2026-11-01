/**
 * Evidence content store: raw provider payloads live outside the journal row, addressed by content
 * hash. Bounded size; the journal_evidence row (immutable metadata) is written in the same
 * transaction as the entries referencing it.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

export const EVIDENCE_MAX_BYTES = 256 * 1024;

export interface StoredEvidence { content_hash: string; byte_size: number; storage_ref: string }

export interface EvidenceStore {
  put(tenant_id: string, bytes: Buffer): Promise<StoredEvidence>;
  get(storage_ref: string): Promise<Buffer | null>;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Filesystem store rooted at EVIDENCE_DIR; storage_ref is "fs:<tenant>/<hh>/<hash>.json". */
export class FileEvidenceStore implements EvidenceStore {
  constructor(private readonly root: string) {}
  async put(tenant_id: string, bytes: Buffer): Promise<StoredEvidence> {
    if (bytes.length > EVIDENCE_MAX_BYTES) throw new RangeError(`evidence exceeds ${EVIDENCE_MAX_BYTES} bytes`);
    const hash = sha256Hex(bytes);
    const rel = join(tenant_id, hash.slice(0, 2), `${hash}.json`);
    const path = join(this.root, rel);
    await mkdir(join(this.root, tenant_id, hash.slice(0, 2)), { recursive: true });
    try { await access(path); } catch { await writeFile(path, bytes, { flag: 'wx' }).catch(() => undefined); }
    return { content_hash: hash, byte_size: bytes.length, storage_ref: `fs:${rel}` };
  }
  async get(storage_ref: string): Promise<Buffer | null> {
    if (!storage_ref.startsWith('fs:')) return null;
    try { return await readFile(join(this.root, storage_ref.slice(3))); } catch { return null; }
  }
}

/** In-memory store for tests. */
export class MemoryEvidenceStore implements EvidenceStore {
  readonly blobs = new Map<string, Buffer>();
  async put(tenant_id: string, bytes: Buffer): Promise<StoredEvidence> {
    if (bytes.length > EVIDENCE_MAX_BYTES) throw new RangeError(`evidence exceeds ${EVIDENCE_MAX_BYTES} bytes`);
    const hash = sha256Hex(bytes);
    const ref = `mem:${tenant_id}/${hash}`;
    this.blobs.set(ref, bytes);
    return { content_hash: hash, byte_size: bytes.length, storage_ref: ref };
  }
  async get(storage_ref: string): Promise<Buffer | null> { return this.blobs.get(storage_ref) ?? null; }
}
