import type { FastifyReply, FastifyRequest } from "fastify";
import { CSRF_HEADER, SESSION_COOKIE, hostAllowed, originAllowed, safeEqual } from "@blackbox/auth";
import type { AppContext } from "./context.js";
import { forbidden, HttpError, unauthenticated } from "./context.js";

/**
 * Authentication/authorization guards. Every request re-reads credential/session state from
 * PostgreSQL (no status cache), so revocation is effective on the next request. Localhost and a
 * payload tenant_id never grant anything: the tenant comes from the verified principal only.
 */
export function createGuards(ctx: AppContext) {
  async function authenticate(request: FastifyRequest): Promise<void> {
    if (request.auth !== null && request.auth !== undefined) return;
    request.auth = null;
    const cookie = request.cookies?.[SESSION_COOKIE];
    if (cookie) {
      const session = await ctx.auth.authenticateSession(cookie);
      if (session) {
        request.auth = { kind: "owner", session, sessionId: cookie };
        return;
      }
    }
    const header = request.headers.authorization;
    if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
      const agent = await ctx.auth.authenticateAgentKey(header.slice(7).trim());
      if (agent) {
        request.auth = { kind: "agent", agent };
        ctx.runtime.mcpLastRequestAt = new Date().toISOString();
      }
    }
  }

  function checkHost(request: FastifyRequest): void {
    if (!hostAllowed(request.headers.host, ctx.config.port)) {
      ctx.logger.warn("auth.host_rejected", "Request rejected: Host header is not the loopback origin", { error_code: "host_not_allowed", trace_id: request.traceId });
      throw forbidden("Host header is not allowed");
    }
  }

  /** State-changing owner requests need an exact Origin and the CSRF double-submit header. */
  function checkCsrf(request: FastifyRequest): void {
    if (request.auth?.kind !== "owner") return;
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const origin = request.headers.origin;
    if (!originAllowed(typeof origin === "string" ? origin : undefined, ctx.config.port)) {
      ctx.logger.warn("auth.origin_rejected", "State-changing request rejected: Origin missing or not allowlisted", { error_code: "origin_not_allowed", tenant_id: request.auth.session.principal.tenant_id, trace_id: request.traceId });
      throw forbidden("Origin is not allowed");
    }
    const token = request.headers[CSRF_HEADER];
    if (typeof token !== "string" || !safeEqual(token, request.auth.session.csrf_token)) {
      ctx.logger.warn("auth.csrf_rejected", "State-changing request rejected: CSRF token missing or invalid", { error_code: "csrf_invalid", tenant_id: request.auth.session.principal.tenant_id, trace_id: request.traceId });
      throw forbidden("CSRF token missing or invalid");
    }
  }

  async function requireOwner(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    checkHost(request);
    await authenticate(request);
    if (!request.auth) throw unauthenticated();
    if (request.auth.kind !== "owner") {
      ctx.logger.warn("auth.access_denied", "Agent credential used on an owner-only route", { error_code: "owner_required", tenant_id: request.auth.agent.principal.tenant_id, trace_id: request.traceId });
      throw forbidden("owner session required");
    }
    checkCsrf(request);
  }

  /** Routes marked (A): owner session or read-only agent key. Agents are GET-only. */
  async function requireRead(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    checkHost(request);
    await authenticate(request);
    if (!request.auth) throw unauthenticated();
    if (request.auth.kind === "agent" && request.method !== "GET" && !request.routeOptions.config?.agentPost) {
      ctx.logger.warn("auth.access_denied", "Agent credential attempted a write operation", { error_code: "read_only_grant", tenant_id: request.auth.agent.principal.tenant_id, trace_id: request.traceId });
      throw forbidden("agent keys are read-only");
    }
    checkCsrf(request);
  }

  function tenantOf(request: FastifyRequest): string {
    if (!request.auth) throw unauthenticated();
    return request.auth.kind === "owner" ? request.auth.session.principal.tenant_id : request.auth.agent.principal.tenant_id;
  }

  function principalOf(request: FastifyRequest): { id: string; kind: "owner" | "agent" } {
    if (!request.auth) throw unauthenticated();
    return request.auth.kind === "owner" ? { id: request.auth.session.principal.principal_id, kind: "owner" } : { id: request.auth.agent.principal.principal_id, kind: "agent" };
  }

  /** Re-check used by long-lived streams (SSE): false once the session/key is revoked or expired. */
  async function stillAuthorized(request: FastifyRequest): Promise<boolean> {
    if (!request.auth) return false;
    try {
      if (request.auth.kind === "owner") return await ctx.auth.isSessionStillValid(request.auth.session.session_hash);
      return await ctx.auth.isCredentialStillValid(request.auth.agent.credential_id);
    } catch {
      return false; // fail closed when state cannot be verified
    }
  }

  function requireIngestionReady(): void {
    if (!ctx.ingestion) throw new HttpError(503, ctx.dataKeyError?.code ?? "data_key_unavailable", `${ctx.dataKeyError?.message ?? "installation data key unavailable"}. ${ctx.dataKeyError?.action ?? ""}`.trim(), { retryable: false });
  }

  return { authenticate, requireOwner, requireRead, tenantOf, principalOf, stillAuthorized, checkHost, requireIngestionReady };
}

export type Guards = ReturnType<typeof createGuards>;

declare module "fastify" {
  interface FastifyContextConfig {
    agentPost?: boolean;
  }
}
