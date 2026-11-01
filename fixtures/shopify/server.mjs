#!/usr/bin/env node
// Provider-shaped local Shopify GraphQL Admin API fixture (synthetic data; no real payloads).
// Implements only the operations the Blackbox adapter sends, dispatched by GraphQL operationName.
//   POST /admin/api/<version>/graphql.json   (X-Shopify-Access-Token required)
//   POST /admin/oauth/access_token           (client_credentials grant, 24h token)
//   POST /__fixture/control                  (test controls: throttle, outages, expired cursors, chaos, mutations)
//   GET  /__fixture/state, POST /__fixture/reset {seed, orders, clock}
// Start: node fixtures/shopify/server.mjs [--port 19182] [--seed 42]   (binds 127.0.0.1 only)
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { generate, mulberry32 } from './data.mjs';

export const FIXTURE_TOKEN = 'shpat_fixture_0123456789abcdef';
export const FIXTURE_CLIENT = { client_id: 'fixture-client-id', client_secret: 'fixture-client-secret' };
export const SUPPORTED_VERSIONS = ['2026-01', '2026-04', '2026-07', '2026-10'];

export function createFixture(options = {}) {
  const state = {
    seed: options.seed ?? 42, orders: options.orders ?? 40, clock: options.clock ?? Date.now(),
    data: null, tokens: new Map(), requests: 0, log: [],
    control: { throttle_next: 0, unavailable_next: 0, expire_cursor_next: 0, reject_token: false, duplicate_pages: false, shuffle: false, poison: false, fail_scopes: false, missing_scopes: [], payments_inactive: false },
    bucket: { max: 2000, available: 2000, restore: 1000, at: Date.now() },
  };
  const reset = (o = {}) => { Object.assign(state, { seed: o.seed ?? state.seed, orders: o.orders ?? state.orders, clock: o.clock ?? state.clock }); state.data = generate({ seed: state.seed, orders: state.orders, clock: state.clock }); state.requests = 0; state.log = []; state.control = { throttle_next: 0, unavailable_next: 0, expire_cursor_next: 0, reject_token: false, duplicate_pages: false, shuffle: false, poison: false, fail_scopes: false, missing_scopes: [], payments_inactive: false }; state.bucket = { max: 2000, available: 2000, restore: 1000, at: Date.now() }; };
  reset();

  const json = (res, status, body, headers = {}) => { const text = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers }); res.end(text); };
  const readBody = (req) => new Promise((resolve, reject) => { const chunks = []; req.on('data', (c) => { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 1_000_000) req.destroy(); }); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject); });

  // --- query string filter parser (subset of Shopify search syntax) ---
  const FIELD_MAP = { created_at: '_createdMs', updated_at: '_updatedMs', processed_at: '_processedMs', issued_at: '_issuedMs', initiated_at: '_initiatedMs', financial_status: '_financial', fulfillment_status: '_fulfillment' };
  function parseFilter(q) {
    if (!q || !q.trim()) return () => true;
    const tokens = q.match(/\(|\)|AND|OR|[a-z_]+:(?:>=|<=|<|>)?'[^']*'|[a-z_]+:[a-z_]+/g) ?? [];
    let i = 0;
    const term = () => {
      const t = tokens[i++];
      if (t === '(') { const e = expr(); if (tokens[i++] !== ')') throw new Error('bad query'); return e; }
      const m = /^([a-z_]+):(>=|<=|<|>)?'?([^']*)'?$/.exec(t);
      if (!m) throw new Error(`bad token ${t}`);
      const [, field, op, raw] = m;
      return (rec) => {
        const v = rec[FIELD_MAP[field] ?? field];
        if (op) { const ts = Date.parse(raw); const lhs = typeof v === 'number' ? v : Date.parse(v); return op === '>=' ? lhs >= ts : op === '<=' ? lhs <= ts : op === '<' ? lhs < ts : lhs > ts; }
        if (field === 'status') return raw === 'open' ? rec._open === true : raw === 'closed' ? rec._open === false : raw === 'cancelled' ? !!rec.cancelledAt : true;
        return String(v).toLowerCase() === raw.toLowerCase();
      };
    };
    const expr = () => {
      let left = term();
      while (i < tokens.length && (tokens[i] === 'AND' || tokens[i] === 'OR')) { const op = tokens[i++]; const right = term(); const l = left; left = op === 'AND' ? (r) => l(r) && right(r) : (r) => l(r) || right(r); }
      return left;
    };
    return expr();
  }

  const strip = (node) => { if (Array.isArray(node)) return node.map(strip); if (node && typeof node === 'object') { const o = {}; for (const [k, v] of Object.entries(node)) if (!k.startsWith('_')) o[k] = strip(v); return o; } return node; };
  function paginate(all, { first, after, query, sortField, chaosKey }) {
    const filter = parseFilter(query);
    let rows = all.filter(filter).sort((a, b) => a[sortField] - b[sortField]);
    let offset = 0; let dupPending = false;
    if (after) {
      if (state.control.expire_cursor_next > 0) { state.control.expire_cursor_next--; return { error: { message: 'Invalid cursor: expired', extensions: { code: 'BAD_USER_INPUT' } } }; }
      const m = /^c:(\d+):([a-f0-9]{8})(:dup)?$/.exec(Buffer.from(after, 'base64').toString('utf8'));
      if (!m || m[2] !== createHash('sha1').update(query ?? '').digest('hex').slice(0, 8)) return { error: { message: 'Invalid cursor', extensions: { code: 'BAD_USER_INPUT' } } };
      offset = Number(m[1]); dupPending = Boolean(m[3]);
    }
    const qh = createHash('sha1').update(query ?? '').digest('hex').slice(0, 8);
    let page; let nextOffset;
    if (dupPending) { page = rows.slice(offset - first, offset); nextOffset = offset; }
    else { page = rows.slice(offset, offset + first); nextOffset = offset + page.length; }
    const hasNext = nextOffset < rows.length;
    let cursor = null;
    if (hasNext || dupPending) cursor = Buffer.from(`c:${nextOffset}:${qh}${state.control.duplicate_pages && !dupPending && hasNext ? ':dup' : ''}`).toString('base64');
    if (state.control.shuffle) { const r = mulberry32(offset + 7); page = [...page].sort(() => r() - 0.5); }
    return { nodes: strip(page), pageInfo: { hasNextPage: hasNext || dupPending, endCursor: cursor }, total: rows.length };
  }

  function handleGraphql(body, res) {
    const { operationName, variables = {} } = body;
    const d = state.data;
    const first = Math.min(Number(variables.first ?? 10), 250);
    let data; let cost = 1;
    const connection = (all, sortField, extra = {}) => { const p = paginate(all, { first, after: variables.after ?? null, query: variables.query ?? null, sortField }); if (p.error) return { error: p.error }; cost = first * (1 + Object.keys(extra).length); return { value: { pageInfo: p.pageInfo, nodes: p.nodes } }; };
    switch (operationName) {
      case 'BlackboxShop': data = { shop: d.shop }; break;
      case 'BlackboxScopes': if (state.control.fail_scopes) return { errors: [{ message: 'Access denied for currentAppInstallation', extensions: { code: 'ACCESS_DENIED' } }] }; data = { currentAppInstallation: { id: 'gid://shopify/AppInstallation/1', accessScopes: d.scopes.filter((s) => !state.control.missing_scopes.includes(s)).map((handle) => ({ handle })) } }; break;
      case 'BlackboxOrdersCount': { const n = d.orders.filter(parseFilter(variables.query)).length; data = { ordersCount: { count: Math.min(n, 10000), precision: n > 10000 ? 'AT_LEAST' : 'EXACT' } }; break; }
      case 'BlackboxOrders': { const r = connection(d.orders, '_updatedMs', { nested: 1 }); if (r.error) return { errors: [r.error] }; const li = Number(variables.lineItems ?? 25); r.value.nodes = r.value.nodes.map((o) => { const nodes = o.lineItems.slice(0, li); return { ...o, lineItems: { pageInfo: { hasNextPage: o.lineItems.length > li, endCursor: o.lineItems.length > li ? Buffer.from(`li:${li}`).toString('base64') : null }, nodes }, returns: { pageInfo: { hasNextPage: false }, nodes: o.returns } }; }); if (state.control.poison) { const victim = r.value.nodes.find((o) => o.transactions.length); if (victim) victim.transactions[0] = { ...victim.transactions[0], amountSet: null }; } cost = first * (1 + li); data = { orders: r.value }; break; }
      case 'BlackboxOrderLineItems': { const o = d.orders.find((x) => x.id === variables.id); if (!o) { data = { order: null }; break; } const start = variables.after ? Number(Buffer.from(variables.after, 'base64').toString('utf8').split(':')[1]) : 0; const nodes = strip(o.lineItems.slice(start, start + first)); const end = start + nodes.length; data = { order: { id: o.id, lineItems: { pageInfo: { hasNextPage: end < o.lineItems.length, endCursor: end < o.lineItems.length ? Buffer.from(`li:${end}`).toString('base64') : null }, nodes } } }; break; }
      case 'BlackboxInventoryItems': { const r = connection(d.inventoryItems, '_updatedMs'); if (r.error) return { errors: [r.error] }; r.value.nodes = r.value.nodes.map((it) => ({ ...it, inventoryLevels: { pageInfo: { hasNextPage: false }, nodes: it.inventoryLevels } })); data = { inventoryItems: r.value }; break; }
      case 'BlackboxFulfillmentOrders': { const r = connection(d.fulfillmentOrders, '_updatedMs'); if (r.error) return { errors: [r.error] }; data = { fulfillmentOrders: r.value }; break; }
      case 'BlackboxPaymentsAccount': data = { shopifyPaymentsAccount: state.control.payments_inactive ? null : strip(d.account) }; break;
      case 'BlackboxPayouts': { if (!d.scopes.includes('read_shopify_payments_payouts') || state.control.missing_scopes.includes('read_shopify_payments_payouts')) return { errors: [{ message: 'Access denied for payouts field. Required access: `read_shopify_payments_payouts` access scope.', extensions: { code: 'ACCESS_DENIED' } }] }; const r = connection(d.payouts, '_issuedMs'); if (r.error) return { errors: [r.error] }; data = { shopifyPaymentsAccount: { id: d.account.id, payouts: r.value } }; break; }
      case 'BlackboxBalanceTransactions': { if (state.control.missing_scopes.includes('read_shopify_payments_payouts')) return { errors: [{ message: 'Access denied for balanceTransactions field.', extensions: { code: 'ACCESS_DENIED' } }] }; const r = connection(d.balanceTransactions, '_processedMs'); if (r.error) return { errors: [r.error] }; data = { shopifyPaymentsAccount: { id: d.account.id, balanceTransactions: r.value } }; break; }
      case 'BlackboxDisputes': { if (state.control.missing_scopes.includes('read_shopify_payments_disputes')) return { errors: [{ message: 'Access denied for disputes field.', extensions: { code: 'ACCESS_DENIED' } }] }; const r = connection(d.disputes, '_initiatedMs'); if (r.error) return { errors: [r.error] }; data = { shopifyPaymentsAccount: { id: d.account.id, disputes: r.value } }; break; }
      default: return { errors: [{ message: `Unknown operation ${operationName}`, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] };
    }
    // Leaky bucket.
    const now = Date.now(); state.bucket.available = Math.min(state.bucket.max, state.bucket.available + ((now - state.bucket.at) / 1000) * state.bucket.restore); state.bucket.at = now;
    const requested = Math.min(cost, 1000);
    if (state.bucket.available < requested) return { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED', documentation: 'https://shopify.dev/api/usage/rate-limits' } }], extensions: { cost: { requestedQueryCost: requested, actualQueryCost: null, throttleStatus: { maximumAvailable: state.bucket.max, currentlyAvailable: Math.floor(state.bucket.available), restoreRate: state.bucket.restore } } } };
    const actual = Math.max(1, Math.round(requested / 3)); state.bucket.available -= actual;
    return { data, extensions: { cost: { requestedQueryCost: requested, actualQueryCost: actual, throttleStatus: { maximumAvailable: state.bucket.max, currentlyAvailable: Math.floor(state.bucket.available), restoreRate: state.bucket.restore } } } };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests++;
    try {
      if (req.method === 'POST' && url.pathname === '/__fixture/control') { const c = JSON.parse(await readBody(req) || '{}'); if (c.mutate) applyMutation(c.mutate); if (c.bucket) Object.assign(state.bucket, c.bucket, { at: Date.now() }); Object.assign(state.control, c.control ?? c); delete state.control.mutate; delete state.control.bucket; return json(res, 200, { control: state.control, bucket: state.bucket }); }
      if (req.method === 'POST' && url.pathname === '/__fixture/reset') { reset(JSON.parse(await readBody(req) || '{}')); return json(res, 200, { ok: true, seed: state.seed, orders: state.orders }); }
      if (req.method === 'GET' && url.pathname === '/__fixture/state') return json(res, 200, { seed: state.seed, orders: state.data.orders.length, requests: state.requests, control: state.control, shop: state.data.shop, counts: { balanceTransactions: state.data.balanceTransactions.length, payouts: state.data.payouts.length, disputes: state.data.disputes.length, inventoryItems: state.data.inventoryItems.length, fulfillmentOrders: state.data.fulfillmentOrders.length }, log: state.log.slice(-50) });
      if (req.method === 'POST' && url.pathname === '/admin/oauth/access_token') {
        const params = new URLSearchParams(await readBody(req));
        if (params.get('grant_type') !== 'client_credentials' || params.get('client_id') !== FIXTURE_CLIENT.client_id || params.get('client_secret') !== FIXTURE_CLIENT.client_secret) return json(res, 400, { error: 'invalid_client' });
        const token = `shpat_cc_${createHash('sha1').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 24)}`;
        state.tokens.set(token, Date.now() + 86399_000);
        return json(res, 200, { access_token: token, scope: state.data.scopes.join(','), expires_in: 86399 });
      }
      const m = /^\/admin\/api\/(\d{4}-\d{2})\/graphql\.json$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const version = m[1];
        const throttleFlag = Number(url.searchParams.get('fixture_throttle') ?? 0);
        const token = req.headers['x-shopify-access-token'];
        const okToken = !state.control.reject_token && (token === FIXTURE_TOKEN || (state.tokens.has(token) && state.tokens.get(token) > Date.now()));
        if (!okToken) return json(res, 401, { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' });
        const body = JSON.parse(await readBody(req) || '{}');
        const key = `${body.operationName}:${body.variables?.after ?? ''}:${body.variables?.query ?? ''}`;
        state.log.push({ op: body.operationName, version, after: body.variables?.after ?? null, query: body.variables?.query ?? null });
        if (state.control.unavailable_next > 0) { state.control.unavailable_next--; res.writeHead(503, { 'Retry-After': '1' }); return res.end('Service Unavailable'); }
        if (state.control.throttle_next > 0 || (throttleFlag > 0 && (state.throttled ??= new Map()) && (state.throttled.get(key) ?? 0) < throttleFlag)) {
          if (state.control.throttle_next > 0) state.control.throttle_next--; else state.throttled.set(key, (state.throttled.get(key) ?? 0) + 1);
          return json(res, 429, { errors: 'Throttled' }, { 'Retry-After': '1.0' });
        }
        const effectiveVersion = SUPPORTED_VERSIONS.includes(version) ? version : SUPPORTED_VERSIONS[0];
        const out = handleGraphql(body, res);
        return json(res, 200, out, { 'X-Shopify-API-Version': effectiveVersion });
      }
      json(res, 404, { errors: 'Not Found' });
    } catch (err) { json(res, 500, { errors: String(err.message) }); }
  });

  function applyMutation(mut) {
    const d = state.data;
    if (mut.revise_order) { const o = d.orders.find((x) => x.id.endsWith(`/${mut.revise_order}`)); if (o) { const at = mut.at ? Date.parse(mut.at) : Date.parse(o.updatedAt) + 60_000 * (mut.minutes ?? 10); o.updatedAt = new Date(at).toISOString(); o._updatedMs = at; const l = o.lineItems[0]; if (l.currentQuantity > 1) { l.currentQuantity -= 1; l.unfulfilledQuantity = Math.max(0, l.unfulfilledQuantity - 1); } o.currentTotalPriceSet = { shopMoney: { amount: (Number(o.currentTotalPriceSet.shopMoney.amount) - Number(l.discountedTotalSet.shopMoney.amount) / l.quantity).toFixed(2), currencyCode: o.currencyCode } }; } }
    if (mut.mutate_accepted) { const o = d.orders.find((x) => x.id.endsWith(`/${mut.mutate_accepted}`)); if (o) o.originalTotalPriceSet = { shopMoney: { amount: (Number(o.originalTotalPriceSet.shopMoney.amount) + 1).toFixed(2), currencyCode: o.currencyCode } }; }
    if (mut.add_order) { const extra = generate({ seed: state.seed + 1000, orders: 1, clock: state.clock }); const o = extra.orders[0]; const at = Date.now(); o.id = `gid://shopify/Order/${5001 + d.orders.length}`; o.name = `#${1001 + d.orders.length}`; o.createdAt = o.updatedAt = new Date(at).toISOString(); o._createdMs = o._updatedMs = at; d.orders.push(o); }
  }

  return { server, state, reset, applyMutation,
    listen: (port = 19182, host = '127.0.0.1') => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(`http://${host}:${server.address().port}`)); }),
    close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2); const get = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const fixture = createFixture({ seed: Number(get('--seed', 42)), orders: Number(get('--orders', 40)) });
  fixture.listen(Number(get('--port', process.env.FIXTURE_PORT ?? 19182))).then((url) => process.stderr.write(`shopify fixture (synthetic) listening on ${url}; token ${FIXTURE_TOKEN}\n`));
}
