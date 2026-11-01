/**
 * Connection secret codec shared by API (writer) and worker (reader).
 * Format: 1 byte format version (0x01) | 12 byte IV | 16 byte GCM tag | ciphertext. Key: 32 bytes.
 * The key is supplied through an environment variable or key file and never written to the database.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretKeyring { version: number; key: Buffer }

export function loadKeyring(env: NodeJS.ProcessEnv = process.env): SecretKeyring | null {
  const hex = env.BLACKBOX_SECRET_KEY;
  if (!hex) return null;
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('BLACKBOX_SECRET_KEY must be 32 bytes hex');
  return { version: Number(env.BLACKBOX_SECRET_KEY_VERSION ?? '1'), key };
}

export function sealSecret(plain: Record<string, unknown>, ring: SecretKeyring): { ciphertext: Buffer; key_version: number } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(plain), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([Buffer.from([1]), iv, tag, enc]), key_version: ring.version };
}

export function openSecret(ciphertext: Buffer, key_version: number | null, ring: SecretKeyring): Record<string, unknown> {
  if (key_version !== null && key_version !== ring.version) throw new Error(`secret key version ${key_version} not available`);
  if (ciphertext[0] !== 1) throw new Error('unknown secret format');
  const iv = ciphertext.subarray(1, 13);
  const tag = ciphertext.subarray(13, 29);
  const enc = ciphertext.subarray(29);
  const decipher = createDecipheriv('aes-256-gcm', ring.key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as Record<string, unknown>;
}
