import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync, openSync, writeSync, closeSync } from "node:fs";
import path from "node:path";

export const DATA_KEY_FILE = "data.key";
/** Text file holding the integer generation of data.key (absent = 1, the pre-rotation layout). */
export const DATA_KEY_VERSION_FILE = "data.key.version";
/**
 * Root key material for the PII anchors (HKDF ikm). Absent = legacy layout where the anchors were
 * derived from data.key itself; `./blackbox rotate-data-key` freezes the generation-1 material into
 * this file before retiring it so historical anchors keep joining (see docs/operations.md, PILOT-07).
 */
export const ANCHOR_KEY_FILE = "anchor.key";
export const DATA_KEY_BYTES = 32;
export const CURRENT_KEY_VERSION = 1;
const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface DataKey {
  key: Buffer;
  version: number;
  path: string;
  /** HKDF root for PII anchors (defaults to `key` on the legacy layout). */
  anchorRoot: Buffer;
}

export class DataKeyError extends Error {
  readonly code: string;
  readonly action: string;
  constructor(code: string, message: string, action: string) {
    super(message);
    this.name = "DataKeyError";
    this.code = code;
    this.action = action;
  }
}

/**
 * Loads SECRETS_DIR/data.key (32 raw bytes, mode 0600). A missing or corrupt key is an actionable
 * error: dependent operations stop; the key is never regenerated over existing encrypted data.
 */
export function loadDataKey(secretsDir: string): DataKey {
  const file = path.join(secretsDir, DATA_KEY_FILE);
  if (!existsSync(file)) {
    throw new DataKeyError(
      "data_key_missing",
      `installation data key not found at ${DATA_KEY_FILE} in the secrets directory`,
      "Run `./blackbox setup` on a fresh installation, or restore the secrets directory from your backup recovery material. The key is never regenerated automatically because existing encrypted provider secrets would become unreadable.",
    );
  }
  const key = readKeyBytes(file, DATA_KEY_FILE);
  const version = readKeyVersion(secretsDir);
  const anchorFile = path.join(secretsDir, ANCHOR_KEY_FILE);
  const anchorRoot = existsSync(anchorFile) ? readKeyBytes(anchorFile, ANCHOR_KEY_FILE) : key;
  return { key, version, path: file, anchorRoot };
}

function readKeyBytes(file: string, label: string): Buffer {
  const st = statSync(file);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new DataKeyError("data_key_permissions", `${label} must be readable only by its owner (mode 0600)`, "Run `chmod 600` on the key file and `chmod 700` on the secrets directory.");
  }
  const key = readFileSync(file);
  if (key.length !== DATA_KEY_BYTES) {
    throw new DataKeyError("data_key_corrupt", `${label} has ${key.length} bytes, expected ${DATA_KEY_BYTES}`, "Restore the secrets directory from backup recovery material; do not create a new key over existing data.");
  }
  return key;
}

/** Generation of the live data key: integer in data.key.version (1..255), absent = 1. */
export function readKeyVersion(secretsDir: string): number {
  const file = path.join(secretsDir, DATA_KEY_VERSION_FILE);
  if (!existsSync(file)) return CURRENT_KEY_VERSION;
  const raw = readFileSync(file, "utf8").trim();
  if (!/^[0-9]{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 255) {
    throw new DataKeyError("data_key_version_corrupt", `${DATA_KEY_VERSION_FILE} must hold an integer 1..255 (found ${JSON.stringify(raw.slice(0, 10))})`, "Restore the secrets directory from backup recovery material or complete the interrupted rotation (./blackbox rotate-data-key --resume).");
  }
  return Number(raw);
}

/**
 * Loads a candidate key file (the next generation during rotation, mounted read-only into the api
 * container). The version is explicit; the anchor root is inherited from the live key so rotation
 * never changes historical anchors.
 */
export function loadCandidateKey(file: string, version: number, anchorRoot: Buffer): DataKey {
  if (!existsSync(file)) throw new DataKeyError("data_key_candidate_missing", `candidate key file ${file} not found`, "Run ./blackbox rotate-data-key, which generates the candidate on the host.");
  if (version < 1 || version > 255) throw new DataKeyError("data_key_version_range", `key version ${version} out of range 1..255`, "Key versions are one byte in the ciphertext header.");
  return { key: readKeyBytes(file, path.basename(file)), version, path: file, anchorRoot };
}

/** Decrypts with the retiring key and re-seals with the new generation (same AAD binding). */
export function reencryptSecret(from: DataKey, to: DataKey, blob: Buffer, aad: Aad): Buffer {
  return encryptSecret(to, decryptSecret(from, blob, aad), aad);
}

/** Creates the key only when it does not exist (setup); returns whether it was created. */
export function ensureDataKey(secretsDir: string): { created: boolean; dataKey: DataKey } {
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(secretsDir, 0o700);
  } catch {
    /* best effort on non-POSIX */
  }
  const file = path.join(secretsDir, DATA_KEY_FILE);
  if (existsSync(file)) return { created: false, dataKey: loadDataKey(secretsDir) };
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, randomBytes(DATA_KEY_BYTES));
  } finally {
    closeSync(fd);
  }
  chmodSync(file, 0o600);
  return { created: true, dataKey: loadDataKey(secretsDir) };
}

export interface Aad {
  tenantId: string;
  purpose: string;
  keyVersion?: number;
}

function aadBytes(aad: Aad, keyVersion: number): Buffer {
  return Buffer.from(`${aad.tenantId}|${aad.purpose}|${keyVersion}`, "utf8");
}

/**
 * AES-256-GCM with a unique 12-byte nonce and AAD `tenant_id|purpose|key_version`.
 * Layout: [format(1)][key_version(1)][nonce(12)][tag(16)][ciphertext].
 */
export function encryptSecret(dataKey: DataKey, plaintext: Buffer | string, aad: Aad): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey.key, nonce);
  cipher.setAAD(aadBytes(aad, dataKey.version));
  const ct = Buffer.concat([cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([FORMAT_VERSION, dataKey.version]), nonce, tag, ct]);
}

export function decryptSecret(dataKey: DataKey, blob: Buffer, aad: Aad): Buffer {
  if (blob.length < 2 + NONCE_BYTES + TAG_BYTES) throw new DataKeyError("ciphertext_invalid", "ciphertext too short", "The stored secret is corrupt; reconnect the source.");
  const format = blob[0];
  const version = blob[1]!;
  if (format !== FORMAT_VERSION) throw new DataKeyError("ciphertext_format", `unsupported ciphertext format ${format}`, "Upgrade or restore a compatible release.");
  if (version !== dataKey.version) throw new DataKeyError("data_key_version", `secret was encrypted with key version ${version}, live key is ${dataKey.version}`, "Complete the data-key rotation or restore the matching key generation.");
  const nonce = blob.subarray(2, 2 + NONCE_BYTES);
  const tag = blob.subarray(2 + NONCE_BYTES, 2 + NONCE_BYTES + TAG_BYTES);
  const ct = blob.subarray(2 + NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", dataKey.key, nonce);
  decipher.setAAD(aadBytes(aad, version));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new DataKeyError("ciphertext_tampered", "authentication of the stored secret failed (wrong tenant/purpose binding or tampering)", "Reconnect the source; the stored secret cannot be used.");
  }
}

/**
 * Keyed anchor for personal data that must stay out of canonical payloads: HMAC-SHA256 with a
 * per-tenant key derived from the data key (HKDF). Not advertised as anonymization; it is an
 * opaque, tenant-bound join key that cannot be reversed without the installation key.
 */
export function anchorKeyFor(dataKey: DataKey, tenantId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", dataKey.anchorRoot, Buffer.from(tenantId, "utf8"), Buffer.from("blackbox-pii-anchor-v1"), 32));
}

export function piiAnchor(anchorKey: Buffer, field: string, value: string): string {
  const mac = createHmac("sha256", anchorKey).update(`${field}\u0000${value.trim().toLowerCase()}`).digest("base64url");
  return `anc_${mac.slice(0, 22)}`;
}
