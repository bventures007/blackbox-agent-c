import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeading } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { DefinitionList, ErrorNote, Loading, StatusBadge } from '../components/ui';
import { EntryDrawer } from '../components/EntryDrawer';
import { ReadinessSummary } from '../components/ReadinessSummary';
import { journal as journalApi } from '../api/endpoints';
import { useAsync } from '../hooks';
import { useFormat } from '../format';

/** Entity history and lifecycle drawer (invoice/payment/order/item) driven by state + history endpoints. */
export function EntityView() {
  const { t } = useTranslation();
  const f = useFormat();
  const { type = '', id = '' } = useParams();
  const [asOf, setAsOf] = useState('');
  const state = useAsync(() => journalApi.entityState(type, id, asOf ? { as_of_recorded: new Date(asOf).toISOString() } : undefined), [type, id, asOf]);
  const history = useAsync(() => journalApi.entityHistory(type, id, { limit: 100 }), [type, id]);
  const [openEntry, setOpenEntry] = useState<string | null>(null);

  useEffect(() => {
    document.title = `${t(`entityTypes.${type}`, { defaultValue: type })} ${id} — ${t('meta.title')}`;
  }, [t, type, id]);

  const s = state.data;
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
            {t('entity.currentState')}{' '}
            {s && <StatusBadge kind={s.status} label={t(`answerStatus.${s.status}`)} />}
          </h2>
          <label className="filter-field">
            <span>{t('entity.asOfRecorded')}</span>
            <input className="field" type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
          {state.loading && !s && <Loading />}
          <ErrorNote error={state.error} onRetry={state.reload} />
          {s && (
            <>
              <p className="payment-current-status">
                {t('entity.lifecycle')}: <strong>{t(`lifecycle.${s.lifecycle.state}`, { defaultValue: s.lifecycle.state })}</strong>
              </p>
              {s.positions.length > 0 && (
                <div className="payment-position">
                  {s.positions.map((p) => (
                    <div key={p.key}>
                      <small>{t(`positions.${p.key}`, { defaultValue: p.key })}</small>
                      <strong>{p.amount_minor !== undefined ? f.money(p.amount_minor, p.currency) : f.quantity(p.quantity, p.unit)}</strong>
                    </div>
                  ))}
                </div>
              )}
              <DefinitionList
                rows={s.fields.map((fld) => ({
                  label: t(`fields.${fld.key}`, { defaultValue: fld.key }),
                  value:
                    fld.kind === 'money' ? f.money(fld.value as number, fld.currency) : fld.kind === 'quantity' ? f.quantity(fld.value, fld.unit) : fld.kind === 'date' ? f.date(String(fld.value)) : String(fld.value ?? t('common.unknown')),
                }))}
              />
              {s.missing_inputs.length > 0 && (
                <div className="answer-warning">
                  {t('answer.missingInputs')}: {s.missing_inputs.map((m) => t(`missingInputs.${m}`, { defaultValue: m })).join(', ')}
                </div>
              )}
              {s.conflicts.map((c) => (
                <div className="answer-warning" key={c.code}>
                  <strong>{t('answer.conflict')}:</strong> {c.description}
                </div>
              ))}
              <div className="chip-row">
                {s.evidence.map((ev) => (
                  <button key={ev.entry_id} type="button" className="citation-btn" onClick={() => setOpenEntry(ev.entry_id)}>
                    [{ev.record_id}] {ev.label} <Icon name="chevron" />
                  </button>
                ))}
              </div>
              <p className="demo-callout">{t(`entity.semantics.${type}`, { defaultValue: t('entity.semantics.default') })}</p>
              <ReadinessSummary readiness={s.readiness} consistency={s.consistency} effectiveAt={s.effective_at} recordedCutoff={s.recorded_cutoff} compact />
            </>
          )}
        </section>
        <section className="white-panel">
          <h2>{t('entity.history')}</h2>
          <p>{t('entity.historyIntro')}</p>
          {history.loading && !history.data && <Loading />}
          <ErrorNote error={history.error} onRetry={history.reload} />
          {history.data && history.data.entries.length === 0 && <p className="muted">{t('entity.noHistory')}</p>}
          <div className="shipment-history">
            {history.data?.entries.map((e) => (
              <div className="shipment-history-row" key={e.entry_id}>
                <span className="status-dot" aria-hidden="true" />
                <div>
                  <time dateTime={e.occurred_at}>{f.dateTimeSeconds(e.occurred_at)}</time>
                  <h3>
                    {e.summary ?? e.event_type}{' '}
                    <span className="type-tag" data-track={e.track}>
                      {t(`tracks.${e.track}`)}
                    </span>
                  </h3>
                  <p>
                    {t('journal.fields.recordedAt')}: {f.dateTimeSeconds(e.recorded_at)}
                    {e.supersedes_entry_id ? ` · ${t('journal.supersedesShort')}` : ''}
                  </p>
                  <button type="button" className="citation-btn" onClick={() => setOpenEntry(e.entry_id)}>
                    {e.record_id} <Icon name="chevron" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      {openEntry && <EntryDrawer entryId={openEntry} onClose={() => setOpenEntry(null)} onOpenEntry={setOpenEntry} />}
    </>
  );
}
