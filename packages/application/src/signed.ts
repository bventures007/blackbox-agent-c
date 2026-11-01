import { createHmac, createHash, timingSafeEqual, randomBytes } from "node:crypto";
import type { Pool, TenantClient } from "@blackbox/database";
import { withAuthenticator, withTenant } from "@blackbox/database";
import { decryptSecret, encryptSecret, type DataKey } from "@blackbox/auth";

export const SIGNED_INPUT_WINDOW_SECONDS = 300; // ±5 minutes
export const PRODUCER_SECRET_PURPOSE = "producer_secret";

export class SignedInputError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "SignedInputError";
    this.code = code;
    this.status = status;
  }
}

export function signProducerBody(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Timestamp: unix seconds or RFC3339; must be within ±5 min of `now`. */
export function parseProducerTimestamp(raw: string, now: Date): number {
  let ms: number;
  if (/^\d{9,13}$/.test(raw)) ms = raw.length > 10 ? Number(raw) : Number(raw) * 1000;
  else ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new SignedInputError("invalid_timestamp", 401, "X-Producer-Timestamp must be unix seconds or RFC3339");
  if (Math.abs(now.getTime() - ms) > SIGNED_INPUT_WINDOW_SECONDS * 1000) throw new SignedInputError("timestamp_out_of_window", 401, "X-Producer-Timestamp is outside the ±5 minute window");
  return ms;
}

export interface VerifiedProducer {
  producer_id: string;
  tenant_id: string;
  connection_id: string;
}

/**
 * Generic signed input: producer secrets are encrypted at rest with the installation data key
 * (AAD tenant|producer_secret|key_version). Verification is constant-time; each signature is
 * accepted once (producer_nonces) within the time window — a replay is rejected even with a
 * valid signature. The producer is bound to one connection; a body naming another connection or
 * tenant is rejected.
 */
export class SignedInputService {
  constructor(
    private readonly pool: Pool,
    private readonly dataKey: DataKey,
  ) {}

  async createProducer(c: TenantClient, tenantId: string, connectionId: string, displayName: string): Promise<{ producer_id: string; secret: string }> {
    const secret = "bbp_" + randomBytes(32).toString("base64url");
    const r = await c.query<{ producer_id: string }>("INSERT INTO producer_credentials (tenant_id, connection_id, display_name, secret_ciphertext, secret_key_version) VALUES ($1,$2,$3,$4,$5) RETURNING producer_id", [
      tenantId,
      connectionId,
      displayName,
      Buffer.alloc(0),
      this.dataKey.version,
    ]);
    const producerId = r.rows[0]!.producer_id;
    const ciphertext = encryptSecret(this.dataKey, secret, { tenantId, purpose: PRODUCER_SECRET_PURPOSE });
    await c.query("UPDATE producer_credentials SET secret_ciphertext = $2 WHERE producer_id = $1", [producerId, ciphertext]);
    return { producer_id: producerId, secret };
  }

  async verify(input: { producerId: string; timestamp: string; signature: string; rawBody: string; now?: Date }): Promise<VerifiedProducer> {
    const now = input.now ?? new Date();
    if (!/^[0-9a-f-]{36}$/i.test(input.producerId)) throw new SignedInputError("unknown_producer", 401, "producer not recognised");
    if (!/^[0-9a-f]{64}$/i.test(input.signature)) throw new SignedInputError("invalid_signature", 401, "signature must be hex HMAC-SHA256");
    parseProducerTimestamp(input.timestamp, now);
    const producer = await this.lookupViaTenant(input.producerId);
    if (!producer || producer.status !== "active") throw new SignedInputError("unknown_producer", 401, "producer not recognised");
    if (producer.connection_status === "disconnected") throw new SignedInputError("connection_disconnected", 409, "connection is disconnected");
    const secret = decryptSecret(this.dataKey, producer.secret_ciphertext, { tenantId: producer.tenant_id, purpose: PRODUCER_SECRET_PURPOSE }).toString("utf8");
    const expected = signProducerBody(secret, input.timestamp, input.rawBody);
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(input.signature.toLowerCase(), "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new SignedInputError("invalid_signature", 401, "signature does not match");
    const sigHash = createHash("sha256").update(input.signature.toLowerCase()).digest("hex");
    const fresh = await withTenant(this.pool, producer.tenant_id, async (c) => {
      await c.query("DELETE FROM producer_nonces WHERE producer_id = $1 AND seen_at < now() - interval '15 minutes'", [input.producerId]);
      const ins = await c.query("INSERT INTO producer_nonces (producer_id, tenant_id, signature_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [input.producerId, producer.tenant_id, sigHash]);
      await c.query("UPDATE producer_credentials SET last_used_at = now() WHERE producer_id = $1", [input.producerId]);
      return (ins.rowCount ?? 0) > 0;
    });
    if (!fresh) throw new SignedInputError("replayed", 409, "this signed delivery was already accepted");
    return { producer_id: producer.producer_id, tenant_id: producer.tenant_id, connection_id: producer.connection_id };
  }

  private async lookupViaTenant(producerId: string): Promise<{ producer_id: string; tenant_id: string; connection_id: string; secret_ciphertext: Buffer; status: string; connection_status: string } | null> {
    const base = await withAuthenticator(this.pool, async (c) => {
      const r = await c.query<{ producer_id: string; tenant_id: string; connection_id: string; secret_ciphertext: Buffer; status: string }>("SELECT producer_id, tenant_id, connection_id, secret_ciphertext, status FROM producer_credentials WHERE producer_id = $1", [producerId]);
      return r.rows[0] ?? null;
    });
    if (!base) return null;
    const conn = await withTenant(this.pool, base.tenant_id, async (c) => {
      const r = await c.query<{ status: string }>("SELECT status FROM connections WHERE connection_id = $1", [base.connection_id]);
      return r.rows[0] ?? null;
    });
    if (!conn) return null;
    return { ...base, connection_status: conn.status };
  }
}
