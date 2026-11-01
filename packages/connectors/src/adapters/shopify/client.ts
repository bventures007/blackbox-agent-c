/**
 * Shopify GraphQL Admin API client.
 *
 * - Pinned API version (SHOPIFY_API_VERSION); endpoint {base}/admin/api/{version}/graphql.json
 * - Authentication: a merchant-generated Admin API access token (existing admin custom apps) or the
 *   Dev Dashboard client-credentials grant (POST /admin/oauth/access_token, 24h tokens, no redirect).
 * - Cost-based throttling from extensions.cost.throttleStatus; waits for restore before a request
 *   that would exceed the available points; honours HTTP 429 + Retry-After and THROTTLED errors.
 * - Bounded retries with backoff for 5xx/network; 401/403 are credential errors (never retried).
 */
import { CredentialError, CursorExpiredError, ProviderUnavailableError, ThrottledError } from '../../types.js';

export const SHOPIFY_API_VERSION = '2026-10';

export type ShopifyAuth =
  | { type: 'admin_token'; access_token: string }
  | { type: 'client_credentials'; client_id: string; client_secret: string };

export interface ShopifyClientConfig {
  /** e.g. "example.myshopify.com" */
  shop_domain: string;
  auth: ShopifyAuth;
  /** Override for the provider-shaped local fixture (http://127.0.0.1:19182). Production: https://{shop_domain}. */
  base_url?: string;
  api_version?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  max_retries?: number;
  /** Estimated cost of the heaviest query; used to wait for restore before sending. */
  estimated_cost?: number;
  /** Upper bound for a single throttle wait. */
  max_wait_ms?: number;
  now?: () => number;
}

export interface ThrottleStatus { currently_available: number; maximum_available: number; restore_rate: number }

export interface GraphqlResult<T> { data: T; throttle: ThrottleStatus | null; requested_cost: number | null; actual_cost: number | null }

export class ProviderError extends Error {
  readonly code = 'provider_error';
  readonly retryable = false;
  constructor(message: string, readonly errors: unknown[]) { super(message); }
}

export class ShopifyGraphqlClient {
  readonly api_version: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly estimatedCost: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private throttle: ThrottleStatus | null = null;
  private throttleObservedAt = 0;
  private token: { value: string; expires_at: number } | null = null;
  /** Counters for health/logging (never secrets). */
  readonly stats = { requests: 0, throttled_waits: 0, retry_after_waits: 0, retries: 0, total_actual_cost: 0 };

  constructor(private readonly cfg: ShopifyClientConfig) {
    this.api_version = cfg.api_version ?? SHOPIFY_API_VERSION;
    this.base = (cfg.base_url ?? `https://${cfg.shop_domain}`).replace(/\/$/, '');
    this.fetchImpl = cfg.fetch ?? fetch;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = cfg.max_retries ?? 5;
    this.estimatedCost = cfg.estimated_cost ?? 500;
    this.maxWaitMs = cfg.max_wait_ms ?? 30_000;
    this.now = cfg.now ?? (() => Date.now());
    if (cfg.auth.type === 'admin_token') this.token = { value: cfg.auth.access_token, expires_at: Number.POSITIVE_INFINITY };
  }

  get lastThrottle(): ThrottleStatus | null { return this.throttle; }

  private url(path: string): string {
    const [base, query] = this.base.split('?');
    return `${base}${path}${query ? `?${query}` : ''}`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires_at - this.now() > 60_000) return this.token.value;
    const auth = this.cfg.auth;
    if (auth.type !== 'client_credentials') throw new CredentialError('token_expired', 'admin token missing');
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: auth.client_id, client_secret: auth.client_secret });
    const res = await this.fetchImpl(this.url('/admin/oauth/access_token'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    if (res.status === 401 || res.status === 403 || res.status === 400) throw new CredentialError('unauthorized', `client credentials grant rejected (${res.status})`);
    if (!res.ok) throw new ProviderUnavailableError(`token endpoint ${res.status}`, null, res.status);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new CredentialError('unauthorized', 'token response without access_token');
    this.token = { value: json.access_token, expires_at: this.now() + (json.expires_in ?? 86399) * 1000 };
    return this.token.value;
  }

  /** Wait until the leaky bucket has restored enough points for the estimated cost. */
  private async waitForBudget(): Promise<void> {
    if (!this.throttle) return;
    const elapsedS = (this.now() - this.throttleObservedAt) / 1000;
    const available = Math.min(this.throttle.maximum_available, this.throttle.currently_available + elapsedS * this.throttle.restore_rate);
    const need = Math.min(this.estimatedCost, this.throttle.maximum_available);
    if (available >= need) return;
    const waitMs = Math.min(this.maxWaitMs, Math.ceil(((need - available) / Math.max(this.throttle.restore_rate, 1)) * 1000));
    this.stats.throttled_waits++;
    await this.sleep(waitMs);
  }

  async request<T>(operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<GraphqlResult<T>> {
    let attempt = 0;
    for (;;) {
      await this.waitForBudget();
      const token = await this.accessToken();
      this.stats.requests++;
      let res: Response;
      try {
        res = await this.fetchImpl(this.url(`/admin/api/${this.api_version}/graphql.json`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ query, variables, operationName }),
        });
      } catch (err) {
        if (attempt++ < this.maxRetries) { this.stats.retries++; await this.sleep(backoff(attempt)); continue; }
        throw new ProviderUnavailableError(`network error: ${(err as Error).message}`, null, null);
      }
      if (res.status === 401) {
        if (this.cfg.auth.type === 'client_credentials' && this.token && attempt++ < 1) { this.token = null; continue; }
        throw new CredentialError('unauthorized', 'provider rejected the access token (401)');
      }
      if (res.status === 403) throw new CredentialError('forbidden', 'provider refused access (403): missing scope or app not installed');
      if (res.status === 429) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after')) ?? 1000;
        if (attempt++ < this.maxRetries) { this.stats.retry_after_waits++; await this.sleep(Math.min(retryAfterMs, this.maxWaitMs)); continue; }
        throw new ThrottledError('provider throttled after retries (429)', retryAfterMs);
      }
      if (res.status >= 500 || res.status === 408) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        if (attempt++ < this.maxRetries) { this.stats.retries++; await this.sleep(retryAfterMs ?? backoff(attempt)); continue; }
        throw new ProviderUnavailableError(`provider unavailable (${res.status})`, retryAfterMs, res.status);
      }
      if (!res.ok) throw new ProviderError(`unexpected status ${res.status}`, []);
      const json = (await res.json()) as { data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }>; extensions?: { cost?: { requestedQueryCost?: number; actualQueryCost?: number; throttleStatus?: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } } } };
      const cost = json.extensions?.cost;
      if (cost?.throttleStatus) {
        this.throttle = { currently_available: cost.throttleStatus.currentlyAvailable, maximum_available: cost.throttleStatus.maximumAvailable, restore_rate: cost.throttleStatus.restoreRate };
        this.throttleObservedAt = this.now();
        this.stats.total_actual_cost += cost.actualQueryCost ?? 0;
      }
      if (json.errors?.length) {
        if (json.errors.some((e) => e.extensions?.code === 'THROTTLED')) {
          if (attempt++ < this.maxRetries) { this.stats.throttled_waits++; await this.sleep(Math.min(this.maxWaitMs, restoreWait(this.throttle, this.estimatedCost))); continue; }
          throw new ThrottledError('THROTTLED after retries', restoreWait(this.throttle, this.estimatedCost));
        }
        if (json.errors.some((e) => /cursor/i.test(e.message) && /(invalid|expired)/i.test(e.message))) throw new CursorExpiredError(json.errors.map((e) => e.message).join('; '));
        if (json.errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) throw new CredentialError('forbidden', json.errors.map((e) => e.message).join('; '));
        throw new ProviderError(json.errors.map((e) => e.message).join('; '), json.errors);
      }
      if (json.data === undefined || json.data === null) throw new ProviderError('response without data', []);
      return { data: json.data, throttle: this.throttle, requested_cost: cost?.requestedQueryCost ?? null, actual_cost: cost?.actualQueryCost ?? null };
    }
  }
}

function backoff(attempt: number): number { return Math.min(8000, 500 * 2 ** (attempt - 1)); }

function restoreWait(t: ThrottleStatus | null, cost: number): number {
  if (!t) return 1000;
  return Math.max(1000, Math.ceil(((Math.min(cost, t.maximum_available) - t.currently_available) / Math.max(t.restore_rate, 1)) * 1000));
}

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
