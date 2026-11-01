#!/usr/bin/env node
// Development-only mock of docs/api-contract.md on 127.0.0.1:19189 (override with MOCK_PORT).
// Returns contract-shaped fixtures for every endpoint the UI calls. Never shipped in apps/web/dist.
// Owner routes require the bb_session cookie; non-GET owner routes require the X-Blackbox-CSRF header.

import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import {
  CATALOGUE_BASE, CLOCK, CONN, ENTITIES, EVIDENCE, GOLDEN_ENTRIES, IMPLEMENTED, QUESTION_TEMPLATES, TENANT_ID, WORKSPACE_NAME,
} from './fixtures.mjs';

const PORT = Number(process.env.MOCK_PORT ?? 19189);
const HOST = '127.0.0.1';
const OWNER_KEY = process.env.BLACKBOX_E2E_KEY ?? 'bbk_demo_0000000000000000000000000000000000000000000';
const SERVICE_VERSION = '0.1.0-mock';

// ---------- mutable state ----------
const state = {
  locale: 'en',
  displayName: WORKSPACE_NAME,
  demoLoaded: false,
  sessions: new Map(), // sid -> { csrf, remembered, expires_at }
  failures: [],
  agents: [],
  reviewCases: [],
  connections: new Map(),
  plans: new Map(),
  runs: new Map(),
  debug: { active: false, expires_at: null, scope: null },
  backups: {
    status: 'not_configured', destination_label: null, last_attempt_at: null, last_completed_at: null, last_cutoff: null,
    next_due_at: null, recoverable_age_seconds: null, retention: { daily: 7, weekly: 4 }, same_device: false, last_restore_test_at: null, last_error: null,
  },
  retention: { classes: [
    { id: 'provider_json', days: 90, min_days: 7, max_days: 365, provider_limit_days: null },
    { id: 'bank_csv', days: 90, min_days: 7, max_days: 365, provider_limit_days: null },
    { id: 'customer_communication', days: 30, min_days: 1, max_days: 90, provider_limit_days: 90 },
    { id: 'documents', days: 180, min_days: 30, max_days: 3650, provider_limit_days: null },
  ] },
  storageThresholds: { warning_percent: 10, warning_bytes: 5 * 1024 ** 3, critical_percent: 2, critical_bytes: 1024 ** 3 },
  logs: [],
  logSeq: 0,
  journalLive: [],
  started: Date.now(),
};

const nowIso = () => new Date().toISOString();
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

// ---------- connections (seeded demo + user-created) ----------
function seedConnections() {
  const base = (id, provider, display_name, account_label, demo) => ({
    connection_id: id, provider, display_name, account_label, demo, state: 'current', mode: 'local_standalone', created_at: minutesAgo(90),
    last_import_completed_at: minutesAgo(40), last_import_outcome: 'complete', last_successful_check_at: minutesAgo(3), last_new_event_at: minutesAgo(12),
    next_check_at: new Date(Date.now() + 7 * 60000).toISOString(), next_check_reason: 'schedule:orders:10m', pending_count: 0, failed_count: 0,
    config_summary: {},
  });
  state.connections.set(CONN.shop, { ...base(CONN.shop, 'shopify', 'Demo shop (replay)', 'demo-studio-nord.myshopify.example', true), config_summary: { shop_domain: 'demo-studio-nord.myshopify.example', api_version: '2025-10', scopes: 'read_orders, read_products, read_inventory' } });
  state.connections.set(CONN.payments, { ...base(CONN.payments, 'shopify_payments', 'Demo payments (replay)', 'acct-demo-payments', true), state: 'delayed', next_check_reason: 'retry_after:rate_limit', last_successful_check_at: minutesAgo(25), config_summary: { account: 'acct-demo-payments', api_version: '2025-10' } });
  state.connections.set(CONN.bank, { ...base(CONN.bank, 'bank_csv', 'Demo bank (CSV)', 'DE** **** 7781', true), next_check_at: null, next_check_reason: 'manual_upload_only', config_summary: { format: 'csv;semicolon', mapping: 'date,reference,amount,currency' } });
  state.connections.set(CONN.generic, { ...base(CONN.generic, 'generic', 'Demo producers (signed)', 'producer-demo', true), next_check_at: null, next_check_reason: 'push_only_signed_input', config_summary: { producer_id: 'producer-demo', signature: 'HMAC-SHA256' } });
  for (const id of state.connections.keys()) {
    state.plans.set(id, {
      plan_id: randomUUID(), plan_revision: 1, preset: 'last_30_days', timezone: 'Europe/Berlin',
      requested_from: '2026-10-01T08:00:00.000Z', initial_cutoff: '2026-10-31T08:00:00.000Z', include_open_context: true, include_opening_state: true,
      strict_from_now: false, selected_by: 'owner', selected_at: minutesAgo(90), restrictions: id === CONN.shop ? ['shopify.orders_history_limited_to_60_days_without_read_all_orders'] : [], inherited_from_workspace: id !== CONN.shop,
    });
    state.runs.set(id, [
      { run_id: randomUUID(), run_kind: 'initial', state: 'completed', phase: 'ready_for_queries', counters: { requested: 12, loaded: 12, committed: 12, applied: 12, failed: 0 }, totals_known: true, percent: 100, started_at: minutesAgo(88), updated_at: minutesAgo(40), finished_at: minutesAgo(40), outcome: 'complete', cohort: 'orders', error_code: null, next_action: null },
      { run_id: randomUUID(), run_kind: 'incremental', state: 'running', phase: 'import_records', counters: { requested: null, loaded: 3, committed: 2, applied: 2, failed: 0 }, totals_known: false, percent: null, started_at: minutesAgo(2), updated_at: nowIso(), finished_at: null, outcome: null, cohort: 'orders', error_code: null, next_action: null },
    ]);
  }
}
seedConnections();

// ---------- logs ----------
const COMPONENTS = ['api', 'worker', 'engine', 'postgres', 'mcp', 'wrapper', 'diagnostics'];
const SAMPLE = [
  ['INFO', 'worker', 'import.batch_progress', 'Import page processed', { record_count: 50, duration_ms: 420 }],
  ['INFO', 'api', 'journal.batch_committed', 'Journal batch committed', { record_count: 50, committed_cursor: 1029 }],
  ['INFO', 'engine', 'engine.batch_applied', 'Engine batch applied', { applied_cursor: 1029, duration_ms: 12 }],
  ['WARN', 'worker', 'provider.rate_limited', 'Provider rate limit reached; retry scheduled', { error_code: 'provider_rate_limited', retryable: true, next_retry_at: new Date(Date.now() + 120000).toISOString(), action_code: 'wait_for_retry' }],
  ['ERROR', 'worker', 'source.authorization_expired', 'Source authorization expired; reconnect required', { error_code: 'source_auth_expired', retryable: false, action_code: 'reconnect_source' }],
  ['INFO', 'api', 'query.served', 'Question served from applied cutoff', { duration_ms: 38, applied_cursor: 1029 }],
  ['INFO', 'mcp', 'mcp.request_authorized', 'MCP tool call authorized', { duration_ms: 44 }],
  ['DEBUG', 'worker', 'import.page_fetched', 'Import page fetched', { record_count: 50, duration_ms: 300 }],
  ['INFO', 'postgres', 'db.checkpoint', 'Checkpoint completed', { duration_ms: 90 }],
  ['WARN', 'diagnostics', 'logs.records_dropped', 'Log records dropped under overload', { record_count: 12 }],
  ['INFO', 'wrapper', 'runtime.started', 'Runtime started', {}],
];
function makeLog(i, occurredAt) {
  const [level, component, event_name, message, extra] = SAMPLE[i % SAMPLE.length];
  const connection_id = component === 'worker' || component === 'api' ? (i % 2 ? CONN.shop : CONN.payments) : undefined;
  const run_id = connection_id ? state.runs.get(connection_id)[i % 2].run_id : undefined;
  const trace_id = `trace-${String(Math.floor(i / 3)).padStart(6, '0')}`;
  return {
    schema_version: 1, record_id: `rec-${String(++state.logSeq).padStart(8, '0')}`, occurred_at: occurredAt, observed_at: occurredAt,
    level, event_name, message, component, service_version: SERVICE_VERSION, instance_id: 'inst-local-1', scope: component === 'wrapper' || component === 'postgres' ? 'installation' : 'workspace',
    ...(component !== 'wrapper' && component !== 'postgres' ? { tenant_id: TENANT_ID } : {}),
    ...(connection_id ? { connection_id, run_id, capability_id: 'orders' } : {}),
    trace_id, span_id: `span-${state.logSeq}`, ...extra,
    ...(event_name === 'provider.rate_limited' ? { aggregated_count: 3 } : {}),
  };
}
for (let i = 0; i < 420; i++) state.logs.push(makeLog(i, new Date(Date.now() - (420 - i) * 20000).toISOString()));
setInterval(() => {
  const rec = makeLog(state.logSeq, nowIso());
  if (rec.level === 'DEBUG' && !state.debug.active) rec.level = 'INFO';
  state.logs.push(rec);
  if (state.logs.length > 5000) state.logs.shift();
  for (const client of sseClients) if (!client.paused) sendSse(client, rec);
}, 2500);

const sseClients = new Set();
function sendSse(client, rec) {
  if (!matchesLogFilter(rec, client.filters)) return;
  client.res.write(`id: ${rec.record_id}\nevent: record\ndata: ${JSON.stringify(rec)}\n\n`);
}

const LEVEL_RANK = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
function matchesLogFilter(rec, f) {
  if (f.levels?.length) { if (!f.levels.includes(rec.level)) return false; }
  else if (f.level_min && LEVEL_RANK[rec.level] < LEVEL_RANK[f.level_min]) return false;
  if (f.since && rec.occurred_at < f.since) return false;
  if (f.until && rec.occurred_at > f.until) return false;
  if (f.component?.length && !f.component.includes(rec.component)) return false;
  if (f.provider?.length) {
    const conn = rec.connection_id ? state.connections.get(rec.connection_id) : null;
    if (!conn || !f.provider.includes(conn.provider)) return false;
  }
  if (f.connection_id && rec.connection_id !== f.connection_id) return false;
  if (f.run_id && rec.run_id !== f.run_id) return false;
  if (f.trace_id && rec.trace_id !== f.trace_id) return false;
  if (f.q) {
    const hay = `${rec.message} ${rec.event_name} ${rec.error_code ?? ''} ${rec.action_code ?? ''}`.toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}
function parseLogFilters(query) {
  const list = (v) => (v ? String(v).split(',').filter(Boolean) : []);
  return {
    level_min: query.get('level_min') || 'INFO',
    levels: list(query.get('levels')),
    since: query.get('since') || minutesAgo(60),
    until: query.get('until') || null,
    component: list(query.get('component')),
    provider: list(query.get('provider')),
    connection_id: query.get('connection_id') || null,
    run_id: query.get('run_id') || null,
    trace_id: query.get('trace_id') || null,
    q: query.get('q') || null,
  };
}

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}
const err = (res, status, code, message, retryable = false, details) => send(res, status, { error: { code, message, retryable, details } });
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return null; }
}
function requireOwner(req, res) {
  const sid = parseCookies(req).bb_session;
  const session = sid && state.sessions.get(sid);
  if (!session) { err(res, 401, 'unauthenticated', 'Owner session required'); return null; }
  if (new Date(session.expires_at).getTime() < Date.now()) { state.sessions.delete(sid); err(res, 401, 'session_expired', 'Session expired'); return null; }
  if (req.method !== 'GET' && req.headers['x-blackbox-csrf'] !== session.csrf) { err(res, 403, 'csrf_invalid', 'CSRF token missing or invalid'); return null; }
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) { err(res, 403, 'origin_rejected', 'Origin not allowed'); return null; }
  return session;
}
function requireAgentOrOwner(req, res) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer bba_')) {
    const key = auth.slice(7);
    const agent = state.agents.find((a) => a._key === key && a.status === 'active');
    if (!agent) { err(res, 401, 'unauthenticated', 'Agent key invalid or revoked'); return null; }
    agent.last_used_at = nowIso();
    return { kind: 'agent', agent };
  }
  const s = requireOwner(req, res);
  return s ? { kind: 'owner', session: s } : null;
}

function journalEntries() {
  if (!state.demoLoaded) return [...state.journalLive];
  return [...GOLDEN_ENTRIES, ...state.journalLive];
}
function consistency(applied = null) {
  const cursor = state.demoLoaded ? 1000 + journalEntries().length : 0;
  return { applied_cursor: applied ?? cursor, committed_cursor: cursor, required_cursor: null, status: 'current', recorded_cutoff: nowIso(), effective_cutoff: nowIso(), reducer_version: 'rust-reducers 0.1.0' };
}
function readinessSources() {
  return [...state.connections.values()].map((c) => ({
    connection_id: c.connection_id, provider: c.provider, last_successful_check_at: c.last_successful_check_at, last_new_event_at: c.last_new_event_at,
    coverage_from: state.demoLoaded ? '2026-10-01T08:00:00.000Z' : null, coverage_to: state.demoLoaded ? minutesAgo(3) : null, status: c.state,
  }));
}
function readiness(present, missing) {
  return { datasets_present: present, datasets_missing: missing, sources: readinessSources() };
}
function questionReadiness(t) {
  const demoDatasets = new Set(['stock', 'coverage', 'identity', 'orders', 'allocations', 'invoices', 'payments', 'payouts', 'bank', 'provider_ledger', 'positions', 'holds', 'returns', 'receipts', 'refunds', 'supply', 'promises', 'fulfillments', 'entitlements', 'payment_allocations']);
  const required = REQUIRED[t.id] ?? ['coverage', 'identity'];
  const missing = state.demoLoaded ? required.filter((d) => !demoDatasets.has(d)) : required;
  const status = !state.demoLoaded ? 'blocked' : missing.length === 0 ? 'ready' : missing.length < required.length ? 'partial' : 'blocked';
  return { question_id: t.id, intent: t.intent, status, missing, sources: readinessSources() };
}
const REQUIRED = {
  'order-01': ['stock', 'coverage', 'identity'], 'order-02': ['orders', 'stock', 'allocations', 'policy', 'coverage', 'identity'], 'order-03': ['orders', 'allocations', 'fulfillments', 'coverage', 'identity'],
  'order-04': ['orders', 'supply', 'allocations', 'promises', 'coverage', 'identity'], 'delivery-01': ['fulfillments', 'tracking', 'policy', 'coverage', 'identity'], 'delivery-02': ['orders', 'promises', 'fulfillments', 'tracking', 'policy', 'coverage', 'identity'],
  'delivery-03': ['orders', 'fulfillments', 'tracking', 'coverage', 'identity'], 'delivery-04': ['orders', 'fulfillments', 'tracking', 'communications', 'coverage', 'identity'], 'invoice-01': ['invoices', 'coverage', 'identity'],
  'invoice-02': ['orders', 'fulfillments', 'invoices', 'policy', 'coverage', 'identity'], 'invoice-03': ['orders', 'invoices', 'coverage', 'identity'], 'invoice-04': ['invoices', 'invoice_dispatch', 'coverage', 'identity'],
  'collection-01': ['orders', 'payments', 'coverage', 'identity'], 'collection-02': ['orders', 'payments', 'coverage', 'identity'], 'collection-03': ['invoices', 'payments', 'payment_allocations', 'coverage', 'identity'],
  'collection-04': ['invoices', 'payment_allocations', 'payments', 'policy', 'cases', 'coverage', 'identity'], 'settlement-01': ['provider_ledger', 'positions', 'payouts', 'bank', 'holds', 'coverage', 'identity'], 'settlement-02': ['provider_ledger', 'payouts', 'coverage', 'identity'],
  'settlement-03': ['payouts', 'bank', 'coverage', 'identity'], 'settlement-04': ['holds', 'positions', 'coverage', 'identity'], 'reversal-01': ['returns', 'receipts', 'refunds', 'coverage', 'identity'],
  'reversal-02': ['invoices', 'payments', 'entitlements', 'refunds', 'coverage', 'identity'], 'reversal-03': ['orders', 'allocations', 'invoices', 'payments', 'refunds', 'entitlements', 'receipts', 'coverage', 'identity'], 'reversal-04': ['payments', 'refunds', 'disputes', 'coverage', 'identity'],
};

const evidenceRef = (seq, label) => {
  const e = GOLDEN_ENTRIES[seq - 1];
  return { evidence_id: e.evidence_refs[0] ?? e.record_id, entry_id: e.entry_id, record_id: e.record_id, track: e.track, label };
};

function answer(template, params) {
  const base = {
    intent: template.intent, headline: null, summary_key: null, result: null,
    calculation: { rule: template.intent, version: '1', steps: [] }, evidence: [], effective_at: nowIso(), recorded_cutoff: nowIso(),
    consistency: consistency(), readiness: readiness([], []), coverage: [], missing_inputs: [], conflicts: [], warnings: [],
    scope: { params, period_from: params.period_from ?? '2026-10-01', period_to: params.period_to ?? '2026-10-31' },
  };
  const qr = questionReadiness(template);
  base.readiness = readiness(REQUIRED[template.id].filter((d) => !qr.missing.includes(d)), qr.missing);
  if (!state.demoLoaded) {
    return { ...base, status: 'insufficient_data', missing_inputs: REQUIRED[template.id].map((d) => `${d}.basis`), summary_key: 'no_data_yet' };
  }
  if (template.id === 'order-01') {
    const item = String(params.item_id ?? '');
    if (item !== 'CUP-OLV') {
      return { ...base, status: 'insufficient_data', missing_inputs: ['stock.basis'], summary_key: 'item_without_stock_basis', scope: { ...base.scope, entity: { type: 'item', id: item, label: item } } };
    }
    const requested = Number(params.quantity ?? 100);
    const physical = 112; const committed = 34; const available = physical - committed; const shortfall = Math.max(0, requested - available);
    return {
      ...base, status: 'complete', headline: { value: available, unit: 'piece', kind: 'quantity' }, summary_key: 'available_to_sell', summary_params: { requested, available, shortfall },
      result: { columns: ['item', 'physical', 'committed', 'available', 'incoming'], rows: [{ id: 'CUP-OLV', cells: [{ key: 'item', value: 'CUP-OLV' }, { key: 'physical', value: '112', kind: 'quantity', unit: 'piece' }, { key: 'committed', value: '34', kind: 'quantity', unit: 'piece' }, { key: 'available', value: '78', kind: 'quantity', unit: 'piece' }, { key: 'incoming', value: '80 (promised 2026-11-05, not stock)', kind: 'text' }], evidence_ids: ['EVD-001', 'EVD-012'] }], truncated: false },
      calculation: { rule: 'stock.free_from_disjoint_states', version: '1', steps: [
        { label_key: 'physical', label: 'physical', value: physical, unit: 'piece', operator: '-' },
        { label_key: 'committed', label: 'committed', value: committed, unit: 'piece', operator: '=' },
        { label_key: 'available', label: 'available', value: available, unit: 'piece', operator: null },
      ] },
      evidence: [evidenceRef(28, 'CUP-OLV · 112 physical · 34 committed'), evidenceRef(1, 'Stock snapshot CUP-OLV'), evidenceRef(16, 'Goods out −10'), evidenceRef(19, 'Restock +2'), evidenceRef(29, 'PO-208 · 80 piece promised 2026-11-05')],
      coverage: [{ capability_id: 'inventory', population: 'item CUP-OLV @ WH-1', interval_from: '2026-10-31T09:01:00Z', interval_to: '2026-10-31T10:40:00Z', completeness: 'complete_for_declared_scope' }],
      warnings: ['incoming_supply_not_counted'],
      scope: { ...base.scope, entity: { type: 'item', id: 'CUP-OLV', label: 'Everyday Cup · Olive' } },
    };
  }
  if (template.id === 'invoice-01') {
    return {
      ...base, status: 'complete', headline: { value: 9520, currency: 'EUR', kind: 'money' }, summary_key: 'outstanding_total', summary_params: { count: 1 },
      result: { columns: ['invoice', 'order', 'original', 'corrections', 'outstanding', 'due'], rows: [{ id: 'INV-1001', cells: [{ key: 'invoice', value: 'INV-1001' }, { key: 'order', value: '#1001' }, { key: 'original', value: 11900, kind: 'money', currency: 'EUR' }, { key: 'corrections', value: -2380, kind: 'money', currency: 'EUR' }, { key: 'outstanding', value: 9520, kind: 'money', currency: 'EUR' }, { key: 'due', value: '2026-11-07', kind: 'date' }], evidence_ids: ['EVD-003', 'EVD-008'] }], truncated: false },
      calculation: { rule: 'invoice.outstanding_from_versions', version: '1', steps: [
        { label_key: 'original_gross', label: 'original gross', value: 11900, currency: 'EUR', operator: '-' },
        { label_key: 'credit_notes', label: 'credit notes', value: 2380, currency: 'EUR', operator: '=' },
        { label_key: 'outstanding', label: 'outstanding', value: 9520, currency: 'EUR', operator: null },
      ] },
      evidence: [evidenceRef(21, 'INV-1001 receivable 95.20 EUR after credit'), evidenceRef(7, 'Invoice issued 119.00 EUR'), evidenceRef(20, 'Credit note 23.80 EUR')],
      coverage: [{ capability_id: 'invoices', population: 'invoices issued 2026-10-01..2026-10-31', interval_from: '2026-10-01T00:00:00Z', interval_to: '2026-10-31T10:40:00Z', completeness: 'complete_for_declared_scope' }],
      warnings: ['payment_markers_are_not_bank_evidence'],
    };
  }
  if (template.id === 'settlement-01') {
    return {
      ...base, status: 'complete', headline: { value: 0, currency: 'EUR', kind: 'money' }, summary_key: 'money_positions', summary_params: { providers: 1 },
      result: { columns: ['scope', 'amount'], rows: [
        { id: 'provider', cells: [{ key: 'scope', value: 'provider_available' }, { key: 'amount', value: 0, kind: 'money', currency: 'EUR' }], evidence_ids: ['EVD-010'] },
        { id: 'in_transit', cells: [{ key: 'scope', value: 'in_transit' }, { key: 'amount', value: 0, kind: 'money', currency: 'EUR' }], evidence_ids: ['EVD-010', 'EVD-011'] },
        { id: 'bank', cells: [{ key: 'scope', value: 'bank_matched' }, { key: 'amount', value: 9170, kind: 'money', currency: 'EUR' }], evidence_ids: ['EVD-011'] },
      ], truncated: false },
      calculation: { rule: 'provider.positions_from_ledger', version: '1', steps: [
        { label_key: 'captured', label: 'captured', value: 11900, currency: 'EUR', operator: '-' },
        { label_key: 'fees', label: 'fees', value: 350, currency: 'EUR', operator: '-' },
        { label_key: 'refunds', label: 'refunds', value: 2380, currency: 'EUR', operator: '=' },
        { label_key: 'paid_out', label: 'paid out', value: 9170, currency: 'EUR', operator: null },
      ] },
      evidence: [evidenceRef(12, 'Provider balance +119.00'), evidenceRef(14, 'Fee −3.50'), evidenceRef(23, 'Refund −23.80'), evidenceRef(25, 'Payout −91.70'), evidenceRef(27, 'Bank receipt +91.70 matched')],
      coverage: [{ capability_id: 'payouts', population: 'acct-demo-payments', interval_from: '2026-10-01T00:00:00Z', interval_to: '2026-10-31T10:30:00Z', completeness: 'complete_for_declared_scope' }],
    };
  }
  if (template.id === 'collection-01') {
    return {
      ...base, status: 'complete', headline: { value: 1, kind: 'count' }, summary_key: 'payment_states', summary_params: { paid: 1, authorized: 0, awaiting: 0 },
      result: { columns: ['order', 'state', 'authorized', 'captured'], rows: [{ id: '#1001', cells: [{ key: 'order', value: '#1001' }, { key: 'state', value: 'paid', kind: 'status' }, { key: 'authorized', value: 11900, kind: 'money', currency: 'EUR' }, { key: 'captured', value: 11900, kind: 'money', currency: 'EUR' }], evidence_ids: ['EVD-004', 'EVD-005'] }], truncated: false },
      calculation: { rule: 'payment.state_from_authorization_and_capture', version: '2', steps: [] },
      evidence: [evidenceRef(10, 'TX-1001 authorized'), evidenceRef(11, 'TX-1001 captured')],
      coverage: [{ capability_id: 'payments', population: 'orders 2026-10', interval_from: '2026-10-01T00:00:00Z', interval_to: '2026-10-31T10:40:00Z', completeness: 'complete_for_declared_scope' }],
    };
  }
  if (template.id === 'reversal-04') {
    return {
      ...base, status: 'partial', headline: { value: 0, kind: 'count' }, summary_key: 'no_overlap_found_partial',
      result: { columns: ['transaction', 'refund', 'chargeback'], rows: [], truncated: false },
      calculation: { rule: 'refund.vs_dispute_overlap', version: '1', steps: [] },
      evidence: [evidenceRef(22, 'Refund RF-1001 completed')],
      coverage: [{ capability_id: 'disputes', population: 'acct-demo-payments', interval_from: null, interval_to: null, completeness: 'unavailable' }],
      missing_inputs: ['disputes.feed'],
      warnings: ['dispute_coverage_unavailable'],
    };
  }
  if (template.id === 'order-04') {
    return {
      ...base, status: 'conflict', headline: null, summary_key: 'delay_impact_conflict',
      result: { columns: ['order', 'promised', 'supply'], rows: [], truncated: false },
      calculation: { rule: 'supply.delay_to_orders', version: '1', steps: [] },
      evidence: [evidenceRef(29, 'PO-208 promised 2026-11-05 (was 11-03)'), evidenceRef(5, '#1001 delivery promised 2026-11-04')],
      coverage: [{ capability_id: 'supply', population: 'PO-208', interval_from: null, interval_to: null, completeness: 'partial' }],
      conflicts: [{ code: 'allocation_missing', description: 'Supply promise PO-208 is not allocated to any open order line; impact cannot be resolved automatically.', entry_ids: [GOLDEN_ENTRIES[28].entry_id] }],
    };
  }
  const qr2 = questionReadiness(template);
  if (qr2.status !== 'ready') {
    return { ...base, status: 'insufficient_data', missing_inputs: qr2.missing.map((d) => `${d}.basis`), summary_key: 'missing_datasets' };
  }
  return {
    ...base, status: 'complete', headline: { value: 0, kind: 'count' }, summary_key: 'empty_with_coverage',
    result: { columns: [], rows: [], truncated: false },
    coverage: [{ capability_id: template.group, population: 'declared scope', interval_from: '2026-10-01T00:00:00Z', interval_to: '2026-10-31T10:40:00Z', completeness: 'complete_for_declared_scope' }],
    evidence: [evidenceRef(3, 'Order #1001 accepted')],
  };
}

function entityState(type, id) {
  const present = state.demoLoaded;
  const base = { entity: { type, id }, consistency: consistency(), readiness: readiness(present ? ['identity', 'coverage'] : [], present ? [] : ['identity']), missing_inputs: [], conflicts: [], evidence: [], effective_at: present ? '2026-10-31T10:40:00Z' : null, recorded_cutoff: nowIso() };
  if (!present) return { ...base, status: 'insufficient_data', lifecycle: { state: 'unknown' }, positions: [], fields: [], missing_inputs: ['identity'] };
  if (type === 'invoice' && id === 'INV-1001') {
    return { ...base, status: 'complete', lifecycle: { state: 'corrected_open' },
      positions: [{ key: 'outstanding', amount_minor: 9520, currency: 'EUR', note_key: 'due_on' }],
      fields: [{ key: 'original_net', value: 10000, kind: 'money', currency: 'EUR' }, { key: 'tax', value: 1900, kind: 'money', currency: 'EUR' }, { key: 'original_gross', value: 11900, kind: 'money', currency: 'EUR' }, { key: 'corrections', value: -2380, kind: 'money', currency: 'EUR' }, { key: 'paid_marker', value: 0, kind: 'money', currency: 'EUR' }, { key: 'due_date', value: '2026-11-07', kind: 'date' }],
      evidence: [evidenceRef(7, 'Invoice issued'), evidenceRef(20, 'Credit note'), evidenceRef(21, 'Receivable reduced')] };
  }
  if (type === 'transaction' && id === 'TX-1001') {
    return { ...base, status: 'complete', lifecycle: { state: 'captured_refunded_partially' },
      positions: [{ key: 'at_provider', amount_minor: 0, currency: 'EUR' }, { key: 'in_transit', amount_minor: 0, currency: 'EUR' }, { key: 'bank_matched', amount_minor: 9170, currency: 'EUR' }],
      fields: [{ key: 'authorized', value: 11900, kind: 'money', currency: 'EUR' }, { key: 'captured', value: 11900, kind: 'money', currency: 'EUR' }, { key: 'fees', value: 350, kind: 'money', currency: 'EUR' }, { key: 'refunded', value: 2380, kind: 'money', currency: 'EUR' }, { key: 'paid_out', value: 9170, kind: 'money', currency: 'EUR' }, { key: 'payout_reference', value: 'PO-2026-10-31', kind: 'text' }],
      evidence: [evidenceRef(9, 'Authorized'), evidenceRef(11, 'Captured'), evidenceRef(13, 'Fee'), evidenceRef(22, 'Refund'), evidenceRef(24, 'Payout'), evidenceRef(26, 'Bank entry')] };
  }
  if (type === 'order' && id === '#1001') {
    return { ...base, status: 'complete', lifecycle: { state: 'shipped_partially_returned' },
      positions: [{ key: 'ordered', quantity: '10', unit: 'piece' }, { key: 'shipped', quantity: '10', unit: 'piece' }, { key: 'returned', quantity: '2', unit: 'piece' }],
      fields: [{ key: 'gross', value: 11900, kind: 'money', currency: 'EUR' }, { key: 'promised_date', value: '2026-11-04', kind: 'date' }, { key: 'invoice', value: 'INV-1001', kind: 'text' }, { key: 'payment', value: 'TX-1001', kind: 'text' }],
      evidence: [evidenceRef(3, 'Order accepted'), evidenceRef(15, 'Shipped'), evidenceRef(18, 'Return received')] };
  }
  if (type === 'item' && id === 'CUP-OLV') {
    return { ...base, status: 'complete', lifecycle: { state: 'in_stock' },
      positions: [{ key: 'physical', quantity: '112', unit: 'piece' }, { key: 'committed', quantity: '34', unit: 'piece' }, { key: 'available', quantity: '78', unit: 'piece' }],
      fields: [{ key: 'incoming', value: '80 (PO-208, 2026-11-05)', kind: 'text' }],
      evidence: [evidenceRef(28, 'State observed'), evidenceRef(1, 'Snapshot')] };
  }
  return { ...base, status: 'insufficient_data', lifecycle: { state: 'unknown' }, positions: [], fields: [], missing_inputs: ['identity'] };
}

function healthCards() {
  const uptime = Math.floor((Date.now() - state.started) / 1000);
  const now = nowIso();
  return {
    cards: [
      { id: 'api', state: 'healthy', observed_at: now, reason: 'probe_ok', next_action: null, details: { version: SERVICE_VERSION, uptime_seconds: uptime, last_probe_at: now, response_available: 'yes' } },
      { id: 'worker', state: 'working', observed_at: now, reason: 'incremental_run_in_progress', next_action: null, details: { heartbeat_at: now, running: 1, queued: 2, failed: 0, oldest_pending_age_seconds: 42, last_progress_at: minutesAgo(1) } },
      { id: 'postgres', state: 'healthy', observed_at: now, reason: 'read_write_ok', next_action: null, details: { connect: 'ok', read: 'ok', write: 'ok', latency_ms: 2 } },
      { id: 'engine', state: state.demoLoaded ? 'healthy' : 'working', observed_at: now, reason: state.demoLoaded ? 'applied_equals_committed' : 'awaiting_first_batch', next_action: null, details: { heartbeat_at: now, phase: 'serving', committed_cursor: consistency().committed_cursor, applied_cursor: consistency().applied_cursor, pending: 0, lag_ms: 0 } },
      { id: 'sources', state: 'degraded', observed_at: now, reason: 'one_connection_delayed', next_action: 'open_sources', details: { connections: state.connections.size, delayed: 1, errored: 0, last_new_event_at: minutesAgo(12) } },
      { id: 'mcp', state: 'unknown', observed_at: now, reason: 'no_client_request_yet', next_action: 'connect_agent', details: { bridge_ready: 'yes', last_client_request_at: state.agents.find((a) => a.last_used_at)?.last_used_at ?? null } },
      { id: 'diagnostics', state: 'healthy', observed_at: now, reason: 'collector_ok', next_action: null, details: { retained_from: state.logs[0]?.occurred_at ?? null, retained_to: state.logs.at(-1)?.occurred_at ?? null, used_bytes: 18_300_000, cap_bytes: 104_857_600, dropped_count: 12, debug_expires_at: state.debug.expires_at } },
    ],
    backups: { status: state.backups.status, last_completed_at: state.backups.last_completed_at, recoverable_age_seconds: state.backups.recoverable_age_seconds },
    unresolved_review_count: state.reviewCases.filter((c) => c.state !== 'resolved').length,
    maintenance: { phase: null },
  };
}

function seedReviewCases() {
  state.reviewCases = [
    { case_id: 'case-0001', type: 'unresolved_link', state: 'open', revision: 1, reason: 'Bank entry BK-7790 (+23.80 EUR) matches two candidate payouts by amount; reference text is ambiguous.', stage: 'link_and_process', source: { connection_id: CONN.bank, provider: 'bank_csv', account_label: 'DE** **** 7781' }, run_id: state.runs.get(CONN.bank)[1].run_id, affected: { records: ['BK-7790'], questions: ['settlement-03', 'settlement-01'] }, evidence_ref: 'EVD-011', proposed_link: { from: 'BK-7790', to: 'PO-2026-10-30' }, available_actions: ['confirm_link', 'reject_link', 'append_correction', 'leave_open'], recalculating: false, required_cursor: null, applied_cursor: null, history: [{ actor: 'worker', at: minutesAgo(20), action: 'opened' }], created_at: minutesAgo(20), updated_at: minutesAgo(20) },
    { case_id: 'case-0002', type: 'quarantined_input', state: 'open', revision: 1, reason: 'Generic producer record rejected: quantity "ten" is not a decimal string.', stage: 'import_records', source: { connection_id: CONN.generic, provider: 'generic', account_label: 'producer-demo' }, run_id: state.runs.get(CONN.generic)[1].run_id, affected: { records: ['producer-demo:evt-7781'], questions: ['order-02'] }, evidence_ref: null, proposed_link: null, available_actions: ['retry', 'append_correction', 'leave_open'], recalculating: false, required_cursor: null, applied_cursor: null, history: [{ actor: 'worker', at: minutesAgo(15), action: 'opened' }], created_at: minutesAgo(15), updated_at: minutesAgo(15) },
  ];
}
seedReviewCases();

// Mock-only: reset mutable state so e2e runs start from a known baseline (not part of the API contract).
function resetState() {
  state.locale = 'en';
  state.displayName = WORKSPACE_NAME;
  state.demoLoaded = false;
  state.failures = [];
  state.agents = [];
  state.journalLive = [];
  state.debug = { active: false, expires_at: null, scope: null };
  state.backups = { status: 'not_configured', destination_label: null, last_attempt_at: null, last_completed_at: null, last_cutoff: null, next_due_at: null, recoverable_age_seconds: null, retention: { daily: 7, weekly: 4 }, same_device: false, last_restore_test_at: null, last_error: null };
  state.connections = new Map();
  state.plans = new Map();
  state.runs = new Map();
  seedConnections();
  seedReviewCases();
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const query = url.searchParams;
  res.setHeader('X-Mock-Api', 'blackbox');

  try {
    // unauthenticated
    if (path === '/api/health' && req.method === 'GET') return send(res, 200, { status: 'ok', version: SERVICE_VERSION });
    if (path === '/api/_mock/reset' && req.method === 'POST') { resetState(); return send(res, 200, { reset: true }); }

    // auth
    if (path === '/api/auth/login' && req.method === 'POST') {
      const body = await readJson(req);
      const recent = state.failures.filter((t) => Date.now() - t < 15 * 60000);
      state.failures = recent;
      if (recent.length >= 5) return err(res, 429, 'throttled', 'Too many failed attempts; try again later', true, { retry_after_seconds: 900 });
      if (!body || typeof body.key !== 'string' || body.key !== OWNER_KEY) { state.failures.push(Date.now()); return err(res, 401, 'invalid_key', 'The access key is not valid'); }
      const sid = randomUUID();
      const remembered = Boolean(body.remember);
      const expires_at = new Date(Date.now() + (remembered ? 30 : 8 / 24) * 86400000).toISOString();
      state.sessions.set(sid, { csrf: randomUUID(), remembered, expires_at });
      res.setHeader('Set-Cookie', `bb_session=${sid}; Path=/; HttpOnly; SameSite=Strict${remembered ? `; Max-Age=${30 * 86400}` : ''}`);
      return send(res, 204);
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      const sid = parseCookies(req).bb_session;
      if (sid) state.sessions.delete(sid);
      res.setHeader('Set-Cookie', 'bb_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return send(res, 204);
    }
    if (path === '/api/auth/session' && req.method === 'GET') {
      const sid = parseCookies(req).bb_session; const s = sid && state.sessions.get(sid);
      if (!s) return err(res, 401, 'unauthenticated', 'No session');
      return send(res, 200, { principal: { id: 'owner-1', kind: 'owner' }, workspace: { tenant_id: TENANT_ID, display_name: state.displayName, locale: state.locale }, csrf_token: s.csrf, session: { expires_at: s.expires_at, remembered: s.remembered } });
    }
    if (path === '/api/auth/rotate-key' && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      const body = await readJson(req);
      if (body?.current_key !== OWNER_KEY) return err(res, 401, 'invalid_key', 'Current key does not match');
      // The mock keeps the same key so e2e logins keep working; a real rotation invalidates all owner sessions.
      return send(res, 200, { new_key: `bbk_${createHash('sha256').update(randomUUID()).digest('base64url').slice(0, 43)}` });
    }

    // workspace
    if (path === '/api/workspace') {
      if (!requireAgentOrOwner(req, res)) return;
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        if (body?.locale && !['en', 'de'].includes(body.locale)) return err(res, 422, 'validation', 'locale must be en or de');
        if (body?.locale) state.locale = body.locale;
        if (typeof body?.display_name === 'string' && body.display_name.trim()) state.displayName = body.display_name.trim().slice(0, 80);
      }
      return send(res, 200, { tenant_id: TENANT_ID, display_name: state.displayName, locale: state.locale, created_at: minutesAgo(90), backups: { status: state.backups.status }, unresolved_review_count: state.reviewCases.filter((c) => c.state !== 'resolved').length });
    }

    // sources
    if (path === '/api/sources' && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      const connections = [...state.connections.values()];
      const catalogue = CATALOGUE_BASE.map((c) => {
        const conns = connections.filter((x) => x.provider === c.provider);
        let st = IMPLEMENTED.has(c.provider) ? 'implemented' : c.provider === 'email' ? 'unsupported' : 'planned';
        if (conns.length) st = conns.some((x) => x.state === 'error' || x.state === 'delayed') ? 'degraded' : conns.some((x) => x.state === 'initial_import' || x.state === 'current') ? 'syncing' : 'configured';
        const cap = (id, schedule, limitations = []) => ({ id, state: st === 'planned' || st === 'unsupported' ? st : 'active', schedule, last_successful_check_at: conns[0]?.last_successful_check_at ?? null, last_new_event_at: conns[0]?.last_new_event_at ?? null, next_check_at: conns[0]?.next_check_at ?? null, next_check_reason: conns[0]?.next_check_reason ?? null, coverage_from: conns.length && state.demoLoaded ? '2026-10-01T08:00:00.000Z' : null, coverage_to: conns.length && state.demoLoaded ? minutesAgo(3) : null, limitations });
        const caps = {
          shopify: [cap('orders', 'poll:10m', ['historical orders older than 60 days require read_all_orders']), cap('products', 'poll:60m'), cap('inventory', 'poll:15m', ['snapshot only; no movement history'])],
          shopify_payments: [cap('transactions', 'poll:15m'), cap('payouts', 'poll:60m'), cap('disputes', null, ['disputes feed unavailable in local_standalone'])],
          bank_csv: [cap('bank_entries', null, ['manual upload; no completeness check'])],
          generic: [cap('typed_records', null, ['push only; signed input; no reconciliation'])],
          replay: [cap('fixtures', null, ['test/demo only'])],
        }[c.provider] ?? [cap('all', null, ['planned provider; no data'])];
        return { provider: c.provider, category: c.category, state: st, capabilities: caps, connections: conns.map(({ config_summary, ...rest }) => rest), connect_kind: c.connect_kind };
      });
      return send(res, 200, { catalogue });
    }
    if (path === '/api/sources/connections' && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      const body = await readJson(req);
      if (!body?.provider || !IMPLEMENTED.has(body.provider)) return err(res, 422, 'validation', 'provider not connectable', false, { field: 'provider' });
      if (!body.display_name) return err(res, 422, 'validation', 'display_name required', false, { field: 'display_name' });
      const id = randomUUID();
      const conn = { connection_id: id, provider: body.provider, display_name: String(body.display_name).slice(0, 80), account_label: body.config?.shop_domain ?? body.config?.account ?? null, demo: false, state: 'initial_import', mode: 'local_standalone', created_at: nowIso(), last_import_completed_at: null, last_import_outcome: null, last_successful_check_at: nowIso(), last_new_event_at: null, next_check_at: null, next_check_reason: 'awaiting_import_plan', pending_count: 0, failed_count: 0, config_summary: Object.fromEntries(Object.entries(body.config ?? {}).map(([k, v]) => [k, String(v).slice(0, 80)])) };
      state.connections.set(id, conn);
      state.plans.set(id, null);
      state.runs.set(id, [{ run_id: randomUUID(), run_kind: 'check', state: 'completed', phase: 'check_connection', counters: { requested: null, loaded: 0, committed: 0, applied: 0, failed: 0 }, totals_known: false, percent: null, started_at: nowIso(), updated_at: nowIso(), finished_at: nowIso(), outcome: 'complete', cohort: 'credentials', error_code: null, next_action: 'select_import_plan' }]);
      const { config_summary, ...summary } = conn;
      return send(res, 201, summary);
    }
    let m;
    if ((m = /^\/api\/sources\/connections\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      const c = state.connections.get(m[1]);
      if (!c) return err(res, 404, 'not_found', 'Not found');
      const now = nowIso();
      const health = { observed_at: now, state: c.state, last_attempt_at: minutesAgo(2), last_import_completed_at: c.last_import_completed_at, last_successful_check_at: c.last_successful_check_at, last_new_event_at: c.last_new_event_at, last_journal_commit_at: state.demoLoaded ? minutesAgo(1) : null, last_applied_at: state.demoLoaded ? minutesAgo(1) : null, next_check_at: c.next_check_at, next_check_reason: c.next_check_reason, coverage: state.demoLoaded && c.demo ? [{ capability_id: 'orders', from: '2026-10-01T08:00:00.000Z', to: minutesAgo(3), completeness: 'complete_for_declared_scope', history_kind: 'event_history' }, { capability_id: 'inventory', from: '2026-10-31T09:01:00Z', to: minutesAgo(3), completeness: 'partial', history_kind: 'snapshot_only' }] : [], limitations: c.provider === 'shopify' ? ['historical orders older than 60 days require read_all_orders'] : c.provider === 'shopify_payments' ? ['disputes feed unavailable in local_standalone'] : [], pending_count: c.pending_count, failed_count: c.failed_count, oldest_pending_age_seconds: c.pending_count ? 42 : null, committed_cursor: consistency().committed_cursor, applied_cursor: consistency().applied_cursor };
      return send(res, 200, { connection: c, health, import_plan: state.plans.get(c.connection_id), runs: state.runs.get(c.connection_id) ?? [], readiness: readiness(state.demoLoaded ? ['orders', 'coverage'] : [], state.demoLoaded ? [] : ['orders']) });
    }
    if ((m = /^\/api\/sources\/connections\/([^/]+)\/import-plan$/.exec(path)) && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      const c = state.connections.get(m[1]);
      if (!c) return err(res, 404, 'not_found', 'Not found');
      const body = await readJson(req);
      const presets = ['last_30_days', 'this_year', 'last_12_months', 'custom', 'from_now'];
      if (!body || !presets.includes(body.preset)) return err(res, 422, 'validation', 'invalid preset', false, { field: 'preset' });
      if (!body.timezone) return err(res, 422, 'validation', 'timezone required', false, { field: 'timezone' });
      const resolved = resolvePlan(body);
      if (resolved.error) return err(res, 422, 'validation', resolved.error, false, { field: 'from' });
      const prev = state.plans.get(c.connection_id);
      const plan = { plan_id: prev?.plan_id ?? randomUUID(), plan_revision: (prev?.plan_revision ?? 0) + 1, preset: body.preset, timezone: body.timezone, requested_from: resolved.requested_from, initial_cutoff: resolved.initial_cutoff, include_open_context: body.preset === 'from_now' ? Boolean(body.include_open_context) : true, include_opening_state: body.preset === 'from_now' ? Boolean(body.include_open_context) : Boolean(body.include_opening_state ?? true), strict_from_now: body.preset === 'from_now' && !body.include_open_context, selected_by: 'owner', selected_at: nowIso(), restrictions: c.provider === 'shopify' ? ['shopify.orders_history_limited_to_60_days_without_read_all_orders'] : [], inherited_from_workspace: false };
      state.plans.set(c.connection_id, plan);
      c.next_check_reason = 'schedule:orders:10m'; c.next_check_at = new Date(Date.now() + 600000).toISOString();
      return send(res, 200, plan);
    }
    if ((m = /^\/api\/sources\/connections\/([^/]+)\/runs$/.exec(path)) && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      const c = state.connections.get(m[1]);
      if (!c) return err(res, 404, 'not_found', 'Not found');
      const body = await readJson(req);
      if (!['backfill', 'incremental', 'reconcile', 'check'].includes(body?.kind)) return err(res, 422, 'validation', 'invalid run kind');
      const run = { run_id: randomUUID(), run_kind: body.kind === 'backfill' ? 'initial' : body.kind === 'reconcile' ? 'reconciliation' : body.kind, state: 'running', phase: body.kind === 'check' ? 'check_connection' : 'import_records', counters: { requested: null, loaded: 0, committed: 0, applied: 0, failed: 0 }, totals_known: false, percent: null, started_at: nowIso(), updated_at: nowIso(), finished_at: null, outcome: null, cohort: 'orders', error_code: null, next_action: null };
      state.runs.get(c.connection_id).unshift(run);
      if (c.state === 'initial_import') c.state = 'current';
      return send(res, 202, run);
    }
    if ((m = /^\/api\/sources\/connections\/([^/]+)\/(pause|resume|disconnect)$/.exec(path)) && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      const c = state.connections.get(m[1]);
      if (!c) return err(res, 404, 'not_found', 'Not found');
      c.state = m[2] === 'pause' ? 'paused' : m[2] === 'resume' ? 'current' : 'disconnected';
      if (m[2] === 'disconnect') { c.next_check_at = null; c.next_check_reason = 'disconnected_history_preserved'; }
      const { config_summary, ...summary } = c;
      return send(res, 200, summary);
    }
    if ((m = /^\/api\/sources\/connections\/([^/]+)\/runs\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      const run = (state.runs.get(m[1]) ?? []).find((r) => r.run_id === m[2]);
      if (!run) return err(res, 404, 'not_found', 'Not found');
      if (run.state === 'running' && !run.totals_known) { run.counters.loaded += 1; run.counters.committed = Math.max(0, run.counters.loaded - 1); run.counters.applied = run.counters.committed; run.updated_at = nowIso(); }
      return send(res, 200, run);
    }
    if (path === '/api/sources/readiness' && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      return send(res, 200, QUESTION_TEMPLATES.map(questionReadiness));
    }

    // ingestion
    if (path === '/api/ingest/replay' && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      const body = await readJson(req);
      if (!body?.connection_id || !Array.isArray(body.events)) return err(res, 422, 'validation', 'connection_id and events required');
      let seq = 2000 + state.journalLive.length;
      for (const e of body.events) {
        seq += 1;
        state.journalLive.push({ entry_id: randomUUID(), tenant_id: TENANT_ID, journal_sequence: seq, track: 'source', record_id: `SRC-RPL-${seq}`, event_type: String(e.kind ?? 'replay.event'), schema_version: 1, connection_id: body.connection_id, provider: 'replay', account_ref: 'replay', provider_event_id: String(e.provider_event_id ?? seq), occurred_at: e.occurred_at ?? nowIso(), recorded_at: nowIso(), entity_refs: e.entity ?? {}, payload: e.payload ?? {}, evidence_refs: [], input_entry_ids: [], derivation_rule: null, derivation_version: null, supersedes_entry_id: null, correlation_id: null, causation_id: null, source_time: e.occurred_at ?? null, summary: `${e.kind ?? 'replay.event'}`, history_kind: 'live' });
      }
      return send(res, 200, { accepted: body.events.length, duplicate: 0, conflict: 0, rejected: 0, committed_cursor: consistency().committed_cursor });
    }
    if (path === '/api/ingest/bank-csv' && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      const body = await readJson(req);
      if (!body?.connection_id || typeof body.csv !== 'string') return err(res, 422, 'validation', 'connection_id and csv required');
      const lines = body.csv.split(/\r?\n/).filter((l) => l.trim());
      const parsed = lines.slice(1).map((l) => { const [date, reference, amount, currency] = l.split(';'); return { date: date ?? '', reference: (reference ?? '').slice(0, 60), amount: amount ?? '', currency: currency ?? '' }; });
      const errors = parsed.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)).map((r) => `invalid date "${r.date}"`);
      if (query.get('preview') === '1') return send(res, 200, { rows: parsed.length, parsed: parsed.slice(0, 20), ambiguous: parsed.filter((r) => !r.reference).length, errors });
      return send(res, 200, { accepted: parsed.length - errors.length, duplicate: 0, conflict: 0, rejected: errors.length, committed_cursor: consistency().committed_cursor });
    }
    if (path === '/api/demo/run' && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      const already = state.demoLoaded;
      state.demoLoaded = true;
      for (const c of state.connections.values()) if (c.demo) { c.last_new_event_at = nowIso(); c.last_import_completed_at = nowIso(); c.last_import_outcome = 'complete'; }
      return send(res, 200, { status: 'loaded', loaded: GOLDEN_ENTRIES.length, connections: Object.values(CONN), already_loaded: already });
    }

    // journal
    if (path === '/api/journal' && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      let entries = journalEntries().sort((a, b) => b.journal_sequence - a.journal_sequence);
      const track = query.get('track'); const event_type = query.get('event_type'); const record_id = query.get('record_id'); const entity = query.get('entity');
      const of = query.get('occurred_from'); const ot = query.get('occurred_to'); const rf = query.get('recorded_from'); const rt = query.get('recorded_to');
      if (track) entries = entries.filter((e) => track.split(',').includes(e.track));
      if (event_type) entries = entries.filter((e) => e.event_type.includes(event_type));
      if (record_id) entries = entries.filter((e) => e.record_id.toLowerCase().includes(record_id.toLowerCase()));
      if (entity) { const [t, ...rest] = entity.split(':'); const id = rest.join(':'); entries = entries.filter((e) => e.entity_refs[t] === id); }
      if (of) entries = entries.filter((e) => e.occurred_at >= of);
      if (ot) entries = entries.filter((e) => e.occurred_at <= ot);
      if (rf) entries = entries.filter((e) => e.recorded_at >= rf);
      if (rt) entries = entries.filter((e) => e.recorded_at <= rt);
      const limit = Math.min(Number(query.get('limit') ?? 50), 500);
      const cursor = Number(query.get('cursor') ?? 0);
      const pageEntries = entries.slice(cursor, cursor + limit);
      return send(res, 200, { entries: pageEntries, page: { next_cursor: cursor + limit < entries.length ? String(cursor + limit) : null, snapshot_cursor: consistency().committed_cursor, truncated: false }, consistency: consistency() });
    }
    if ((m = /^\/api\/journal\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      const all = journalEntries();
      const e = all.find((x) => x.entry_id === m[1] || x.record_id === m[1]);
      if (!e) return err(res, 404, 'not_found', 'Not found');
      const superseded_by = all.find((x) => x.supersedes_entry_id === e.entry_id);
      return send(res, 200, { ...e, superseded_by_entry_id: superseded_by?.entry_id ?? null, derived_entry_ids: all.filter((x) => x.input_entry_ids.includes(e.entry_id)).map((x) => x.entry_id), evidence: e.evidence_refs.map((id) => EVIDENCE[id] ?? { evidence_id: id, status: 'unavailable', reason: 'not_retained' }) });
    }
    if ((m = /^\/api\/entities\/([^/]+)\/([^/]+)\/state$/.exec(path)) && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      return send(res, 200, entityState(m[1], decodeURIComponent(m[2])));
    }
    if ((m = /^\/api\/entities\/([^/]+)\/([^/]+)\/history$/.exec(path)) && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      const id = decodeURIComponent(m[2]);
      const entries = journalEntries().filter((e) => e.entity_refs[m[1]] === id).sort((a, b) => b.journal_sequence - a.journal_sequence);
      return send(res, 200, { entries, page: { next_cursor: null } });
    }
    if (path === '/api/search' && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      const qv = (query.get('q') ?? '').toLowerCase();
      const entries = qv ? journalEntries().filter((e) => e.record_id.toLowerCase().includes(qv) || e.event_type.includes(qv) || Object.values(e.entity_refs).some((v) => v.toLowerCase().includes(qv))).slice(0, 50) : [];
      const entities = qv && state.demoLoaded ? ENTITIES.filter((e) => e.id.toLowerCase().includes(qv) || e.label.toLowerCase().includes(qv)) : [];
      return send(res, 200, { entries, entities, page: { next_cursor: null } });
    }
    if ((m = /^\/api\/evidence\/([^/]+)(\/content)?$/.exec(path)) && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      const e = EVIDENCE[m[1]];
      if (!e) return send(res, 200, { status: 'unavailable', reason: 'not_retained' });
      if (e.status !== 'available') return send(res, 200, { evidence_id: e.evidence_id, status: e.status, reason: e.reason });
      if (m[2]) { res.writeHead(200, { 'Content-Type': e.content_type }); return res.end(e.excerpt); }
      return send(res, 200, { ...e, content: e.excerpt });
    }
    if (path === '/api/schema' && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      return send(res, 200, { tracks: ['source', 'fact', 'commitment', 'movement', 'reservation'], entity_types: ['order', 'line', 'customer', 'item', 'invoice', 'shipment', 'transaction', 'refund', 'payout', 'return', 'reservation', 'bank_entry'] });
    }

    // questions
    if (path === '/api/questions' && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      return send(res, 200, QUESTION_TEMPLATES.map((t) => ({ ...t, readiness: questionReadiness(t) })));
    }
    if (path === '/api/questions/search' && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      const qv = (query.get('q') ?? '').toLowerCase().trim();
      if (!qv) return send(res, 200, { templates: [], entities: [] });
      const words = { stock: 'order-01', sell: 'order-01', cup: 'order-01', invoice: 'invoice-01', outstanding: 'invoice-01', money: 'settlement-01', payout: 'settlement-01', parcel: 'delivery-01', shipment: 'delivery-01', refund: 'reversal-02', return: 'reversal-01', paid: 'collection-01', payment: 'collection-01', lager: 'order-01', rechnung: 'invoice-01', geld: 'settlement-01', paket: 'delivery-01' };
      const ids = new Set(Object.entries(words).filter(([w]) => qv.includes(w)).map(([, id]) => id));
      const templates = QUESTION_TEMPLATES.filter((t) => ids.has(t.id) || t.intent.includes(qv)).map((t) => ({ id: t.id, intent: t.intent }));
      const entities = state.demoLoaded ? ENTITIES.filter((e) => e.id.toLowerCase().includes(qv) || e.label.toLowerCase().includes(qv)) : [];
      return send(res, 200, { templates, entities });
    }
    if ((m = /^\/api\/questions\/([^/]+)$/.exec(path)) && req.method === 'POST') {
      if (!requireAgentOrOwner(req, res)) return;
      const template = QUESTION_TEMPLATES.find((t) => t.intent === decodeURIComponent(m[1]));
      if (!template) return err(res, 404, 'not_found', 'Unknown intent');
      const body = await readJson(req);
      const params = body?.params ?? {};
      for (const r of template.params_schema.required ?? []) if (params[r] === undefined || params[r] === '') return err(res, 422, 'validation', `parameter ${r} is required`, false, { field: r });
      return send(res, 200, answer(template, params));
    }

    // agents
    if (path === '/api/agents' && req.method === 'GET') { if (!requireOwner(req, res)) return; return send(res, 200, state.agents.map(({ _key, ...a }) => a)); }
    if (path === '/api/agents' && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      const body = await readJson(req);
      if (!body?.name?.trim()) return err(res, 422, 'validation', 'name required', false, { field: 'name' });
      const key = `bba_${createHash('sha256').update(randomUUID()).digest('base64url').slice(0, 43)}`;
      const a = { credential_id: randomUUID(), name: String(body.name).trim().slice(0, 60), status: 'active', created_at: nowIso(), last_used_at: null, expires_at: body.expires_at ?? null, revoked_at: null, grant: 'workspace.read_business', _key: key };
      state.agents.push(a);
      return send(res, 201, { credential_id: a.credential_id, key });
    }
    if ((m = /^\/api\/agents\/([^/]+)\/revoke$/.exec(path)) && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      const a = state.agents.find((x) => x.credential_id === m[1]);
      if (!a) return err(res, 404, 'not_found', 'Not found');
      a.status = 'revoked'; a.revoked_at = nowIso();
      return send(res, 204);
    }
    if (path === '/api/agents/mcp-config' && req.method === 'GET') {
      if (!requireOwner(req, res)) return;
      const config = { mcpServers: { blackbox: { command: 'node', args: ['<install-dir>/mcp/bridge.js'], env: { BLACKBOX_AGENT_KEY_FILE: '<install-dir>/secrets/agent-<name>.key', BLACKBOX_API_ORIGIN: 'http://127.0.0.1:19180' } } } };
      return send(res, 200, { transport: 'stdio', key_placeholder: '<AGENT_KEY>', env_var: 'BLACKBOX_AGENT_KEY', key_file_env_var: 'BLACKBOX_AGENT_KEY_FILE', config_json: JSON.stringify(config, null, 2), bridge_command: 'node <install-dir>/mcp/bridge.js', tested_clients: [{ name: '@modelcontextprotocol/inspector', version: '0.x (mock)', transport: 'stdio' }] });
    }

    // review
    if (path === '/api/review/cases' && req.method === 'GET') {
      if (!requireAgentOrOwner(req, res)) return;
      const st = query.get('state');
      return send(res, 200, state.reviewCases.filter((c) => !st || c.state === st));
    }
    if ((m = /^\/api\/review\/cases\/([^/]+)\/actions$/.exec(path)) && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      const c = state.reviewCases.find((x) => x.case_id === m[1]);
      if (!c) return err(res, 404, 'not_found', 'Not found');
      const body = await readJson(req);
      if (!body || !c.available_actions.includes(body.action)) return err(res, 422, 'validation', 'action not available');
      if (Number(body.revision) !== c.revision) return err(res, 409, 'stale_revision', 'Case changed since you loaded it', true, { current_revision: c.revision });
      if (body.action !== 'leave_open' && !body.reason?.trim()) return err(res, 422, 'validation', 'reason required', false, { field: 'reason' });
      c.revision += 1; c.updated_at = nowIso();
      c.history.push({ actor: 'owner', at: nowIso(), action: body.action, reason: body.reason });
      if (body.action === 'leave_open') c.state = 'open';
      else if (body.action === 'retry') { c.state = 'in_progress'; c.recalculating = true; c.required_cursor = consistency().committed_cursor + 1; c.applied_cursor = consistency().applied_cursor; setTimeout(() => { c.recalculating = false; c.applied_cursor = c.required_cursor; c.state = 'resolved'; c.revision += 1; c.history.push({ actor: 'engine', at: nowIso(), action: 'recalculated' }); }, 4000); }
      else { c.state = 'in_progress'; c.recalculating = true; c.required_cursor = consistency().committed_cursor + 1; c.applied_cursor = consistency().applied_cursor; setTimeout(() => { c.recalculating = false; c.applied_cursor = c.required_cursor; c.state = 'resolved'; c.revision += 1; c.history.push({ actor: 'engine', at: nowIso(), action: 'recalculated' }); }, 4000); }
      return send(res, 200, c);
    }

    // settings
    if (path === '/api/settings/backups') {
      if (!requireOwner(req, res)) return;
      if (req.method === 'PATCH') { const body = await readJson(req); if (body?.retention) state.backups.retention = { daily: Math.max(1, Number(body.retention.daily ?? 7)), weekly: Math.max(0, Number(body.retention.weekly ?? 4)) }; }
      return send(res, 200, state.backups);
    }
    if (path === '/api/settings/backups/run' && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      if (state.backups.status === 'not_configured') return err(res, 409, 'backup_not_configured', 'No backup destination is enrolled. Enrol one with ./blackbox backup setup.');
      state.backups.status = 'running'; state.backups.last_attempt_at = nowIso();
      setTimeout(() => { state.backups.status = 'scheduled'; state.backups.last_completed_at = nowIso(); state.backups.last_cutoff = nowIso(); state.backups.next_due_at = new Date(Date.now() + 86400000).toISOString(); state.backups.recoverable_age_seconds = 0; }, 3000);
      return send(res, 202, { run_id: randomUUID(), state: 'running' });
    }
    if (path === '/api/settings/retention') {
      if (!requireOwner(req, res)) return;
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        for (const patch of body?.classes ?? []) { const cls = state.retention.classes.find((c) => c.id === patch.id); if (!cls) continue; const days = Number(patch.days); if (!Number.isInteger(days) || days < cls.min_days || days > cls.max_days) return err(res, 422, 'validation', `days out of bounds for ${cls.id}`, false, { field: cls.id }); if (cls.provider_limit_days && days > cls.provider_limit_days) return err(res, 422, 'validation', `provider limit ${cls.provider_limit_days} days for ${cls.id}`, false, { field: cls.id }); cls.days = days; }
      }
      return send(res, 200, state.retention);
    }
    if (path === '/api/settings/storage') {
      if (!requireOwner(req, res)) return;
      if (req.method === 'PATCH') { const body = await readJson(req); const t = body?.thresholds; if (!t || [t.warning_percent, t.critical_percent].some((v) => !(v > 0 && v < 100)) || !(t.warning_bytes > 0) || !(t.critical_bytes > 0)) return err(res, 422, 'validation', 'thresholds must be positive and below 100 %'); state.storageThresholds = t; }
      return send(res, 200, { thresholds: state.storageThresholds, volumes: volumes() });
    }
    if (path === '/api/settings/security' && req.method === 'GET') {
      if (!requireOwner(req, res)) return;
      return send(res, 200, { counts: { owner_logins: 3, failed_logins: state.failures.length, key_rotations: 0, agent_keys_created: state.agents.length, agent_keys_revoked: state.agents.filter((a) => a.status === 'revoked').length, resets: 0 }, last_events: [{ at: minutesAgo(5), event: 'owner.login', actor: 'owner' }, { at: minutesAgo(90), event: 'setup.owner_created', actor: 'wrapper' }], owner_sessions_active: state.sessions.size, agent_keys_active: state.agents.filter((a) => a.status === 'active').length });
    }

    // diagnostics
    if (path === '/api/diagnostics/health' && req.method === 'GET') { if (!requireOwner(req, res)) return; return send(res, 200, healthCards()); }
    if (path === '/api/diagnostics/logs' && req.method === 'GET') {
      if (!requireOwner(req, res)) return;
      const f = parseLogFilters(query);
      const limit = Math.min(Math.max(Number(query.get('limit') ?? 200), 1), 1000);
      const all = [...state.logs].reverse().filter((r) => matchesLogFilter(r, f));
      const cursor = query.get('cursor');
      let start = 0;
      if (cursor) { const idx = all.findIndex((r) => r.record_id === cursor); start = idx >= 0 ? idx + 1 : 0; }
      const records = all.slice(start, start + limit);
      const retained_from = state.logs[0]?.occurred_at ?? null; const retained_to = state.logs.at(-1)?.occurred_at ?? null;
      let st = 'ok';
      if (!records.length) st = f.since && retained_from && f.since < retained_from ? 'out_of_retention' : f.levels?.includes('DEBUG') && !state.debug.active ? 'debug_not_recorded' : 'empty';
      return send(res, 200, { records, page: { next_cursor: start + limit < all.length ? records.at(-1).record_id : null }, retained_from, retained_to, dropped_count: 12, state: st });
    }
    if (path === '/api/diagnostics/logs/stream' && req.method === 'GET') {
      if (!requireOwner(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      const client = { res, filters: parseLogFilters(query), paused: false };
      sseClients.add(client);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
      return;
    }
    if ((m = /^\/api\/diagnostics\/logs\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      if (!requireOwner(req, res)) return;
      const rec = state.logs.find((r) => r.record_id === m[1]);
      if (!rec) return err(res, 404, 'not_found', 'Record not retained');
      return send(res, 200, { record: rec, trace_siblings: state.logs.filter((r) => r.trace_id === rec.trace_id && r.record_id !== rec.record_id) });
    }
    if (path === '/api/diagnostics/debug') {
      if (!requireOwner(req, res)) return;
      if (req.method === 'POST') {
        const body = await readJson(req);
        const minutes = Number(body?.minutes);
        if (!COMPONENTS.includes(body?.component)) return err(res, 422, 'validation', 'unknown component', false, { field: 'component' });
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 15) return err(res, 422, 'validation', 'minutes must be 1..15', false, { field: 'minutes' });
        state.debug = { active: true, expires_at: new Date(Date.now() + minutes * 60000).toISOString(), scope: { component: body.component, connection_id: body.connection_id ?? null, run_id: body.run_id ?? null } };
        setTimeout(() => { state.debug = { active: false, expires_at: null, scope: null }; }, minutes * 60000).unref();
      } else if (req.method === 'DELETE') state.debug = { active: false, expires_at: null, scope: null };
      return send(res, 200, state.debug);
    }
    if (path === '/api/diagnostics/export' && req.method === 'POST') {
      if (!requireOwner(req, res)) return;
      const body = await readJson(req);
      if (!body?.since || !body?.until || !Array.isArray(body.categories)) return err(res, 422, 'validation', 'since, until and categories required');
      const preview = { size_bytes: 1_240_000, truncated: false, unavailable: body.categories.includes('engine_heap') ? ['engine_heap'] : [], categories: body.categories, since: body.since, until: body.until };
      if (query.get('preview') === '1') return send(res, 200, { preview });
      const bundle = JSON.stringify({ bundle: 'blackbox-diagnostics', generated_at: nowIso(), pseudonymized: true, categories: body.categories, note: 'mock bundle; a real export is a zip <= 10 MiB' });
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="blackbox-diagnostics-${Date.now()}.zip"` });
      return res.end(bundle);
    }
    if (path === '/api/diagnostics/storage' && req.method === 'GET') {
      if (!requireOwner(req, res)) return;
      return send(res, 200, { volumes: volumes(), logs: { retained_from: state.logs[0]?.occurred_at ?? null, retained_to: state.logs.at(-1)?.occurred_at ?? null, retained_bytes: 18_300_000, cap_bytes: 104_857_600, cap_days: 7, dropped_count: 12, index_bytes: 420_000 }, thresholds: state.storageThresholds });
    }

    return err(res, 404, 'not_found', `No mock route for ${req.method} ${path}`);
  } catch (e) {
    console.error(e);
    return err(res, 500, 'internal', 'Mock failure');
  }
});

function volumes() {
  return [
    { id: 'pgdata', used_bytes: 1.2 * 1024 ** 3, free_bytes: 180 * 1024 ** 3, total_bytes: 460 * 1024 ** 3, state: 'ok' },
    { id: 'evidence', used_bytes: 0.3 * 1024 ** 3, free_bytes: 180 * 1024 ** 3, total_bytes: 460 * 1024 ** 3, state: 'ok' },
    { id: 'logs', used_bytes: 18_300_000, free_bytes: 180 * 1024 ** 3, total_bytes: 460 * 1024 ** 3, state: 'ok' },
    { id: 'backups', used_bytes: 0, free_bytes: 0, total_bytes: 0, state: 'unknown' },
  ].map((v) => ({ ...v, used_bytes: Math.round(v.used_bytes) }));
}

function resolvePlan(body) {
  const nowMs = Date.now();
  const cutoff = new Date(nowMs).toISOString();
  const tz = body.timezone;
  const localMidnightUtc = (y, mo, d) => {
    // Resolve local midnight in tz to UTC using Intl (DST-safe for the given date).
    const guess = Date.UTC(y, mo - 1, d, 0, 0, 0);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    return new Date(guess - (localAsUtc - guess)).toISOString();
  };
  const localNow = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  const [y, mo, d] = localNow.split('-').map(Number);
  switch (body.preset) {
    case 'last_30_days': return { requested_from: new Date(nowMs - 30 * 86400000).toISOString(), initial_cutoff: cutoff };
    case 'this_year': return { requested_from: localMidnightUtc(y, 1, 1), initial_cutoff: cutoff };
    case 'last_12_months': { let my = y - 1; const mm = mo; const last = new Date(Date.UTC(my, mm, 0)).getUTCDate(); return { requested_from: localMidnightUtc(my, mm, Math.min(d, last)), initial_cutoff: cutoff }; }
    case 'custom': {
      if (!body.from || !/^\d{4}-\d{2}-\d{2}$/.test(body.from)) return { error: 'from must be YYYY-MM-DD' };
      const [fy, fm, fd] = body.from.split('-').map(Number);
      const from = localMidnightUtc(fy, fm, fd);
      if (from > cutoff) return { error: 'from must not be in the future' };
      return { requested_from: from, initial_cutoff: cutoff };
    }
    case 'from_now': return { requested_from: null, initial_cutoff: cutoff };
    default: return { error: 'invalid preset' };
  }
}

server.listen(PORT, HOST, () => {
  console.log(`[mock-api] listening on http://${HOST}:${PORT} (owner key from BLACKBOX_E2E_KEY or default demo key)`);
});
