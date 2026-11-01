# Shopify-shaped local fixture (synthetic)

Node HTTP server (no dependencies) emulating the subset of the Shopify GraphQL Admin API the connector uses. Data is generated from a seed (`fixtures/shopify/data.mjs`); no real Shopify payload is copied, only public schema field names. It is **not** live-provider evidence.

- `node fixtures/shopify/server.mjs --port 19182 --seed 42 --orders 40` (binds 127.0.0.1 only); `pnpm --filter @blackbox/worker fixture:shopify`.
- Token: `shpat_fixture_0123456789abcdef` (header `X-Shopify-Access-Token`) or the client-credentials grant with `fixture-client-id` / `fixture-client-secret` on `POST /admin/oauth/access_token`.
- Operations: BlackboxShop, BlackboxScopes, BlackboxOrdersCount, BlackboxOrders, BlackboxOrderLineItems, BlackboxInventoryItems, BlackboxFulfillmentOrders, BlackboxPaymentsAccount, BlackboxPayouts, BlackboxBalanceTransactions, BlackboxDisputes.
- Query syntax subset: `field:>='iso'`, `field:<'iso'`, `status:open`, `financial_status:x`, `fulfillment_status:x`, `AND`/`OR`/parentheses.
- Controls (`POST /__fixture/control`): `throttle_next`, `unavailable_next`, `expire_cursor_next`, `reject_token`, `duplicate_pages`, `shuffle`, `poison`, `fail_scopes`, `missing_scopes`, `payments_inactive`, and `mutate: {revise_order, mutate_accepted, add_order}`. URL flag `?fixture_throttle=N` answers the first N attempts of each distinct page request with `429` + `Retry-After: 1.0`.
- `extensions.cost` carries a simulated leaky bucket (default 2000 points restoring 1000/s so tests without sleeping stay deterministic; set `bucket: {max, available, restore}` through the control endpoint to emulate a Standard plan or exhaustion); an empty bucket returns a `THROTTLED` GraphQL error with `throttleStatus`.
- Data patterns: authorization+capture, sale, failed authorization followed by success, authorization only, partial refund with return/disposition, cancelled+void, `test: true` sale, pending sale; fulfillments (success/pending/delivered), inventory levels with named states, fulfillment orders, weekly payouts (PAID/IN_TRANSIT/SCHEDULED/FAILED), balance transactions (CHARGE/REFUND/DISPUTE/DISPUTE_REVERSAL/ADJUSTMENT), two disputes.
