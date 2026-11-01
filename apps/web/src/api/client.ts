// Same-origin API client. Owner session cookie is HttpOnly and sent with credentials: 'include';
// non-GET requests carry the X-Blackbox-CSRF header obtained from GET /api/auth/session.
// No secret is ever stored in localStorage or placed in a URL.

import type { ApiError } from './types';

export class HttpError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  details?: unknown;
  constructor(status: number, body: ApiError | null, fallback: string) {
    super(body?.error?.message ?? fallback);
    this.status = status;
    this.code = body?.error?.code ?? `http_${status}`;
    this.retryable = body?.error?.retryable ?? false;
    this.details = body?.error?.details;
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  raw?: boolean;
}

export function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-Blackbox-CSRF'] = csrfToken;
  const response = await fetch(`${path}${buildQuery(options.query)}`, {
    method,
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  if (response.status === 204) return undefined as T;
  if (options.raw) return response as unknown as T;
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    if (response.status === 401 && onUnauthorized && !path.startsWith('/api/auth/')) onUnauthorized();
    throw new HttpError(response.status, (parsed as ApiError) ?? null, response.statusText);
  }
  return parsed as T;
}

export async function apiBlob(path: string, options: RequestOptions = {}): Promise<{ blob: Blob; filename: string | null }> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-Blackbox-CSRF'] = csrfToken;
  const response = await fetch(`${path}${buildQuery(options.query)}`, {
    method,
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    let body: ApiError | null = null;
    try {
      body = (await response.json()) as ApiError;
    } catch {
      body = null;
    }
    throw new HttpError(response.status, body, response.statusText);
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  return { blob: await response.blob(), filename: match?.[1] ?? null };
}
