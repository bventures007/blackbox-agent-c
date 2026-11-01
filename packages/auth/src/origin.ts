/**
 * Exact Origin/Host allowlist for the loopback profile (IDENTITY-ACCESS-AND-RECOVERY.md).
 * CORS is not authentication: a request with a forged or unexpected Origin/Host is rejected
 * before any session cookie is honoured on a state-changing route.
 *
 * `ports` is the listener port plus, inside the Compose container, the port Docker publishes on
 * the host loopback (`./blackbox setup --port N`): the browser sends `Host: 127.0.0.1:N` while the
 * in-container health probe sends the listener port. Both are loopback-only by construction.
 */
function portList(ports: number | readonly number[]): number[] {
  return [...new Set(Array.isArray(ports) ? ports : [ports as number])];
}

export function buildAllowedOrigins(ports: number | readonly number[]): Set<string> {
  return new Set(portList(ports).flatMap((port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]));
}

export function hostAllowed(hostHeader: string | undefined, ports: number | readonly number[]): boolean {
  if (!hostHeader) return false;
  return portList(ports).some((port) => hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`);
}

/** For non-GET owner routes: Origin must be present and exactly allowlisted (or Sec-Fetch-Site: same-origin without Origin for non-browser clients is NOT accepted). */
export function originAllowed(originHeader: string | undefined, ports: number | readonly number[]): boolean {
  if (!originHeader) return false;
  return buildAllowedOrigins(ports).has(originHeader);
}
