/**
 * Identity, sessions and agent keys over HTTP.
 * Covers: AUTH-02 (no default admin, one-time protected bootstrap, CSRF/session misuse, throttling),
 * LOCAL-01 (setup twice/concurrently → one owner; HTTP visitor cannot claim first-admin rights; key
 * shown once, verifier only), LOCAL-02 (wrong keys, cookie flags, idle/absolute expiry, logout,
 * rotation invalidates old key + sessions, origin rejection), LOCAL-03 (host-only reset; anonymous
 * HTTP reset impossible), LOCAL-04 (agent keys: separate principals, owner key never accepted as
 * agent credential, write/admin/ingest routes denied, revoke denies within 5 s incl. SSE),
 * LOCAL-05 (loopback only: HOST≠127.0.0.1 refused, forged Host/Origin rejected, no-key calls denied).
 */
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@blackbox/api";
import { AuthService, generateOwnerKey } from "@blackbox/auth";
import { createSilentLogger } from "@blackbox/logging";
import http from "node:http";
import { ApiClient, SUPERUSER_URL, startTestApp, wait, type TestApp } from "@blackbox/testing";

function rawStatus(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers, setHost: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

let app: TestApp;
let owner: { key: string; tenant_id: string; principal_id: string };

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await app?.stop();
});

describe("LOCAL-01 / AUTH-02 bootstrap", () => {
  it("has no default admin: nothing authenticates before setup and no HTTP route creates the owner", async () => {
    const c = new ApiClient(app.baseUrl);
    expect((await c.get("/api/auth/session")).status).toBe(401);
    expect((await c.get("/api/workspace")).status).toBe(401);
    expect((await c.request("POST", "/api/auth/login", { key: "bbk_" + "A".repeat(43), remember: false }, { origin: app.baseUrl })).status).toBe(401);
    expect((await c.post("/api/setup", { name: "takeover" })).status).toBe(404);
    expect((await c.post("/api/auth/setup", {})).status).toBe(404);
  });

  it("setup runs once even when called concurrently; later runs are idempotent and keep the owner", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => app.built.ctx.auth.setup({ displayName: "Studio Nord" })));
    const created = results.filter((r) => r.status === "created");
    expect(created).toHaveLength(1);
    owner = created[0] as typeof owner;
    expect(owner.key).toMatch(/^bbk_[A-Za-z0-9_-]{43}$/);
    const again = await app.built.ctx.auth.setup({ displayName: "Other" });
    expect(again).toEqual({ status: "already_initialized", tenant_id: owner.tenant_id });
    // Only a verifier is persisted; the key material never reaches the database or logs.
    const c = new pg.Client({ connectionString: SUPERUSER_URL.replace(/\/postgres$/, `/${app.db.name}`) }); // superuser bypasses forced RLS for inspection
    await c.connect();
    try {
      const rows = await c.query<{ verifier: string; prefix: string }>("SELECT verifier, prefix FROM credentials");
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.verifier.startsWith("$argon2id$")).toBe(true);
      expect(rows.rows[0]!.verifier).not.toContain(owner.key.slice(12));
      const owners = await c.query("SELECT count(*)::int AS n FROM principals WHERE kind = 'owner'");
      expect(owners.rows[0].n).toBe(1);
    } finally {
      await c.end();
    }
    const logs = readFileSync(path.join(app.install.logsDir, (await import("node:fs")).readdirSync(app.install.logsDir).find((f) => f.endsWith(".jsonl"))!), "utf8");
    expect(logs).not.toContain(owner.key.slice(4));
  });
});

describe("LOCAL-02 login, sessions, rotation", () => {
  it("rejects wrong keys without revealing partial matches and throttles after 5 failures", async () => {
    const c = new ApiClient(app.baseUrl);
    const wrong = owner.key.slice(0, -2) + "zz";
    for (let i = 0; i < 5; i += 1) {
      const r = await c.request("POST", "/api/auth/login", { key: i === 0 ? wrong : generateOwnerKey(), remember: false }, { origin: app.baseUrl, "user-agent": "throttle-test" });
      expect(r.status).toBe(401);
      expect((r.json as { error: { message: string } }).error.message).toBe("The access key is not valid");
    }
    const throttled = await c.request("POST", "/api/auth/login", { key: owner.key, remember: false }, { origin: app.baseUrl, "user-agent": "throttle-test" });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBeTruthy();
    // A different client is not affected.
    const other = new ApiClient(app.baseUrl);
    await other.login(owner.key);
    expect(other.csrf).toBeTruthy();
  });

  it("sets HttpOnly SameSite=Lax cookies; session cookie for ordinary logins, Max-Age for remembered ones", async () => {
    const res = await fetch(`${app.baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: app.baseUrl }, body: JSON.stringify({ key: owner.key, remember: false }) });
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^bb_session=[A-Za-z0-9_-]{43}; /);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Max-Age|Expires/);
    const remembered = await fetch(`${app.baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: app.baseUrl }, body: JSON.stringify({ key: owner.key, remember: true }) });
    expect(remembered.headers.get("set-cookie")).toMatch(/Max-Age=2592000/);
  });

  it("enforces exact Origin/Host and the CSRF header on state-changing owner requests", async () => {
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    const ok = await c.patch("/api/workspace", { display_name: "Studio Nord" });
    expect(ok.status).toBe(200);
    const noCsrf = await c.request("PATCH", "/api/workspace", { display_name: "x" }, { origin: app.baseUrl, "x-blackbox-csrf": "wrong" });
    expect(noCsrf.status).toBe(403);
    const badOrigin = await c.request("PATCH", "/api/workspace", { display_name: "x" }, { origin: "http://evil.example", "x-blackbox-csrf": c.csrf! });
    expect(badOrigin.status).toBe(403);
    const lookalike = await c.request("PATCH", "/api/workspace", { display_name: "x" }, { origin: `${app.baseUrl}.evil.example`, "x-blackbox-csrf": c.csrf! });
    expect(lookalike.status).toBe(403);
    // fetch() cannot forge Host; use a raw HTTP request (DNS rebinding / forged Host simulation).
    expect(await rawStatus(app.port, "/api/workspace", { host: "evil.example:80", cookie: c.cookie! })).toBe(403);
    expect(await rawStatus(app.port, "/api/workspace", { host: `127.0.0.1.evil.example:${app.port}`, cookie: c.cookie! })).toBe(403);
    expect(await rawStatus(app.port, "/api/workspace", { host: `127.0.0.1:${app.port}`, cookie: c.cookie! })).toBe(200);
    expect(await rawStatus(app.port, "/api/health", { host: "evil.example" })).toBe(403);
    const loginBadOrigin = await fetch(`${app.baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: "http://attacker.example" }, body: JSON.stringify({ key: owner.key, remember: false }) });
    expect(loginBadOrigin.status).toBe(403);
    const ws = await c.get("/api/workspace");
    expect((ws.json as { display_name: string }).display_name).toBe("Studio Nord");
  });

  it("expires sessions by idle/absolute deadlines (server clock) and revokes on logout", async () => {
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    const hash = (await import("@blackbox/auth")).hashSessionId(c.cookie!.replace("bb_session=", ""));
    const mig = new pg.Client({ connectionString: SUPERUSER_URL.replace(/\/postgres$/, `/${app.db.name}`) });
    await mig.connect();
    try {
      const row = await mig.query<{ absolute_expires_at: Date; idle_expires_at: Date; created_at: Date }>("SELECT absolute_expires_at, idle_expires_at, created_at FROM sessions WHERE session_hash = $1", [hash]);
      expect(row.rows[0]!.absolute_expires_at.getTime() - row.rows[0]!.created_at.getTime()).toBeLessThanOrEqual(8 * 3600 * 1000 + 1000);
      await mig.query("UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE session_hash = $1", [hash]);
      expect((await c.get("/api/auth/session")).status).toBe(401);
      await mig.query("UPDATE sessions SET idle_expires_at = now() + interval '1 hour', absolute_expires_at = now() - interval '1 second' WHERE session_hash = $1", [hash]);
      expect((await c.get("/api/auth/session")).status).toBe(401);
    } finally {
      await mig.end();
    }
    const d = new ApiClient(app.baseUrl);
    await d.login(owner.key, true);
    expect((await d.post("/api/auth/logout")).status).toBe(204);
    d.cookie = d.cookie ?? null;
    expect((await d.get("/api/auth/session")).status).toBe(401);
  });

  it("rotation needs the current key, invalidates it and all owner sessions, and the new key logs in", async () => {
    const a = new ApiClient(app.baseUrl);
    const b = new ApiClient(app.baseUrl);
    await a.login(owner.key);
    await b.login(owner.key);
    expect((await a.post("/api/auth/rotate-key", { current_key: generateOwnerKey() })).status).toBe(401);
    const rot = await a.post("/api/auth/rotate-key", { current_key: owner.key });
    expect(rot.status).toBe(200);
    const newKey = (rot.json as { new_key: string }).new_key;
    expect(newKey).toMatch(/^bbk_/);
    expect((await b.get("/api/auth/session")).status).toBe(401);
    expect((await a.get("/api/workspace")).status).toBe(401);
    const old = new ApiClient(app.baseUrl);
    expect((await old.request("POST", "/api/auth/login", { key: owner.key, remember: false }, { origin: app.baseUrl, "user-agent": "rot" })).status).toBe(401);
    const fresh = new ApiClient(app.baseUrl);
    await fresh.login(newKey);
    expect((await fresh.get("/api/workspace")).status).toBe(200);
    owner.key = newKey;
  });
});

describe("LOCAL-04 agent keys", () => {
  let agentKey: string;
  let credentialId: string;

  it("creates separate agent principals with read-only grants; owner keys are not agent credentials", async () => {
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    const created = await c.post("/api/agents", { name: "Reviewer agent" });
    expect(created.status).toBe(201);
    agentKey = (created.json as { key: string }).key;
    credentialId = (created.json as { credential_id: string }).credential_id;
    expect(agentKey).toMatch(/^bba_[A-Za-z0-9_-]{43}$/);
    const second = await c.post("/api/agents", { name: "Second agent" });
    expect(second.status).toBe(201);
    const list = (await c.get("/api/agents")).json as Array<{ name: string; status: string; grant: string }>;
    expect(list.map((x) => x.name).sort()).toEqual(["Reviewer agent", "Second agent"]);
    expect(list.every((x) => x.grant === "workspace.read_business")).toBe(true);
    const agent = new ApiClient(app.baseUrl);
    agent.bearer = agentKey;
    expect((await agent.get("/api/workspace")).status).toBe(200);
    expect((await agent.get("/api/journal")).status).toBe(200);
    expect((await agent.get("/api/questions")).status).toBe(200);
    expect((await agent.post("/api/questions/invoices.outstanding", { params: {} })).status).toBe(200);
    // denied: admin, write, ingestion, auth tables, diagnostics
    expect((await agent.get("/api/agents")).status).toBe(403);
    expect((await agent.post("/api/ingest/replay", { connection_id: "00000000-0000-4000-8000-000000000000", events: [] })).status).toBe(403);
    expect((await agent.post("/api/demo/run", {})).status).toBe(403);
    expect((await agent.post("/api/sources/connections", { provider: "replay", display_name: "x" })).status).toBe(403);
    expect((await agent.patch("/api/workspace", { display_name: "x" })).status).toBe(403);
    expect((await agent.post("/api/review/cases/00000000-0000-4000-8000-000000000000/actions", { action: "retry", revision: 1, reason: "nope" })).status).toBe(403);
    expect((await agent.get("/api/diagnostics/logs")).status).toBe(403);
    expect((await agent.get("/api/settings/security")).status).toBe(403);
    expect((await agent.get("/api/auth/session")).status).toBe(403);
    const ownerAsBearer = new ApiClient(app.baseUrl);
    ownerAsBearer.bearer = owner.key;
    expect((await ownerAsBearer.get("/api/workspace")).status).toBe(401);
    const sessionAsBearer = new ApiClient(app.baseUrl);
    sessionAsBearer.bearer = c.cookie!.replace("bb_session=", "");
    expect((await sessionAsBearer.get("/api/workspace")).status).toBe(401);
  });

  it("revocation denies new requests immediately and stops an open stream within 5 s; the other key stays active", async () => {
    const c = new ApiClient(app.baseUrl);
    await c.login(owner.key);
    const other = ((await c.get("/api/agents")).json as Array<{ credential_id: string; name: string }>).find((x) => x.name === "Second agent")!;
    const otherKey = (await c.post("/api/agents", { name: "Third agent" })).json as { key: string };
    // Open an owner SSE stream to prove revocation of the owner session stops it within 5 s.
    const streamClient = new ApiClient(app.baseUrl);
    await streamClient.login(owner.key);
    const controller = new AbortController();
    const streamRes = await fetch(`${app.baseUrl}/api/diagnostics/logs/stream`, { headers: { cookie: streamClient.cookie! }, signal: controller.signal });
    expect(streamRes.status).toBe(200);
    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const ended = (async () => {
      const started = Date.now();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return Date.now() - started;
        received += decoder.decode(value);
        if (received.includes("event: end")) return Date.now() - started;
      }
    })();
    await wait(300);
    expect(received).toContain("event: ready");
    const revokedAt = Date.now();
    await streamClient.post("/api/auth/logout");
    const elapsed = await Promise.race([ended, wait(6000).then(() => -1)]);
    expect(elapsed, "stream must end within 5 s of revocation").not.toBe(-1);
    expect(Date.now() - revokedAt).toBeLessThanOrEqual(5000);
    expect(received).toContain("unauthorized");
    controller.abort();
    // Agent key revocation
    expect((await c.post(`/api/agents/${credentialId}/revoke`)).status).toBe(204);
    const revoked = new ApiClient(app.baseUrl);
    revoked.bearer = agentKey;
    const started = Date.now();
    expect((await revoked.get("/api/journal")).status).toBe(401);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await revoked.get("/api/evidence/00000000-0000-4000-8000-000000000000")).status).toBe(401);
    const third = new ApiClient(app.baseUrl);
    third.bearer = otherKey.key;
    expect((await third.get("/api/journal")).status).toBe(200);
    expect((await c.post(`/api/agents/${other.credential_id}/revoke`)).status).toBe(204);
    expect((await c.post(`/api/agents/${credentialId}/revoke`)).status).toBe(204); // idempotent on already revoked
    expect((await c.post(`/api/agents/00000000-0000-4000-8000-000000000000/revoke`)).status).toBe(404);
    const list = (await c.get("/api/agents")).json as Array<{ name: string; status: string }>;
    expect(list.find((x) => x.name === "Reviewer agent")!.status).toBe("revoked");
    // Expired keys are rejected
    const expired = await c.post("/api/agents", { name: "Expiring", expires_at: new Date(Date.now() + 3000).toISOString() });
    expect(expired.status).toBe(201);
    const e = new ApiClient(app.baseUrl);
    e.bearer = (expired.json as { key: string }).key;
    expect((await e.get("/api/workspace")).status).toBe(200);
    await wait(3200);
    expect((await e.get("/api/workspace")).status).toBe(401);
  });
});

describe("LOCAL-03 host-only reset", () => {
  it("is impossible over HTTP and requires read access to the secrets directory on the host", async () => {
    const c = new ApiClient(app.baseUrl);
    expect((await c.post("/api/auth/reset", {})).status).toBe(404);
    expect((await c.post("/api/auth/reset-access", {})).status).toBe(404);
    const noAccessDir = path.join(app.install.root, "missing-secrets");
    mkdirSync(noAccessDir, { recursive: true });
    const blocked = new AuthService({ pool: app.pool, logger: createSilentLogger(), secretsDir: noAccessDir });
    await expect(blocked.resetAccess()).rejects.toMatchObject({ code: "host_access_required" });
    const session = new ApiClient(app.baseUrl);
    await session.login(owner.key);
    const agent = await session.post("/api/agents", { name: "Pre-reset agent" });
    const agentClient = new ApiClient(app.baseUrl);
    agentClient.bearer = (agent.json as { key: string }).key;
    expect((await agentClient.get("/api/workspace")).status).toBe(200);
    const r = await app.built.ctx.auth.resetAccess();
    expect(r.key).toMatch(/^bbk_/);
    expect(r.key).not.toBe(owner.key);
    expect((await session.get("/api/auth/session")).status).toBe(401);
    expect((await agentClient.get("/api/workspace")).status).toBe(401);
    const old = new ApiClient(app.baseUrl);
    expect((await old.request("POST", "/api/auth/login", { key: owner.key, remember: false }, { origin: app.baseUrl, "user-agent": "reset" })).status).toBe(401);
    const fresh = new ApiClient(app.baseUrl);
    await fresh.login(r.key);
    const ws = (await fresh.get("/api/workspace")).json as { display_name: string; tenant_id: string };
    expect(ws.tenant_id).toBe(owner.tenant_id); // business data and workspace preserved
    const security = (await fresh.get("/api/settings/security")).json as { counts: Record<string, number> };
    expect(security.counts["owner.access_reset"]).toBe(1);
    owner.key = r.key;
    rmSync(noAccessDir, { recursive: true, force: true });
  });
});

describe("LOCAL-05 loopback only", () => {
  it("refuses any HOST other than 127.0.0.1 and rejects credential-less calls", async () => {
    const base = { DATABASE_URL: "postgres://x", SECRETS_DIR: "/s", EVIDENCE_DIR: "/e", LOGS_DIR: "/l" };
    expect(() => loadConfig({ ...base, HOST: "0.0.0.0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, HOST: "0.0.0.0" })).toThrow(/unsupported/);
    expect(() => loadConfig({ ...base, HOST: "::" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, HOST: "192.168.1.10" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, HOST: "localhost" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
    expect(loadConfig({ ...base }).port).toBe(19180);
    const anon = new ApiClient(app.baseUrl);
    for (const url of ["/api/journal", "/api/schema", "/api/questions", "/api/sources", "/api/evidence/00000000-0000-4000-8000-000000000000", "/api/diagnostics/health", "/api/agents", "/api/settings/backups"]) {
      expect((await anon.get(url)).status, url).toBe(401);
    }
    expect((await anon.post("/api/questions/invoices.outstanding", { params: {} })).status).toBe(401);
    // The listener is bound to 127.0.0.1 only (not reachable through other interfaces).
    const addr = app.built.app.server.address();
    expect(typeof addr === "object" && addr?.address).toBe("127.0.0.1");
  });
});
