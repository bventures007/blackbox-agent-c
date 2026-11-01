import { api, apiBlob } from './client';
import { adaptCatalogue, adaptConnection, adaptConnectionDetail, adaptReviewCase } from './adapters';
import type {
  AgentCredential,
  BackupSettings,
  Catalogue,
  ConnectionDetail,
  ConnectionSummary,
  DebugState,
  EntityState,
  EvidenceResponse,
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
  StorageInfo,
  StorageThresholds,
  Workspace,
} from './types';

export const auth = {
  login: (key: string, remember: boolean) => api<void>('/api/auth/login', { method: 'POST', body: { key, remember } }),
  logout: () => api<void>('/api/auth/logout', { method: 'POST' }),
  session: () => api<SessionInfo>('/api/auth/session'),
  rotateKey: (current_key: string) => api<{ new_key: string; notice?: string }>('/api/auth/rotate-key', { method: 'POST', body: { current_key } }),
};

export const workspace = {
  get: () => api<Workspace>('/api/workspace'),
  patch: (patch: { display_name?: string; locale?: Locale }) => api<Workspace>('/api/workspace', { method: 'PATCH', body: patch }),
};

type RawConnection = Parameters<typeof adaptConnection>[0];

export const sources = {
  catalogue: async (): Promise<Catalogue> => adaptCatalogue(await api<Parameters<typeof adaptCatalogue>[0]>('/api/sources')),
  createConnection: async (body: { provider: string; display_name: string; config: Record<string, unknown>; secret?: Record<string, unknown> }): Promise<ConnectionSummary & { producer?: { producer_id: string; secret: string; notice: string } }> => {
    const r = await api<{ connection: RawConnection; producer?: { producer_id: string; secret: string; notice: string } }>('/api/sources/connections', { method: 'POST', body });
    return { ...adaptConnection(r.connection), producer: r.producer };
  },
  connection: async (id: string): Promise<ConnectionDetail> => adaptConnectionDetail(await api<Parameters<typeof adaptConnectionDetail>[0]>(`/api/sources/connections/${encodeURIComponent(id)}`)),
  importPlan: (
    id: string,
    body: { preset: ImportPreset; from?: string; to?: string; timezone: string; include_open_context: boolean; include_opening_state?: boolean },
  ) => api<ImportPlan>(`/api/sources/connections/${encodeURIComponent(id)}/import-plan`, { method: 'POST', body }),
  startRun: (id: string, kind: 'backfill' | 'incremental' | 'reconcile' | 'check') =>
    api<ImportRun & { runs?: ImportRun[] }>(`/api/sources/connections/${encodeURIComponent(id)}/runs`, { method: 'POST', body: { kind } }),
  run: (id: string, runId: string) => api<ImportRun>(`/api/sources/connections/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`),
  pause: async (id: string) => adaptConnection(await api<RawConnection>(`/api/sources/connections/${encodeURIComponent(id)}/pause`, { method: 'POST' })),
  resume: async (id: string) => adaptConnection(await api<RawConnection>(`/api/sources/connections/${encodeURIComponent(id)}/resume`, { method: 'POST' })),
  disconnect: async (id: string) => adaptConnection(await api<RawConnection>(`/api/sources/connections/${encodeURIComponent(id)}/disconnect`, { method: 'POST' })),
  readiness: () => api<{ observed_at: string; datasets_present: string[]; datasets_missing: string[]; questions: QuestionReadiness[] }>('/api/sources/readiness'),
};

export interface IngestResult {
  accepted: number;
  duplicate: number;
  conflict: number;
  rejected: number;
  committed_cursor: number | null;
}

export const ingest = {
  replay: (connection_id: string, events: unknown[]) => api<IngestResult>('/api/ingest/replay', { method: 'POST', body: { connection_id, events } }),
  bankCsvPreview: (connection_id: string, csv: string, mapping?: Record<string, string>) =>
    api<{ rows: number; parsed: Array<Record<string, unknown>>; ambiguous: number; errors: string[] }>('/api/ingest/bank-csv', {
      method: 'POST',
      body: { connection_id, csv, mapping },
      query: { preview: 1 },
    }),
  bankCsvCommit: (connection_id: string, csv: string, mapping?: Record<string, string>) =>
    api<IngestResult & { rows: number; ambiguous: number; errors: string[] }>('/api/ingest/bank-csv', { method: 'POST', body: { connection_id, csv, mapping } }),
  /** Loads the labeled GOLDEN scenario into demo connections. The API answers 409 `confirmation_required` when non-demo connections already hold data. */
  demoRun: (confirm = false) =>
    api<IngestResult & { connections: string[]; run_id: string; checkpoints?: unknown }>('/api/demo/run', { method: 'POST', body: { confirm } }),
};

export const journal = {
  list: (query: Record<string, string | number | null | undefined>) => api<JournalPage>('/api/journal', { query }),
  entry: async (id: string): Promise<JournalEntryDetail> => {
    const r = await api<{ entry: JournalEntry; supersedes: JournalEntry | null; superseded_by: JournalEntry[]; derived_from: JournalEntry[]; derivations: JournalEntry[] }>(`/api/journal/${encodeURIComponent(id)}`);
    return { ...r.entry, supersedes: r.supersedes ?? null, superseded_by: r.superseded_by ?? [], derived_from: r.derived_from ?? [], derivations: r.derivations ?? [] };
  },
  entityState: (type: string, id: string, query?: Record<string, string | undefined>) =>
    api<EntityState>(`/api/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}/state`, { query }),
  entityHistory: (type: string, id: string, query?: Record<string, string | number | undefined>) =>
    api<{ entries: JournalEntry[]; page: { next_cursor: string | null; truncated?: boolean } }>(`/api/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}/history`, { query }),
  /** Literal search over record ids / event types / entity refs (never free text to a model). */
  search: (q: string, query?: Record<string, string | undefined>) =>
    api<{ entries: JournalEntry[]; page: { next_cursor: string | null }; search: { literal: string; fields: string[] } }>('/api/search', { query: { q, ...query } }),
  evidence: (id: string) => api<EvidenceResponse>(`/api/evidence/${encodeURIComponent(id)}`),
};

export const questions = {
  list: async (): Promise<QuestionTemplate[]> => {
    const r = await api<{ questions: Array<Omit<QuestionTemplate, 'readiness'> & { readiness: QuestionReadiness | null }> }>('/api/questions');
    return r.questions.map((q) => ({ ...q, readiness: q.readiness ?? { question_id: q.id, intent: q.intent, status: 'not_applicable', missing: [], sources: [] } }));
  },
  ask: (intent: string, params: Record<string, unknown>, consistency?: { mode: string; cursor?: number }) =>
    api<QuestionResult>(`/api/questions/${encodeURIComponent(intent)}`, { method: 'POST', body: { params, consistency } }),
  search: async (q: string): Promise<SearchResult> => {
    const r = await api<{ matches: Array<{ id: string; intent: string; question?: string }>; note?: string }>('/api/questions/search', { query: { q } });
    return { templates: r.matches.map((m) => ({ id: m.id, intent: m.intent, question: m.question })), entities: [] };
  },
};

export const agents = {
  list: () => api<AgentCredential[]>('/api/agents'),
  create: (name: string, expires_at?: string) => api<{ credential_id: string; key: string; grant: string; notice?: string }>('/api/agents', { method: 'POST', body: { name, expires_at } }),
  revoke: (id: string) => api<void>(`/api/agents/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  mcpConfig: () => api<McpConfig>('/api/agents/mcp-config'),
};

export const review = {
  list: async (state?: string): Promise<ReviewCase[]> => (await api<{ cases: Parameters<typeof adaptReviewCase>[0][] }>('/api/review/cases', { query: { state } })).cases.map(adaptReviewCase),
  act: async (id: string, body: { action: ReviewAction; revision: number; reason: string; payload?: unknown }): Promise<ReviewCase> =>
    adaptReviewCase(await api<Parameters<typeof adaptReviewCase>[0]>(`/api/review/cases/${encodeURIComponent(id)}/actions`, { method: 'POST', body })),
};

export const settings = {
  backups: () => api<BackupSettings>('/api/settings/backups'),
  patchBackups: (patch: { retention_daily?: number; retention_weekly?: number }) => api<BackupSettings>('/api/settings/backups', { method: 'PATCH', body: patch }),
  runBackup: () => api<unknown>('/api/settings/backups/run', { method: 'POST' }),
  retention: () => api<RetentionSettings>('/api/settings/retention'),
  patchRetention: (classes: Record<string, number>) => api<RetentionSettings>('/api/settings/retention', { method: 'PATCH', body: classes }),
  storage: () => api<StorageInfo>('/api/settings/storage'),
  patchStorage: (thresholds: Partial<StorageThresholds>) => api<StorageInfo>('/api/settings/storage', { method: 'PATCH', body: thresholds }),
  security: () => api<SecurityAudit>('/api/settings/security'),
};

export const diagnostics = {
  health: (signal?: AbortSignal) => api<HealthResponse>('/api/diagnostics/health', { signal }),
  logs: (query: Record<string, string | number | null | undefined>) => api<LogsPage>('/api/diagnostics/logs', { query }),
  record: (id: string) => api<{ record: LogRecord; siblings: LogRecord[] }>(`/api/diagnostics/logs/${encodeURIComponent(id)}`),
  debug: () => api<DebugState>('/api/diagnostics/debug'),
  startDebug: (body: { component: string; connection_id?: string; run_id?: string; minutes: number }) =>
    api<DebugState>('/api/diagnostics/debug', { method: 'POST', body }),
  stopDebug: () => api<DebugState>('/api/diagnostics/debug', { method: 'DELETE' }),
  exportPreview: (body: { since: string; until: string; categories: string[] }) =>
    api<ExportPreview>('/api/diagnostics/export', { method: 'POST', body, query: { preview: 1 } }),
  exportDownload: (body: { since: string; until: string; categories: string[] }) => apiBlob('/api/diagnostics/export', { method: 'POST', body }),
  storage: () => api<StorageInfo>('/api/diagnostics/storage'),
};
