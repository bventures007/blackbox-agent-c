import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeading } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { DefinitionList, ErrorNote, Loading, StatusBadge } from '../components/ui';
import { EntryDrawer, entrySummary } from '../components/EntryDrawer';
import { ReadinessSummary } from '../components/ReadinessSummary';
import { journalRefId } from '../api/adapters';
import { journal as journalApi } from '../api/endpoints';
import { TRACKS, type JournalEntry } from '../api/types';
import { useAsync } from '../hooks';
import { useFormat } from '../format';

/**
 * Money/quantity positions shown prominently per entity type (reference 35–45). These are fields of the
 * engine's state envelope — the UI only selects and labels them; no value is computed here.
 */
const POSITIONS: Record<string, string[]> = {
  invoice: ['reported_open_minor', 'credit_balance_minor', 'net_minor', 'allocated_paid_minor'],
  transaction: ['captured_minor', 'authorized_minor', 'fees_minor', 'refunded_minor', 'held_minor'],
  payout: ['announced_minor', 'in_transit_minor', 'bank_confirmed_minor', 'fees_minor'],
  order: ['open_receivable_minor', 'captured_minor', 'refunded_minor', 'available_stock'],
  item: ['physical', 'reserved', 'available', 'quarantined'],
  refund: ['requested_minor', 'completed_minor', 'pending_minor'],
};
const SKIP_FIELDS = new Set(['links', 'last_sequence', 'currency', 'unit']);

/** Entity history and lifecycle view (invoice/payment/order/item) driven by the state + history endpoints. */
export function EntityView() {
  const { t } = useTranslation();
  const f = useFormat();
  const { type = '', id = '' } = useParams();
  const [asOf, setAsOf] = useState('');
  const state = useAsync(() => journalApi.entityState(type, id, asOf ? { as_of_recorded: new Date(asOf).toISOString() } : undefined), [type, id, asOf]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<JournalEntry[]>([]);
  const historyPage = useAsync(() => journalApi.entityHistory(type, id, { limit: 100, cursor: historyCursor ?? undefined }), [type, id, historyCursor]);
  const [openEntry, setOpenEntry] = useState<string | null>(null);

  useEffect(() => {
    document.title = `${t(`entityTypes.${type}`, { defaultValue: type })} ${id} — ${t('meta.title')}`;
  }, [t, type, id]);
  useEffect(() => {
    setHistory([]);
    setHistoryCursor(null);
  }, [type, id]);
  useEffect(() => {
    if (!historyPage.data) return;
    setHistory((prev) => (historyCursor ? [...prev, ...historyPage.data!.entries.filter((e) => !prev.some((p) => p.entry_id === e.entry_id))] : historyPage.data!.entries));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyPage.data]);

  const s = state.data;
  const st = s?.state ?? null;
  const currency = typeof st?.currency === 'string' ? st.currency : undefined;
  const unit = typeof st?.unit === 'string' ? st.unit : undefined;
  const fmt = (key: string, v: unknown): string => {
    if (v === null || v === undefined) return t('common.unknown');
    if (typeof v === 'boolean') return v ? t('common.yes') : t('common.no');
    if (key.endsWith('_minor') && (typeof v === 'number' || typeof v === 'string')) return f.money(v, currency);
    if (/_at$|_date$|^due_date$/.test(key) && typeof v === 'string') return f.dateTimeSeconds(v);
    if (typeof v === 'number') return f.number(v);
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && unit && !key.endsWith('_id')) return f.quantity(v, unit);
    if (typeof v === 'string') return t(`values.${v}`, { defaultValue: v });
    return JSON.stringify(v);
  };
  const positions = (POSITIONS[type] ?? []).filter((k) => st && st[k] !== undefined);
  const fields = st ? Object.entries(st).filter(([k, v]) => !SKIP_FIELDS.has(k) && !positions.includes(k) && (v === null || typeof v !== 'object')) : [];
  const links = Array.isArray(st?.links) ? (st!.links as Array<{ type: string; id: string }>) : [];
  const evidenceEntries = (s?.evidence_refs ?? []).map(journalRefId).filter((x): x is string => Boolean(x));
  const typeLabel = t(`entityTypes.${type}`, { defaultValue: type });
  return (
    <>
      <PageHeading
        title={`${typeLabel} ${id}`}
        subtitle={t('entity.subtitle')}
        actions={
          <Link className="btn secondary" to={`/app/journal?entity=${encodeURIComponent(`${type}:${id}`)}`}>
            <Icon name="list" /> {t('entity.openInJournal')}
          </Link>
        }
      />
      <div className="entity-layout">
        <section className="white-panel">
          <h2>
            {t('entity.currentState')} {s && <StatusBadge kind={s.status} label={t(`answerStatus.${s.status}`, { defaultValue: s.status })} />}
          </h2>
          <label className="filter-field">
            <span>{t('entity.asOfRecorded')}</span>
            <input className="field" type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
          {state.loading && !s && <Loading />}
          <ErrorNote error={state.error} onRetry={state.reload} />
          {s && !st && <p className="answer-warning">{t('entity.noState')}</p>}
          {s && st && (
            <>
              {typeof st.status === 'string' && (
                <p className="payment-current-status">
                  {t('entity.lifecycle')}: <strong>{t(`lifecycle.${st.status}`, { defaultValue: st.status })}</strong>
                </p>
              )}
              {positions.length > 0 && (
                <div className="payment-position">
                  {positions.map((k) => (
                    <div key={k}>
                      <small>{t(`positions.${k}`, { defaultValue: t(`fields.${k}`, { defaultValue: k }) })}</small>
                      <strong>{fmt(k, st[k])}</strong>
                    </div>
                  ))}
                </div>
              )}
              <DefinitionList rows={fields.map(([k, v]) => ({ label: t(`fields.${k}`, { defaultValue: k }), value: fmt(k, v) }))} />
              {links.length > 0 && (
                <div className="chip-row">
                  {links.map((l) => (
                    <Link key={`${l.type}:${l.id}`} className="citation-btn" to={`/app/entities/${l.type}/${encodeURIComponent(l.id)}`}>
                      {t(`entityTypes.${l.type}`, { defaultValue: l.type })} · {l.id}
                    </Link>
                  ))}
                </div>
              )}
              {s.missing_inputs.length > 0 && (
                <div className="answer-warning">
                  {t('answer.missingInputs')}: {s.missing_inputs.map((m) => t(`missingInputs.${m}`, { defaultValue: m })).join(', ')}
                </div>
              )}
              {s.conflicts.map((c, i) => (
                <div className="answer-warning" key={i}>
                  <strong>{t('answer.conflict')}:</strong> {typeof c.description === 'string' ? c.description : JSON.stringify(c)}
                </div>
              ))}
              {s.tracks && (
                <>
                  <h3 className="drawer-subtitle">{t('entity.tracksTitle')}</h3>
                  <div className="track-summary">
                    {TRACKS.map((tr) => {
                      const summary = s.tracks![tr];
                      return (
                        <div key={tr} className="track-summary-row">
                          <span className="type-tag" data-track={tr}>
                            {t(`tracks.${tr}`)}
                          </span>
                          <span>{t('entity.trackEntries', { count: summary?.total ?? 0 })}</span>
                          <span className="chip-row">
                            {(summary?.entries ?? []).slice(0, 4).map((e) => (
                              <button key={e.entry_id} type="button" className="citation-btn" onClick={() => setOpenEntry(e.entry_id)} title={`${e.event_type} · ${e.effect}`}>
                                {e.event_type} <small>({t(`entity.effect.${e.effect}`, { defaultValue: e.effect })})</small>
                              </button>
                            ))}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              <div className="chip-row">
                {evidenceEntries.slice(0, 12).map((eid) => (
                  <button key={eid} type="button" className="citation-btn" onClick={() => setOpenEntry(eid)}>
                    [{eid.slice(0, 8)}] <Icon name="chevron" />
                  </button>
                ))}
                {evidenceEntries.length > 12 && <span className="muted">+{evidenceEntries.length - 12}</span>}
              </div>
              <p className="demo-callout">{t(`entity.semantics.${type}`, { defaultValue: t('entity.semantics.default') })}</p>
              <ReadinessSummary readiness={{ datasets_present: s.coverage?.datasets_present ?? s.readiness.datasets_present, datasets_missing: s.coverage?.datasets_missing ?? s.readiness.datasets_missing, sources: s.readiness.sources.filter((src) => (s.coverage?.datasets_present ?? []).includes(src.capability_id ?? '')) }} consistency={s.consistency} effectiveAt={s.consistency?.effective_cutoff ?? null} recordedCutoff={s.consistency?.recorded_cutoff ?? null} compact />
            </>
          )}
        </section>
        <section className="white-panel">
          <h2>{t('entity.history')}</h2>
          <p>{t('entity.historyIntro')}</p>
          {historyPage.loading && history.length === 0 && <Loading />}
          <ErrorNote error={historyPage.error} onRetry={historyPage.reload} />
          {historyPage.data && history.length === 0 && <p className="muted">{t('entity.noHistory')}</p>}
          <div className="shipment-history">
            {history.map((e) => (
              <div className="shipment-history-row" key={e.entry_id}>
                <span className="status-dot" aria-hidden="true" />
                <div>
                  <time dateTime={e.occurred_at}>{f.dateTimeSeconds(e.occurred_at)}</time>
                  <h3>
                    {e.event_type}{' '}
                    <span className="type-tag" data-track={e.track}>
                      {t(`tracks.${e.track}`)}
                    </span>
                  </h3>
                  <p>
                    {t('journal.fields.recordedAt')}: {f.dateTimeSeconds(e.recorded_at)}
                    {e.supersedes_entry_id ? ` · ${t('journal.supersedesShort')}` : ''}
                  </p>
                  <button type="button" className="citation-btn" onClick={() => setOpenEntry(e.entry_id)}>
                    {entrySummary(e)} <Icon name="chevron" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {historyPage.data?.page.next_cursor && (
            <div className="load-more">
              <button type="button" className="btn secondary" onClick={() => setHistoryCursor(historyPage.data!.page.next_cursor)}>
                {t('common.loadMore')}
              </button>
            </div>
          )}
        </section>
      </div>
      {openEntry && <EntryDrawer entryId={openEntry} onClose={() => setOpenEntry(null)} onOpenEntry={setOpenEntry} />}
    </>
  );
}
