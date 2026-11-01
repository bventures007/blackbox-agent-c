import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Consistency, Readiness } from '../api/types';
import { useFormat } from '../format';
import { StatusBadge } from './ui';

/** Shared data-status block attached to every answer/state (IMPORT-ONBOARDING §5). */
export function ReadinessSummary({ readiness, consistency, effectiveAt, recordedCutoff, compact }: { readiness: Readiness; consistency?: Consistency | null; effectiveAt?: string | null; recordedCutoff?: string | null; compact?: boolean }) {
  const { t } = useTranslation();
  const f = useFormat();
  return (
    <section className={`readiness-summary${compact ? ' compact' : ''}`} aria-label={t('readiness.title')}>
      <h3>{t('readiness.title')}</h3>
      <div className="readiness-grid">
        <div>
          <dt>{t('readiness.datasetsPresent')}</dt>
          <dd>{readiness.datasets_present.length ? readiness.datasets_present.map((d) => t(`datasets.${d}`, { defaultValue: d })).join(', ') : t('common.none')}</dd>
        </div>
        <div>
          <dt>{t('readiness.datasetsMissing')}</dt>
          <dd>{readiness.datasets_missing.length ? readiness.datasets_missing.map((d) => t(`datasets.${d}`, { defaultValue: d })).join(', ') : t('common.none')}</dd>
        </div>
        {effectiveAt !== undefined && (
          <div>
            <dt>{t('readiness.effectiveAt')}</dt>
            <dd>{f.dateTimeSeconds(effectiveAt)}</dd>
          </div>
        )}
        {recordedCutoff !== undefined && (
          <div>
            <dt>{t('readiness.recordedCutoff')}</dt>
            <dd>{f.dateTimeSeconds(recordedCutoff)}</dd>
          </div>
        )}
        {consistency && (
          <>
            <div>
              <dt>{t('readiness.appliedCursor')}</dt>
              <dd>
                {consistency.applied_cursor ?? t('common.unknown')} / {t('readiness.committed')} {consistency.committed_cursor ?? t('common.unknown')} ·{' '}
                <StatusBadge kind={consistency.status} label={t(`readiness.consistency.${consistency.status}`)} />
              </dd>
            </div>
            <div>
              <dt>{t('readiness.reducerVersion')}</dt>
              <dd>{consistency.reducer_version ?? t('common.unknown')}</dd>
            </div>
          </>
        )}
      </div>
      {readiness.sources.length > 0 && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>{t('readiness.source')}</th>
              <th>{t('readiness.status')}</th>
              <th>{t('readiness.lastSuccessfulCheck')}</th>
              <th>{t('readiness.lastNewEvent')}</th>
              <th>{t('readiness.coverage')}</th>
            </tr>
          </thead>
          <tbody>
            {readiness.sources.map((s) => (
              <tr key={s.connection_id}>
                <td>
                  <Link to={`/app/sources/${s.connection_id}`}>{t(`providers.${s.provider}.name`, { defaultValue: s.provider })}</Link>
                </td>
                <td>
                  <StatusBadge kind={s.status} label={t(`sourceState.${s.status}`)} />
                </td>
                <td>
                  <time dateTime={s.last_successful_check_at ?? undefined} title={f.dateTimeSeconds(s.last_successful_check_at)}>
                    {s.last_successful_check_at ? f.relative(s.last_successful_check_at) : t('common.never')}
                  </time>
                </td>
                <td>
                  <time dateTime={s.last_new_event_at ?? undefined} title={f.dateTimeSeconds(s.last_new_event_at)}>
                    {s.last_new_event_at ? f.relative(s.last_new_event_at) : t('common.never')}
                  </time>
                </td>
                <td>{s.coverage_from ? `${f.date(s.coverage_from)} – ${f.date(s.coverage_to)}` : t('readiness.noCoverage')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
