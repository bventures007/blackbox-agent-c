import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeading, toast } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { CopyButton, DefinitionList, Drawer, ErrorNote, Field, Loading, Modal, StatusBadge } from '../components/ui';
import { diagnostics as diagApi } from '../api/endpoints';
import { buildQuery } from '../api/client';
import type { HealthCard, LogLevel, LogRecord, LogsPage } from '../api/types';
import { useAsync } from '../hooks';
import { fromLocalDateTimeInput, toLocalDateTimeInput, useFormat } from '../format';

const LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const COMPONENTS = ['api', 'worker', 'engine', 'postgres', 'mcp', 'wrapper', 'diagnostics'];
const PROVIDERS = ['shopify', 'shopify_payments', 'bank_csv', 'generic', 'replay'];
const EXPORT_CATEGORIES = ['versions', 'runtime', 'configuration', 'health', 'error_counts', 'log_excerpts', 'engine_heap'];
const STALE_MS = 30_000;

interface Filters {
  level_min: LogLevel;
  levels: LogLevel[];
  since: string;
  until: string;
  component: string[];
  provider: string[];
  connection_id: string;
  run_id: string;
  trace_id: string;
  q: string;
}

/** Owner-only System & Diagnostics (specs/SYSTEM-AND-DIAGNOSTICS.md). Filters live in component state; the URL only carries opaque internal IDs from deep links. */
export function SystemView() {
  const { t } = useTranslation();
  const f = useFormat();
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => ({
    level_min: 'INFO',
    levels: [],
    since: toLocalDateTimeInput(new Date(Date.now() - 3600_000).toISOString()),
    until: '',
    component: [],
    provider: [],
    connection_id: params.get('connection_id') ?? '',
    run_id: params.get('run_id') ?? '',
    trace_id: params.get('trace_id') ?? '',
    q: '',
  }));
  const [applied, setApplied] = useState<Filters>(filters);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [liveState, setLiveState] = useState<'connecting' | 'open' | 'reconnecting' | 'closed'>('closed');
  const [newCount, setNewCount] = useState(0);
  const pendingRef = useRef<LogRecord[]>([]);
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [page, setPage] = useState<LogsPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    document.title = `${t('nav.system')} — ${t('meta.title')}`;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [t]);

  // Health: 5 s refresh while the view is open; stale/disconnected states derived from observed_at and transport failures.
  const health = useAsync(() => diagApi.health(), [], 5000);
  const storage = useAsync(() => diagApi.storage(), [], 15000);
  const debug = useAsync(() => diagApi.debug(), [], 5000);

  const queryFor = useCallback(
    (fl: Filters, cursor?: string | null) => ({
      level_min: fl.levels.length ? undefined : fl.level_min,
      levels: fl.levels.length ? fl.levels.join(',') : undefined,
      since: fromLocalDateTimeInput(fl.since) ?? undefined,
      until: fromLocalDateTimeInput(fl.until) ?? undefined,
      component: fl.component.join(',') || undefined,
      provider: fl.provider.join(',') || undefined,
      connection_id: fl.connection_id || undefined,
      run_id: fl.run_id || undefined,
      trace_id: fl.trace_id || undefined,
      q: fl.q || undefined,
      cursor: cursor ?? undefined,
      limit: 200,
    }),
    [],
  );

  const load = useCallback(
    async (fl: Filters, cursor?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const p = await diagApi.logs(queryFor(fl, cursor));
        setPage(p);
        setRecords((prev) => (cursor ? [...prev, ...p.records.filter((r) => !prev.some((x) => x.record_id === r.record_id))] : p.records));
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [queryFor],
  );
  useEffect(() => {
    void load(applied);
  }, [applied, load]);

  // Live mode: SSE with the same filters; pause freezes the displayed position and counts new records.
  useEffect(() => {
    if (!live) {
      setLiveState('closed');
      return;
    }
    let es: EventSource | null = null;
    let closed = false;
    const connect = () => {
      setLiveState((s) => (s === 'open' ? 'reconnecting' : 'connecting'));
      es = new EventSource(`/api/diagnostics/logs/stream${buildQuery({ ...queryFor(applied), cursor: undefined, limit: undefined })}`, { withCredentials: true });
      es.onopen = () => setLiveState('open');
      es.addEventListener('record', (ev) => {
        const rec = JSON.parse((ev as MessageEvent).data) as LogRecord;
        if (pausedRef.current) {
          pendingRef.current.push(rec);
          setNewCount(pendingRef.current.length);
        } else {
          setRecords((prev) => (prev.some((r) => r.record_id === rec.record_id) ? prev : [rec, ...prev].slice(0, 1000)));
        }
      });
      es.onerror = () => {
        setLiveState('reconnecting');
        es?.close();
        if (!closed) setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
    };
  }, [live, applied, queryFor]);
  const pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  const resume = () => {
    const pending = pendingRef.current;
    pendingRef.current = [];
    setNewCount(0);
    setPaused(false);
    setRecords((prev) => [...pending.reverse().filter((r) => !prev.some((x) => x.record_id === r.record_id)), ...prev].slice(0, 1000));
  };

  const apply = () => {
    setApplied(filters);
    setRecords([]);
  };
  const reset = () => {
    const fresh: Filters = { level_min: 'INFO', levels: [], since: toLocalDateTimeInput(new Date(Date.now() - 3600_000).toISOString()), until: '', component: [], provider: [], connection_id: '', run_id: '', trace_id: '', q: '' };
    setFilters(fresh);
    setApplied(fresh);
    setRecords([]);
  };
  const warningsPreset = () => {
    const next = { ...filters, levels: ['WARN', 'ERROR'] as LogLevel[] };
    setFilters(next);
    setApplied(next);
    setRecords([]);
  };
  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const activeFilters = useMemo(() => {
    const items: string[] = [];
    if (applied.levels.length) items.push(`${t('system.filters.levels')}: ${applied.levels.join(', ')}`);
    else items.push(`${t('system.filters.levelMin')}: ${applied.level_min}`);
    if (applied.since) items.push(`${t('system.filters.since')}: ${f.dateTime(fromLocalDateTimeInput(applied.since))}`);
    if (applied.until) items.push(`${t('system.filters.until')}: ${f.dateTime(fromLocalDateTimeInput(applied.until))}`);
    if (applied.component.length) items.push(`${t('system.filters.component')}: ${applied.component.join(', ')}`);
    if (applied.provider.length) items.push(`${t('system.filters.provider')}: ${applied.provider.join(', ')}`);
    if (applied.connection_id) items.push(`${t('system.filters.connection')}: ${applied.connection_id.slice(0, 8)}…`);
    if (applied.run_id) items.push(`${t('system.filters.run')}: ${applied.run_id.slice(0, 8)}…`);
    if (applied.trace_id) items.push(`${t('system.filters.trace')}: ${applied.trace_id}`);
    if (applied.q) items.push(`${t('system.filters.search')}: "${applied.q}"`);
    return items;
  }, [applied, t, f]);

  const transportFailed = Boolean(health.error);
  const cards = health.data?.cards ?? [];

  return (
    <>
      <PageHeading
        title={t('system.title')}
        subtitle={t('system.subtitle')}
        actions={
          <button type="button" className="btn secondary" onClick={() => setExportOpen(true)}>
            <Icon name="download" /> {t('system.export.open')}
          </button>
        }
      />
      <section aria-labelledby="health-title">
        <div className="source-group-heading">
          <div>
            <h2 id="health-title">{t('system.healthTitle')}</h2>
            <p>
              {transportFailed ? <StatusBadge kind="unavailable" label={t('system.transportDisconnected')} /> : <span>{t('system.refreshNote')}</span>}
              {health.data && ` · ${t('system.observedLatest', { time: f.dateTimeSeconds(cards.reduce((a, c) => (c.observed_at > a ? c.observed_at : a), '')) })}`}
            </p>
          </div>
        </div>
        <ErrorNote error={health.error} onRetry={health.reload} />
        <div className="health-grid">
          {cards.map((c) => (
            <HealthCardView key={c.id} card={c} now={now} transportFailed={transportFailed} />
          ))}
        </div>
        {health.data && (
          <div className="stats-grid ops-strip">
            <div className="stat">
              <div className="stat-label">{t('system.backupsSummary')}</div>
              <div className="stat-value">
                <StatusBadge kind={health.data.backups.status} label={t(`backups.status.${health.data.backups.status}`)} />
              </div>
              <div className="stat-foot">
                {health.data.backups.recoverable_age_seconds !== null ? t('system.recoverableAge', { age: f.duration(health.data.backups.recoverable_age_seconds) }) : t('system.noBackupYet')} · <Link to="/app/settings#backups">{t('system.openBackups')}</Link>
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">{t('system.reviewSummary')}</div>
              <div className="stat-value">{health.data.unresolved_review_count}</div>
              <div className="stat-foot">
                <Link to="/app/sources#review">{t('system.openReview')}</Link>
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">{t('system.maintenance')}</div>
              <div className="stat-value">{health.data.maintenance.phase ? t(`maintenancePhase.${health.data.maintenance.phase}`, { defaultValue: health.data.maintenance.phase }) : t('system.noMaintenance')}</div>
            </div>
            <div className="stat">
              <div className="stat-label">{t('system.debugTitle')}</div>
              <div className="stat-value">{debug.data?.active ? <StatusBadge kind="working" label={t('system.debugActiveShort')} /> : <StatusBadge kind="unknown" label={t('system.debugInactive')} />}</div>
              <div className="stat-foot">{debug.data?.active && debug.data.expires_at ? t('system.debugExpires', { time: f.time(debug.data.expires_at), remaining: f.duration(Math.max(0, (new Date(debug.data.expires_at).getTime() - now) / 1000)) }) : ''}</div>
            </div>
          </div>
        )}
      </section>

      <section className="white-panel logs-panel" aria-labelledby="logs-title">
        <div className="source-group-heading">
          <div>
            <h2 id="logs-title">{t('system.logsTitle')}</h2>
            <p>{t('system.logsIntro')}</p>
          </div>
          <div className="heading-actions">
            <button type="button" className={`btn small ${live ? 'lime' : 'secondary'}`} aria-pressed={live} onClick={() => { setLive((l) => !l); setPaused(false); pendingRef.current = []; setNewCount(0); }}>
              <Icon name="pulse" /> {live ? t(`system.live.${liveState}`) : t('system.liveOff')}
            </button>
            {live && (paused ? (
              <button type="button" className="btn small primary" onClick={resume}>
                <Icon name="play" /> {t('system.resume', { count: newCount })}
              </button>
            ) : (
              <button type="button" className="btn small secondary" onClick={() => setPaused(true)}>
                <Icon name="pause" /> {t('system.pause')}
              </button>
            ))}
            <button type="button" className="btn small secondary" onClick={() => void load(applied)}>
              <Icon name="refresh" /> {t('common.refresh')}
            </button>
          </div>
        </div>
        <form className="filters log-filters" onSubmit={(e) => { e.preventDefault(); apply(); }} aria-label={t('system.filters.title')}>
          <fieldset className="filter-field">
            <legend>{t('system.filters.levels')}</legend>
            <div className="chip-row">
              {LEVELS.map((l) => (
                <label key={l} className="chip-check">
                  <input type="checkbox" checked={filters.levels.includes(l)} onChange={() => setFilters((fl) => ({ ...fl, levels: toggleIn(fl.levels, l) as LogLevel[] }))} /> {l}
                </label>
              ))}
              <button type="button" className="btn small secondary" onClick={warningsPreset}>
                {t('system.filters.warningsPreset')}
              </button>
            </div>
          </fieldset>
          <label className="filter-field">
            <span>{t('system.filters.levelMin')}</span>
            <select value={filters.level_min} disabled={filters.levels.length > 0} onChange={(e) => setFilters((fl) => ({ ...fl, level_min: e.target.value as LogLevel }))}>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>{t('system.filters.since')}</span>
            <input className="field" type="datetime-local" value={filters.since} onChange={(e) => setFilters((fl) => ({ ...fl, since: e.target.value }))} />
          </label>
          <label className="filter-field">
            <span>{t('system.filters.until')}</span>
            <input className="field" type="datetime-local" value={filters.until} onChange={(e) => setFilters((fl) => ({ ...fl, until: e.target.value }))} />
          </label>
          <fieldset className="filter-field">
            <legend>{t('system.filters.component')}</legend>
            <div className="chip-row">
              {COMPONENTS.map((c) => (
                <label key={c} className="chip-check">
                  <input type="checkbox" checked={filters.component.includes(c)} onChange={() => setFilters((fl) => ({ ...fl, component: toggleIn(fl.component, c) }))} /> {t(`components.${c}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="filter-field">
            <legend>{t('system.filters.provider')}</legend>
            <div className="chip-row">
              {PROVIDERS.map((p) => (
                <label key={p} className="chip-check">
                  <input type="checkbox" checked={filters.provider.includes(p)} onChange={() => setFilters((fl) => ({ ...fl, provider: toggleIn(fl.provider, p) }))} /> {t(`providers.${p}.name`)}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="filter-field">
            <span>{t('system.filters.connection')}</span>
            <input className="field mono" value={filters.connection_id} onChange={(e) => setFilters((fl) => ({ ...fl, connection_id: e.target.value }))} />
          </label>
          <label className="filter-field">
            <span>{t('system.filters.run')}</span>
            <input className="field mono" value={filters.run_id} onChange={(e) => setFilters((fl) => ({ ...fl, run_id: e.target.value }))} />
          </label>
          <label className="filter-field">
            <span>{t('system.filters.trace')}</span>
            <input className="field mono" value={filters.trace_id} onChange={(e) => setFilters((fl) => ({ ...fl, trace_id: e.target.value }))} />
          </label>
          <label className="filter-field grow">
            <span>{t('system.filters.search')}</span>
            <input className="field" value={filters.q} onChange={(e) => setFilters((fl) => ({ ...fl, q: e.target.value }))} placeholder={t('system.filters.searchPlaceholder')} />
          </label>
          <div className="filter-actions">
            <button type="submit" className="btn small primary">
              {t('system.filters.apply')}
            </button>
            <button type="button" className="btn small secondary" onClick={reset}>
              {t('common.clearFilters')}
            </button>
          </div>
        </form>
        <p className="active-filters" aria-live="polite">
          <strong>{t('system.filters.active')}:</strong> {activeFilters.join(' · ')} <span className="muted">({t('system.filters.semantics')})</span>
        </p>
        {page && (
          <p className="micro">
            {t('system.retained', { from: f.dateTimeSeconds(page.retained_from), to: f.dateTimeSeconds(page.retained_to) })} · {t('system.dropped', { count: page.dropped_count })} · {t(`system.logState.${page.state}`)}
          </p>
        )}
        {loading && records.length === 0 && <Loading />}
        <ErrorNote error={error} onRetry={() => void load(applied)} />
        {!loading && !error && records.length === 0 && page && <p className="empty-state">{t(`system.logStateHelp.${page.state}`)}</p>}
        {records.length > 0 && (
          <div className="ledger-table-wrap">
            <table className="ledger-table log-table">
              <thead>
                <tr>
                  <th>{t('system.columns.time')}</th>
                  <th>{t('system.columns.level')}</th>
                  <th>{t('system.columns.component')}</th>
                  <th>{t('system.columns.event')}</th>
                  <th>{t('system.columns.message')}</th>
                  <th>{t('system.columns.scope')}</th>
                  <th>
                    <span className="sr-only">{t('common.open')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.record_id} data-action="open" data-level={r.level} onClick={() => setDetail(r.record_id)}>
                    <td>
                      <time dateTime={r.occurred_at}>{f.dateTimeSeconds(r.occurred_at)}</time>
                    </td>
                    <td>
                      <StatusBadge kind={r.level} label={r.level} tone={r.level === 'ERROR' ? 'error' : r.level === 'WARN' ? 'warn' : r.level === 'DEBUG' ? 'neutral' : 'info'} />
                    </td>
                    <td>{t(`components.${r.component}`, { defaultValue: r.component })}</td>
                    <td>
                      <code className="mono">{r.event_name}</code>
                      {r.aggregated_count ? ` ×${r.aggregated_count}` : ''}
                    </td>
                    <td>
                      {t(`logEvents.${r.event_name}`, { defaultValue: r.message, count: r.record_count, ms: r.duration_ms })}
                      {r.error_code && <> · <code className="mono">{r.error_code}</code></>}
                    </td>
                    <td>
                      {r.connection_id && (
                        <Link to={`/app/sources/${r.connection_id}`} onClick={(e) => e.stopPropagation()} className="entity-link">
                          {t('system.columns.connection')}
                        </Link>
                      )}
                      {r.run_id && <small className="mono muted"> run {r.run_id.slice(0, 8)}</small>}
                    </td>
                    <td>
                      <button type="button" className="icon-btn" aria-label={t('system.openRecord', { id: r.record_id })} onClick={(e) => { e.stopPropagation(); setDetail(r.record_id); }}>
                        <Icon name="chevron" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page?.page.next_cursor && !live && (
          <div className="load-more">
            <button type="button" className="btn secondary" onClick={() => void load(applied, page.page.next_cursor)}>
              {t('common.loadMore')}
            </button>
          </div>
        )}
      </section>

      <div className="connection-layout">
        <DebugPanel state={debug} now={now} />
        <section className="white-panel" aria-labelledby="storage-title">
          <h2 id="storage-title">{t('system.storageTitle')}</h2>
          {storage.loading && !storage.data && <Loading />}
          <ErrorNote error={storage.error} onRetry={storage.reload} />
          {storage.data && (
            <>
              <DefinitionList
                rows={[
                  { label: t('system.storage.retainedRange'), value: `${f.dateTimeSeconds(storage.data.logs.retained_from)} – ${f.dateTimeSeconds(storage.data.logs.retained_to)}` },
                  { label: t('system.storage.retainedBytes'), value: `${f.bytes(storage.data.logs.retained_bytes)} / ${f.bytes(storage.data.logs.cap_bytes)} · ${t('system.storage.capDays', { days: storage.data.logs.cap_days })}` },
                  { label: t('system.storage.indexBytes'), value: f.bytes(storage.data.logs.index_bytes) },
                  { label: t('system.storage.dropped'), value: f.number(storage.data.logs.dropped_count) },
                  { label: t('system.storage.thresholds'), value: t('system.storage.thresholdText', { wp: storage.data.thresholds.warning_percent, wb: f.bytes(storage.data.thresholds.warning_bytes), cp: storage.data.thresholds.critical_percent, cb: f.bytes(storage.data.thresholds.critical_bytes) }) },
                ]}
              />
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>{t('system.storage.volume')}</th>
                    <th>{t('system.storage.used')}</th>
                    <th>{t('system.storage.free')}</th>
                    <th>{t('system.storage.state')}</th>
                  </tr>
                </thead>
                <tbody>
                  {storage.data.volumes.map((v) => (
                    <tr key={v.id}>
                      <td>{t(`volumes.${v.id}`, { defaultValue: v.id })}</td>
                      <td>{f.bytes(v.used_bytes)}</td>
                      <td>{v.total_bytes ? f.bytes(v.free_bytes) : t('common.unknown')}</td>
                      <td>
                        <StatusBadge kind={v.state} label={t(`storageState.${v.state}`)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="micro">
                <Link to="/app/settings#storage">{t('system.storage.changeThresholds')} →</Link>
              </p>
            </>
          )}
        </section>
      </div>

      {detail && <RecordDrawer recordId={detail} onClose={() => setDetail(null)} onOpen={setDetail} onFilterTrace={(trace) => { const next = { ...filters, trace_id: trace }; setFilters(next); setApplied(next); setRecords([]); setDetail(null); }} />}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
    </>
  );
}

function HealthCardView({ card, now, transportFailed }: { card: HealthCard; now: number; transportFailed: boolean }) {
  const { t } = useTranslation();
  const f = useFormat();
  const ageMs = now - new Date(card.observed_at).getTime();
  const stale = transportFailed || ageMs > STALE_MS;
  const state = transportFailed ? 'disconnected' : stale ? 'stale' : card.state;
  return (
    <article className={`stat health-card tone-${state}`} aria-labelledby={`health-${card.id}`}>
      <div className="stat-label">
        <span id={`health-${card.id}`}>{t(`healthCards.${card.id}`)}</span>
        <Icon name={{ api: 'wave', worker: 'refresh', postgres: 'database', engine: 'spark', sources: 'plug', mcp: 'code', diagnostics: 'pulse' }[card.id]} />
      </div>
      <div className="stat-value small">
        <StatusBadge kind={state} label={t(`healthState.${state}`)} />
      </div>
      <div className="stat-foot">
        <Icon name="clock" /> {t('system.observedAt', { time: f.time(card.observed_at), age: f.duration(Math.max(0, ageMs / 1000)) })}
      </div>
      <p className="health-reason">{t(`healthReasons.${card.reason}`, { defaultValue: card.reason })}</p>
      <dl className="health-details">
        {Object.entries(card.details).map(([k, v]) => (
          <div key={k}>
            <dt>{t(`healthDetails.${k}`, { defaultValue: k })}</dt>
            <dd>{v === null || v === undefined ? t('common.unknown') : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? f.dateTimeSeconds(v) : k.endsWith('_bytes') ? f.bytes(Number(v)) : String(v)}</dd>
          </div>
        ))}
      </dl>
      {card.next_action && (
        <p className="health-action">
          {card.next_action === 'open_sources' ? <Link to="/app/sources">{t(`nextAction.${card.next_action}`)} →</Link> : card.next_action === 'connect_agent' ? <Link to="/app/agents">{t(`nextAction.${card.next_action}`)} →</Link> : t(`nextAction.${card.next_action}`, { defaultValue: card.next_action })}
        </p>
      )}
    </article>
  );
}

function DebugPanel({ state, now }: { state: ReturnType<typeof useAsync<import('../api/types').DebugState>>; now: number }) {
  const { t } = useTranslation();
  const f = useFormat();
  const [component, setComponent] = useState('worker');
  const [connection, setConnection] = useState('');
  const [run, setRun] = useState('');
  const [minutes, setMinutes] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await diagApi.startDebug({ component, connection_id: connection || undefined, run_id: run || undefined, minutes });
      state.setData(d);
      toast(t('system.debugStarted'));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      state.setData(await diagApi.stopDebug());
      toast(t('system.debugStopped'));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const d = state.data;
  return (
    <section className="white-panel" aria-labelledby="debug-title">
      <h2 id="debug-title">{t('system.debugTitle')}</h2>
      <p>{t('system.debugIntro')}</p>
      {d?.active && d.scope ? (
        <div className="evidence-box">
          <h3>{t('system.debugActive')}</h3>
          <p>
            {t('system.debugScope', { component: t(`components.${d.scope.component}`), connection: d.scope.connection_id ?? t('common.all'), run: d.scope.run_id ?? t('common.all') })}
            <br />
            {d.expires_at && t('system.debugExpires', { time: f.dateTimeSeconds(d.expires_at), remaining: f.duration(Math.max(0, (new Date(d.expires_at).getTime() - now) / 1000)) })}
          </p>
          <button type="button" className="btn small primary" disabled={busy} onClick={() => void stop()}>
            <Icon name="pause" /> {t('system.debugStop')}
          </button>
        </div>
      ) : (
        <div className="param-grid">
          <label className="filter-field">
            <span>{t('system.filters.component')}</span>
            <select value={component} onChange={(e) => setComponent(e.target.value)}>
              {COMPONENTS.map((c) => (
                <option key={c} value={c}>
                  {t(`components.${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>{t('system.filters.connection')} ({t('common.optional')})</span>
            <input className="field mono" value={connection} onChange={(e) => setConnection(e.target.value)} />
          </label>
          <label className="filter-field">
            <span>{t('system.filters.run')} ({t('common.optional')})</span>
            <input className="field mono" value={run} onChange={(e) => setRun(e.target.value)} />
          </label>
          <label className="filter-field">
            <span>{t('system.debugMinutes')}</span>
            <input className="field" type="number" min={1} max={15} value={minutes} onChange={(e) => setMinutes(Math.min(15, Math.max(1, Number(e.target.value))))} />
          </label>
          <div className="filter-actions">
            <button type="button" className="btn small primary" disabled={busy} onClick={() => void start()}>
              <Icon name="play" /> {t('system.debugStart', { minutes })}
            </button>
          </div>
        </div>
      )}
      <ErrorNote error={error} />
      <p className="micro">{t('system.debugNote')}</p>
    </section>
  );
}

function RecordDrawer({ recordId, onClose, onOpen, onFilterTrace }: { recordId: string; onClose: () => void; onOpen: (id: string) => void; onFilterTrace: (trace: string) => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const rec = useAsync(() => diagApi.record(recordId), [recordId]);
  const r = rec.data?.record;
  const safeText = r ? JSON.stringify(r, null, 2) : '';
  return (
    <Drawer title={r ? r.event_name : t('common.loading')} eyebrow={<><Icon name="list" /> {t('system.recordEyebrow')}</>} onClose={onClose}>
      {rec.loading && <Loading />}
      <ErrorNote error={rec.error} onRetry={rec.reload} />
      {r && (
        <>
          <p>
            <StatusBadge kind={r.level} label={r.level} tone={r.level === 'ERROR' ? 'error' : r.level === 'WARN' ? 'warn' : r.level === 'DEBUG' ? 'neutral' : 'info'} /> {t(`logEvents.${r.event_name}`, { defaultValue: r.message, count: r.record_count, ms: r.duration_ms })}
          </p>
          <p className="micro">{t('system.rawMessage')}: {r.message}</p>
          <DefinitionList
            rows={[
              { label: t('system.record.recordId'), value: <code className="mono">{r.record_id}</code> },
              { label: t('system.record.occurredAt'), value: f.dateTimeSeconds(r.occurred_at) },
              { label: t('system.record.observedAt'), value: f.dateTimeSeconds(r.observed_at) },
              { label: t('system.filters.component'), value: t(`components.${r.component}`, { defaultValue: r.component }) },
              { label: t('system.record.serviceVersion'), value: `${r.service_version} · ${r.instance_id}` },
              { label: t('system.record.scope'), value: r.scope },
              ...(r.connection_id ? [{ label: t('system.filters.connection'), value: <Link to={`/app/sources/${r.connection_id}`}>{t('system.openConnection')}</Link> }] : []),
              ...(r.run_id ? [{ label: t('system.filters.run'), value: <code className="mono">{r.run_id}</code> }] : []),
              ...(r.capability_id ? [{ label: t('connection.capability'), value: r.capability_id }] : []),
              ...(r.trace_id ? [{ label: t('system.filters.trace'), value: <button type="button" className="text-link" onClick={() => onFilterTrace(r.trace_id as string)}>{r.trace_id} →</button> }] : []),
              ...(r.duration_ms !== undefined ? [{ label: t('system.record.duration'), value: `${f.number(r.duration_ms)} ms` }] : []),
              ...(r.record_count !== undefined ? [{ label: t('system.record.recordCount'), value: f.number(r.record_count) }] : []),
              ...(r.error_code ? [{ label: t('system.record.errorCode'), value: <code className="mono">{r.error_code}</code> }] : []),
              ...(r.retryable !== undefined ? [{ label: t('system.record.retryable'), value: r.retryable ? t('common.yes') : t('common.no') }] : []),
              ...(r.next_retry_at ? [{ label: t('system.record.nextRetry'), value: f.dateTimeSeconds(r.next_retry_at) }] : []),
              ...(r.action_code ? [{ label: t('system.record.action'), value: t(`actionCodes.${r.action_code}`, { defaultValue: r.action_code }) }] : []),
              ...(r.committed_cursor !== undefined ? [{ label: t('readiness.committed'), value: r.committed_cursor }] : []),
              ...(r.applied_cursor !== undefined ? [{ label: t('readiness.applied'), value: r.applied_cursor }] : []),
              ...(r.truncated ? [{ label: t('system.record.truncated'), value: t('common.yes') }] : []),
            ]}
          />
          <CopyButton text={safeText} label={t('system.copySafe')} />
          <h3 className="drawer-subtitle">{t('system.traceSiblings', { count: rec.data?.trace_siblings.length ?? 0 })}</h3>
          {rec.data?.trace_siblings.map((s) => (
            <button key={s.record_id} type="button" className="detail-link" onClick={() => onOpen(s.record_id)}>
              <span>
                {f.time(s.occurred_at)} · {t(`components.${s.component}`, { defaultValue: s.component })} · <code className="mono">{s.event_name}</code>
              </span>
              <Icon name="chevron" />
            </button>
          ))}
          <p className="micro">{t('system.renderNote')}</p>
        </>
      )}
    </Drawer>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const [since, setSince] = useState(toLocalDateTimeInput(new Date(Date.now() - 3600_000).toISOString()));
  const [until, setUntil] = useState(toLocalDateTimeInput(new Date().toISOString()));
  const [categories, setCategories] = useState<string[]>(EXPORT_CATEGORIES.filter((c) => c !== 'engine_heap'));
  const [preview, setPreview] = useState<import('../api/types').ExportPreview['preview'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const body = () => ({ since: fromLocalDateTimeInput(since) ?? new Date().toISOString(), until: fromLocalDateTimeInput(until) ?? new Date().toISOString(), categories });
  const doPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview((await diagApi.exportPreview(body())).preview);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob, filename } = await diagApi.exportDownload(body());
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename ?? `blackbox-diagnostics-${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast(t('system.export.downloaded', { name: a.download, size: f.bytes(blob.size) }));
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('system.export.title')} onClose={onClose} wide>
      <p>{t('system.export.intro')}</p>
      <div className="param-grid">
        <label className="filter-field">
          <span>{t('system.filters.since')}</span>
          <input className="field" type="datetime-local" value={since} onChange={(e) => { setSince(e.target.value); setPreview(null); }} />
        </label>
        <label className="filter-field">
          <span>{t('system.filters.until')}</span>
          <input className="field" type="datetime-local" value={until} onChange={(e) => { setUntil(e.target.value); setPreview(null); }} />
        </label>
      </div>
      <fieldset className="filter-field">
        <legend>{t('system.export.categories')}</legend>
        <div className="chip-row">
          {EXPORT_CATEGORIES.map((c) => (
            <label key={c} className="chip-check">
              <input type="checkbox" checked={categories.includes(c)} onChange={() => { setCategories((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c])); setPreview(null); }} /> {t(`exportCategories.${c}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="demo-callout">{t('system.export.excluded')}</p>
      {preview && (
        <div className="evidence-box">
          <h3>{t('system.export.previewTitle')}</h3>
          <DefinitionList
            rows={[
              { label: t('system.export.range'), value: `${f.dateTimeSeconds(preview.since)} – ${f.dateTimeSeconds(preview.until)}` },
              { label: t('system.export.size'), value: `${f.bytes(preview.size_bytes)} / 10 MiB` },
              { label: t('system.export.truncated'), value: preview.truncated ? t('common.yes') : t('common.no') },
              { label: t('system.export.categories'), value: preview.categories.map((c) => t(`exportCategories.${c}`)).join(', ') },
              { label: t('system.export.unavailable'), value: preview.unavailable.length ? preview.unavailable.map((c) => t(`exportCategories.${c}`)).join(', ') : t('common.none') },
            ]}
          />
        </div>
      )}
      <ErrorNote error={error} />
      <div className="onboard-actions">
        {!preview ? (
          <button type="button" className="btn primary" disabled={busy || !categories.length} onClick={() => void doPreview()}>
            {busy ? t('common.working') : t('system.export.preview')}
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={busy} onClick={() => void download()}>
            <Icon name="download" /> {busy ? t('common.working') : t('system.export.download')}
          </button>
        )}
        <button type="button" className="btn secondary" onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
      <p className="fineprint">{t('system.export.note')}</p>
    </Modal>
  );
}
