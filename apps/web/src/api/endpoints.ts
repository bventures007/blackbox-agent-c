import { api, apiBlob } from './client';
import type {
  AgentCredential,
  BackupSettings,
  Catalogue,
  ConnectionDetail,
  ConnectionSummary,
  DebugState,
  DiagnosticsStorage,
  EntityState,
  EvidenceMeta,
  ExportPreview,
  HealthResponse,
  ImportPlan,
  ImportPreset,
  ImportRun,
  JournalEntry,
  JournalEntryDetail,
  JournalPage,
  Locale,
  LogRecord,
  LogsPage,
  McpConfig,
  QuestionReadiness,
  QuestionResult,
  QuestionTemplate,
  RetentionSettings,
  ReviewAction,
  ReviewCase,
  SearchResult,
  SecurityAudit,
  SessionInfo,
  StorageSettings,
  Workspace,
} from './types';

export const auth = {
  login: (key: string, remember: boolean) => api<void>('/api/auth/login', { method: 'POST', body: { key, remember } }),
  logout: () => api<void>('/api/auth/logout', { method: 'POST' }),
  session: () => api<SessionInfo>('/api/auth/session'),
  rotateKey: (current_key: string) => api<{ new_key: string }>('/api/auth/rotate-key', { method: 'POST', body: { current_key } }),
};

export const workspace = {
  get: () => api<Workspace>('/api/workspace'),
  patch: (patch: { display_name?: string; locale?: Locale }) => api<Workspace>('/api/workspace', { method: 'PATCH', body: patch }),
};

export const sources = {
  catalogue: () => api<Catalogue>('/api/sources'),
  createConnection: (body: { provider: string; display_name: string; config: Record<string, unknown>; secret?: Record<string, unknown> }) =>
    api<ConnectionSummary>('/api/sources/connections', { method: 'POST', body }),
  connection: (id: string) => api<ConnectionDetail>(`/api/sources/connections/${encodeURIComponent(id)}`),
  importPlan: (
    id: string,
    body: { preset: ImportPreset; from?: string; to?: string; timezone: string; include_open_context: boolean; include_opening_state?: boolean },
  ) => api<ImportPlan>(`/api/sources/connections/${encodeURIComponent(id)}/import-plan`, { method: 'POST', body }),
  startRun: (id: string, kind: 'backfill' | 'incremental' | 'reconcile' | 'check') =>
    api<ImportRun>(`/api/sources/connections/${encodeURIComponent(id)}/runs`, { method: 'POST', body: { kind } }),
  run: (id: string, runId: string) => api<ImportRun>(`/api/sources/connections/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`),
  pause: (id: string) => api<ConnectionSummary>(`/api/sources/connections/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  resume: (id: string) => api<ConnectionSummary>(`/api/sources/connections/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  disconnect: (id: string) => api<ConnectionSummary>(`/api/sources/connections/${encodeURIComponent(id)}/disconnect`, { method: 'POST' }),
  readiness: () => api<QuestionReadiness[]>('/api/sources/readiness'),
};

export const ingest = {
  replay: (connection_id: string, events: unknown[]) =>
    api<{ accepted: number; duplicate: number; conflict: number; rejected: number; committed_cursor: number }>('/api/ingest/replay', {
      method: 'POST',
      body: { connection_id, events },
    }),
  bankCsvPreview: (connection_id: string, csv: string, mapping?: Record<string, string>) =>
    api<{ rows: number; parsed: Array<Record<string, string>>; ambiguous: number; errors: string[] }>('/api/ingest/bank-csv', {
      method: 'POST',
      body: { connection_id, csv, mapping },
      query: { preview: 1 },
    }),
  bankCsvCommit: (connection_id: string, csv: string, mapping?: Record<string, string>) =>
    api<{ accepted: number; duplicate: number; conflict: number; rejected: number; committed_cursor: number }>('/api/ingest/bank-csv', {
      method: 'POST',
      body: { connection_id, csv, mapping },
    }),
  demoRun: (confirm = false) =>
    api<{ status: string; loaded: number; connections: string[]; already_loaded: boolean }>('/api/demo/run', { method: 'POST', body: { confirm } }),
};

export const journal = {
  list: (query: Record<string, string | number | null | undefined>) => api<JournalPage>('/api/journal', { query }),
  entry: (id: string) => api<JournalEntryDetail>(`/api/journal/${encodeURIComponent(id)}`),
  entityState: (type: string, id: string, query?: Record<string, string | undefined>) =>
    api<EntityState>(`/api/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}/state`, { query }),
  entityHistory: (type: string, id: string, query?: Record<string, string | number | undefined>) =>
    api<{ entries: JournalEntry[]; page: { next_cursor: string | null } }>(`/api/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}/history`, { query }),
  search: (q: string, query?: Record<string, string | undefined>) =>
    api<{ entries: JournalEntry[]; entities: SearchResult['entities']; page: { next_cursor: string | null } }>('/api/search', { query: { q, ...query } }),
  evidence: (id: string) => api<EvidenceMeta & { content?: string }>(`/api/evidence/${encodeURIComponent(id)}`),
};

export const questions = {
  list: () => api<QuestionTemplate[]>('/api/questions'),
  ask: (intent: string, params: Record<string, unknown>, consistency?: { mode: string; cursor?: number }) =>
    api<QuestionResult>(`/api/questions/${encodeURIComponent(intent)}`, { method: 'POST', body: { params, consistency } }),
  search: (q: string) => api<SearchResult>('/api/questions/search', { query: { q } }),
};

export const agents = {
  list: () => api<AgentCredential[]>('/api/agents'),
  create: (name: string, expires_at?: string) => api<{ credential_id: string; key: string }>('/api/agents', { method: 'POST', body: { name, expires_at } }),
  revoke: (id: string) => api<void>(`/api/agents/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  mcpConfig: () => api<McpConfig>('/api/agents/mcp-config'),
};

export const review = {
  list: (state?: string) => api<ReviewCase[]>('/api/review/cases', { query: { state } }),
  act: (id: string, body: { action: ReviewAction; revision: number; reason: string; payload?: unknown }) =>
    api<ReviewCase>(`/api/review/cases/${encodeURIComponent(id)}/actions`, { method: 'POST', body }),
};

export const settings = {
  backups: () => api<BackupSettings>('/api/settings/backups'),
  patchBackups: (patch: Partial<BackupSettings>) => api<BackupSettings>('/api/settings/backups', { method: 'PATCH', body: patch }),
  runBackup: () => api<{ run_id: string; state: string }>('/api/settings/backups/run', { method: 'POST' }),
  retention: () => api<RetentionSettings>('/api/settings/retention'),
  patchRetention: (classes: Array<{ id: string; days: number }>) => api<RetentionSettings>('/api/settings/retention', { method: 'PATCH', body: { classes } }),
  storage: () => api<StorageSettings>('/api/settings/storage'),
  patchStorage: (thresholds: StorageSettings['thresholds']) => api<StorageSettings>('/api/settings/storage', { method: 'PATCH', body: { thresholds } }),
  security: () => api<SecurityAudit>('/api/settings/security'),
};

export const diagnostics = {
  health: (signal?: AbortSignal) => api<HealthResponse>('/api/diagnostics/health', { signal }),
  logs: (query: Record<string, string | number | null | undefined>) => api<LogsPage>('/api/diagnostics/logs', { query }),
  record: (id: string) => api<{ record: LogRecord; trace_siblings: LogRecord[] }>(`/api/diagnostics/logs/${encodeURIComponent(id)}`),
  debug: () => api<DebugState>('/api/diagnostics/debug'),
  startDebug: (body: { component: string; connection_id?: string; run_id?: string; minutes: number }) =>
    api<DebugState>('/api/diagnostics/debug', { method: 'POST', body }),
  stopDebug: () => api<DebugState>('/api/diagnostics/debug', { method: 'DELETE' }),
  exportPreview: (body: { since: string; until: string; categories: string[] }) =>
    api<ExportPreview>('/api/diagnostics/export', { method: 'POST', body, query: { preview: 1 } }),
  exportDownload: (body: { since: string; until: string; categories: string[] }) => apiBlob('/api/diagnostics/export', { method: 'POST', body }),
  storage: () => api<DiagnosticsStorage>('/api/diagnostics/storage'),
};
