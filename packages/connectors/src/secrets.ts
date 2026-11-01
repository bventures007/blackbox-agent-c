/**
 * Connection secret codec shared by the API (writer) and the worker (reader): ONE implementation,
 * `@blackbox/auth` AES-256-GCM with the installation data key (SECRETS_DIR/data.key, 32 raw bytes,
 * mode 0600) and AAD `tenant_id|connection_secret|key_version` (ADR-0002). The key is read from
 * DATA_KEY_FILE or SECRETS_DIR/data.key and never written to the database or logs.
 */
import path from 'node:path';
import { decryptSecret, encryptSecret, loadDataKey, type DataKey } from '@blackbox/auth';

export const CONNECTION_SECRET_PURPOSE = 'connection_secret';

/** The installation data key (version + raw key bytes + path). */
export type SecretKeyring = DataKey;

/**
 * Loads the data key for the worker: DATA_KEY_FILE (Compose secret mount) first, then
 * SECRETS_DIR/data.key. Returns null when neither is configured (connections with secrets then
 * fail with `secret_key_missing` instead of a silent fallback).
 */
export function loadKeyring(env: NodeJS.ProcessEnv = process.env): SecretKeyring | null {
  if (env.DATA_KEY_FILE) return loadDataKey(path.dirname(env.DATA_KEY_FILE));
  if (env.SECRETS_DIR) return loadDataKey(env.SECRETS_DIR);
  return null;
}

export function sealSecret(plain: Record<string, unknown>, ring: SecretKeyring, tenant_id: string): { ciphertext: Buffer; key_version: number } {
  return { ciphertext: encryptSecret(ring, JSON.stringify(plain), { tenantId: tenant_id, purpose: CONNECTION_SECRET_PURPOSE }), key_version: ring.version };
}

export function openSecret(ciphertext: Buffer, key_version: number | null, ring: SecretKeyring, tenant_id: string): Record<string, unknown> {
  if (key_version !== null && key_version !== ring.version) throw new Error(`secret key version ${key_version} not available`);
  const plain = decryptSecret(ring, ciphertext, { tenantId: tenant_id, purpose: CONNECTION_SECRET_PURPOSE }).toString('utf8');
  return JSON.parse(plain) as Record<string, unknown>;
}
