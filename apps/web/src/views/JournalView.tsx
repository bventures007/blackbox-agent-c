import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeading } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorNote, Loading, StatusBadge } from '../components/ui';
import { EntryDrawer } from '../components/EntryDrawer';
import { journal as journalApi } from '../api/endpoints';
import { TRACKS, type JournalEntry } from '../api/types';
import { useAsync } from '../hooks';
import { useFormat } from '../format';

export function JournalView() {
  const { t } = useTranslation();
  const f = useFormat();
  const navigate = useNavigate();
  const { entryId } = useParams();
  const [params, setParams] = useSearchParams();
  const track = params.get('track') ?? '';
  const eventType = params.get('event_type') ?? '';
  const recordId = params.get('record_id') ?? '';
  const entity = params.get('entity') ?? '';
  const occurredFrom = params.get('occurred_from') ?? '';
  const occurredTo = params.get('occurred_to') ?? '';
  const recordedFrom = params.get('recorded_from') ?? '';
  const recordedTo = params.get('recorded_to') ?? '';
  const [cursor, setCursor] = useState<string | null>(null);
  const [accumulated, setAccumulated] = useState<JournalEntry[]>([]);

  useEffect(() => {
    document.title = `${t('nav.journal')} — ${t('meta.title')}`;
  }, [t]);

  const query = useMemo(
    () => ({
      track: track || undefined,
      event_type: eventType || undefined,
      record_id: recordId || undefined,
      entity: entity || undefined,
      occurred_from: occurredFrom ? new Date(occurredFrom).toISOString() : undefined,
      occurred_to: occurredTo ? new Date(occurredTo).toISOString() : undefined,
      recorded_from: recordedFrom ? new Date(recordedFrom).toISOString() : undefined,
      recorded_to: recordedTo ? new Date(recordedTo).toISOString() : undefined,
      limit: 50,
      cursor: cursor ?? undefined,
    }),
    [track, eventType, recordId, entity, occurredFrom, occurredTo, recordedFrom, recordedTo, cursor],
  );
  const page = useAsync(() => journalApi.list(query), [query]);
  useEffect(() => {
    if (!page.data) return;
    setAccumulated((prev) => (cursor ? [...prev, ...page.data!.entries.filter((e) => !prev.some((p) => p.entry_id === e.entry_id))] : page.data!.entries));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.data]);
  useEffect(() => {
    setCursor(null);
  }, [track, eventType, recordId, entity, occurredFrom, occurredTo, recordedFrom, recordedTo]);

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const clear = () => setParams(new URLSearchParams(), { replace: true });
  const active = [track, eventType, recordId, entity, occurredFrom, occurredTo, recordedFrom, recordedTo].filter(Boolean).length;
  const entries = cursor ? accumulated : (page.data?.entries ?? []);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), filters: Object.fromEntries(params), consistency: page.data?.consistency, entries }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `blackbox-journal-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeading
        title={t('journal.title')}
        subtitle={t('journal.subtitle')}
        actions={
          <button type="button" className="btn secondary" onClick={exportJson} disabled={!entries.length}>
            <Icon name="download" /> {t('journal.exportJson')}
          </button>
        }
      />
      <form className="history-toolbar filters" onSubmit={(e) => e.preventDefault()} aria-label={t('journal.filtersLabel')}>
        <label className="filter-field grow">
          <span>{t('journal.filters.recordId')}</span>
          <input className="field" value={recordId} onChange={(e) => update('record_id', e.target.value)} placeholder={t('journal.filters.recordIdPlaceholder')} />
        </label>
        <label className="filter-field">
          <span>{t('journal.filters.track')}</span>
          <select value={track} onChange={(e) => update('track', e.target.value)}>
            <option value="">{t('journal.filters.allTracks')}</option>
            {TRACKS.map((tr) => (
              <option key={tr} value={tr}>
                {t(`tracks.${tr}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>{t('journal.filters.eventType')}</span>
          <input className="field" value={eventType} onChange={(e) => update('event_type', e.target.value)} placeholder="order.accepted" />
        </label>
        <label className="filter-field">
          <span>{t('journal.filters.entity')}</span>
          <input className="field" value={entity} onChange={(e) => update('entity', e.target.value)} placeholder="order:#1001" />
        </label>
        <label className="filter-field">
          <span>{t('journal.filters.occurredFrom')}</span>
          <input className="field" type="datetime-local" value={occurredFrom} onChange={(e) => update('occurred_from', e.target.value)} />
        </label>
        <label className="filter-field">
          <span>{t('journal.filters.occurredTo')}</span>
          <input className="field" type="datetime-local" value={occurredTo} onChange={(e) => update('occurred_to', e.target.value)} />
        </label>
        <label className="filter-field">
          <span>{t('journal.filters.recordedFrom')}</span>
          <input className="field" type="datetime-local" value={recordedFrom} onChange={(e) => update('recorded_from', e.target.value)} />
        </label>
        <label className="filter-field">
          <span>{t('journal.filters.recordedTo')}</span>
          <input className="field" type="datetime-local" value={recordedTo} onChange={(e) => update('recorded_to', e.target.value)} />
        </label>
        <div className="filter-actions">
          <span className="otc-count">{page.data ? t('journal.count', { count: entries.length }) : ''}</span>
          <button type="button" className="btn small secondary" onClick={clear} disabled={!active}>
            {t('common.clearFilters')} {active ? `(${active})` : ''}
          </button>
        </div>
      </form>
      {page.loading && !page.data && <Loading />}
      <ErrorNote error={page.error} onRetry={page.reload} />
      {page.data && entries.length === 0 && (
        <EmptyState>
          <p>{t('journal.empty')}</p>
          {active > 0 && (
            <button type="button" className="btn small secondary" onClick={clear}>
              {t('common.clearFilters')}
            </button>
          )}
        </EmptyState>
      )}
      {entries.length > 0 && (
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>{t('journal.columns.recordId')}</th>
                <th>{t('journal.columns.occurredAt')}</th>
                <th>{t('journal.columns.recordedAt')}</th>
                <th>{t('journal.columns.track')}</th>
                <th>{t('journal.columns.event')}</th>
                <th>{t('journal.columns.provider')}</th>
                <th>{t('journal.columns.entities')}</th>
                <th>
                  <span className="sr-only">{t('common.open')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.entry_id} data-action="open" onClick={() => navigate(`/app/journal/${e.entry_id}?${params.toString()}`)}>
                  <td>
                    <code className="mono">{e.record_id}</code>
                  </td>
                  <td>
                    <time dateTime={e.occurred_at}>{f.dateTime(e.occurred_at)}</time>
                  </td>
                  <td>
                    <time dateTime={e.recorded_at}>{f.dateTime(e.recorded_at)}</time>
                  </td>
                  <td>
                    <span className="type-tag" data-track={e.track}>
                      {t(`tracks.${e.track}`)}
                    </span>
                  </td>
                  <td>
                    {e.event_type}
                    {e.supersedes_entry_id && <> <StatusBadge tone="info" label={t('journal.supersedesShort')} /></>}
                  </td>
                  <td>{e.provider ? t(`providers.${e.provider}.name`, { defaultValue: e.provider }) : '–'}</td>
                  <td>
                    {Object.entries(e.entity_refs)
                      .slice(0, 3)
                      .map(([type, id]) => (
                        <Link key={type} to={`/app/entities/${type}/${encodeURIComponent(id)}`} onClick={(ev) => ev.stopPropagation()} className="entity-link">
                          {id}
                        </Link>
                      ))}
                  </td>
                  <td>
                    <button type="button" className="icon-btn" aria-label={t('journal.openEntry', { id: e.record_id })} onClick={(ev) => { ev.stopPropagation(); navigate(`/app/journal/${e.entry_id}?${params.toString()}`); }}>
                      <Icon name="chevron" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.data?.page.next_cursor && (
        <div className="load-more">
          <button type="button" className="btn secondary" onClick={() => setCursor(page.data!.page.next_cursor)}>
            {t('common.loadMore')}
          </button>
        </div>
      )}
      {page.data && (
        <p className="context-note">
          <span>
            {t('journal.consistencyNote', { cursor: page.data.consistency.committed_cursor ?? t('common.unknown'), snapshot: page.data.page.snapshot_cursor })}
            {page.data.page.truncated ? ` · ${t('journal.truncated')}` : ''}
          </span>
          <span>{t('journal.historyNote')}</span>
        </p>
      )}
      {entryId && <EntryDrawer entryId={entryId} onClose={() => navigate(`/app/journal?${params.toString()}`)} onOpenEntry={(id) => navigate(`/app/journal/${id}?${params.toString()}`)} />}
    </>
  );
}
