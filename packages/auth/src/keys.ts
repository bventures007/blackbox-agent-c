import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

export const OWNER_KEY_PREFIX = "bbk_";
export const AGENT_KEY_PREFIX = "bba_";
const KEY_BODY_RE = /^[A-Za-z0-9_-]{43}$/;

export type KeyKind = "owner" | "agent";

export interface ParsedKey {
  kind: KeyKind;
  /** First 8 characters of the random part: used only to locate candidate credential rows. */
  lookupPrefix: string;
  key: string;
}

/** 32 random bytes → 43 base64url characters (256 bits of entropy). */
function randomKeyBody(): string {
  return randomBytes(32).toString("base64url");
}

export function generateOwnerKey(): string {
  return OWNER_KEY_PREFIX + randomKeyBody();
}

export function generateAgentKey(): string {
  return AGENT_KEY_PREFIX + randomKeyBody();
}

export function parseKey(input: unknown): ParsedKey | null {
  if (typeof input !== "string") return null;
  const key = input.trim();
  let kind: KeyKind;
  if (key.startsWith(OWNER_KEY_PREFIX)) kind = "owner";
  else if (key.startsWith(AGENT_KEY_PREFIX)) kind = "agent";
  else return null;
  const body = key.slice(4);
  if (!KEY_BODY_RE.test(body)) return null;
  return { kind, lookupPrefix: body.slice(0, 8), key };
}

/** argon2id verifier (maintained library; parameters: 64 MiB, t=3, p=1). */
export async function hashKey(key: string): Promise<string> {
  return argon2.hash(key, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}

export async function verifyKey(verifier: string, key: string): Promise<boolean> {
  try {
    return await argon2.verify(verifier, key);
  } catch {
    return false;
  }
}

/** Session ids are opaque 256-bit values; only the SHA-256 is stored. */
export function generateSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Opaque per-client throttle key (loopback IP + user agent hash); never stored in plain form. */
export function clientThrottleKey(ip: string, userAgent: string | undefined): string {
  return createHash("sha256").update(`${ip}|${userAgent ?? ""}`).digest("hex").slice(0, 32);
}
