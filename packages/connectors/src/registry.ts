import { ShopifyAdapter, SHOPIFY_CAPABILITIES, type ShopifyAdapterConfig } from './adapters/shopify/adapter.js';
import { ShopifyPaymentsAdapter, SHOPIFY_PAYMENTS_CAPABILITIES } from './adapters/shopify-payments/adapter.js';
import { InternalProducerAdapter, INTERNAL_CAPABILITIES } from './adapters/internal/index.js';
import type { ShopifyAuth } from './adapters/shopify/client.js';
import type { CapabilityDeclaration, SourceAdapter } from './types.js';

export const PROVIDERS = ['shopify', 'shopify_payments', 'generic', 'bank_csv', 'replay', 'policy', 'runtime'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function capabilitiesFor(provider: string): CapabilityDeclaration[] {
  if (provider === 'shopify') return SHOPIFY_CAPABILITIES;
  if (provider === 'shopify_payments') return SHOPIFY_PAYMENTS_CAPABILITIES;
  return INTERNAL_CAPABILITIES[provider] ?? [];
}

/** Capabilities that share one provider query (polled once per cycle). */
export function pollGroupOf(provider: string, capability_id: string): string {
  if (provider === 'shopify') return `shopify:${ShopifyAdapter.pollGroup(capability_id)}`;
  if (provider === 'shopify_payments') return `shopify_payments:${ShopifyPaymentsAdapter.pollGroup(capability_id)}`;
  return `${provider}:${capability_id}`;
}

export interface ConnectionConfig {
  shop_domain?: string;
  base_url?: string;
  api_version?: string;
  page_size?: number;
  [key: string]: unknown;
}

/** Build the adapter for a connection row. `secret` is the decrypted connection secret (never logged). */
export function createAdapter(provider: string, config: ConnectionConfig, secret: Record<string, unknown> | null, account_ref: string | null, overrides: Partial<ShopifyAdapterConfig> = {}): SourceAdapter {
  if (provider === 'shopify' || provider === 'shopify_payments') {
    if (!config.shop_domain) throw new Error('shop_domain is required');
    const auth = authFromSecret(secret);
    const cfg: ShopifyAdapterConfig = { shop_domain: config.shop_domain, base_url: config.base_url, api_version: config.api_version, page_size: config.page_size, auth, expected_account_ref: account_ref, ...overrides };
    return provider === 'shopify' ? new ShopifyAdapter(cfg) : new ShopifyPaymentsAdapter(cfg);
  }
  return new InternalProducerAdapter(provider);
}

export function authFromSecret(secret: Record<string, unknown> | null): ShopifyAuth {
  if (!secret) throw new Error('connection secret missing');
  if (typeof secret.access_token === 'string') return { type: 'admin_token', access_token: secret.access_token };
  if (typeof secret.client_id === 'string' && typeof secret.client_secret === 'string') return { type: 'client_credentials', client_id: secret.client_id, client_secret: secret.client_secret };
  throw new Error('connection secret must contain access_token or client_id+client_secret');
}
