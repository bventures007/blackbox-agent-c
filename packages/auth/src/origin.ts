/**
 * Exact Origin/Host allowlist for the loopback profile (IDENTITY-ACCESS-AND-RECOVERY.md).
 * CORS is not authentication: a request with a forged or unexpected Origin/Host is rejected
 * before any session cookie is honoured on a state-changing route.
 */
export function buildAllowedOrigins(port: number): Set<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

export function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

/** For non-GET owner routes: Origin must be present and exactly allowlisted (or Sec-Fetch-Site: same-origin without Origin for non-browser clients is NOT accepted). */
export function originAllowed(originHeader: string | undefined, port: number): boolean {
  if (!originHeader) return false;
  return buildAllowedOrigins(port).has(originHeader);
}
