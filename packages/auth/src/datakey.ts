import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync, openSync, writeSync, closeSync } from "node:fs";
import path from "node:path";

export const DATA_KEY_FILE = "data.key";
export const DATA_KEY_BYTES = 32;
export const CURRENT_KEY_VERSION = 1;
const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface DataKey {
  key: Buffer;
  version: number;
  path: string;
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
  const st = statSync(file);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new DataKeyError("data_key_permissions", `${DATA_KEY_FILE} must be readable only by its owner (mode 0600)`, "Run `chmod 600` on the key file and `chmod 700` on the secrets directory.");
  }
  const key = readFileSync(file);
  if (key.length !== DATA_KEY_BYTES) {
    throw new DataKeyError("data_key_corrupt", `${DATA_KEY_FILE} has ${key.length} bytes, expected ${DATA_KEY_BYTES}`, "Restore the secrets directory from backup recovery material; do not create a new key over existing data.");
  }
  return { key, version: CURRENT_KEY_VERSION, path: file };
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
  return Buffer.from(hkdfSync("sha256", dataKey.key, Buffer.from(tenantId, "utf8"), Buffer.from("blackbox-pii-anchor-v1"), 32));
}

export function piiAnchor(anchorKey: Buffer, field: string, value: string): string {
  const mac = createHmac("sha256", anchorKey).update(`${field}\u0000${value.trim().toLowerCase()}`).digest("base64url");
  return `anc_${mac.slice(0, 22)}`;
}
