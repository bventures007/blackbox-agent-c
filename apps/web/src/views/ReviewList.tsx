import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '../components/Icon';
import { ErrorNote, Field, Loading, Modal, StatusBadge } from '../components/ui';
import { review as reviewApi } from '../api/endpoints';
import type { ReviewAction, ReviewCase } from '../api/types';
import { useAsync } from '../hooks';
import { useFormat } from '../format';
import { HttpError } from '../api/client';
import { toast } from '../components/AppShell';
import { useSession } from '../auth/SessionContext';

/** Needs review list (PILOT-OPERATIONS §3): revision-safe actions, "Decision saved; recalculating" until applied. */
export function ReviewList() {
  const { t } = useTranslation();
  const f = useFormat();
  const { refreshWorkspace } = useSession();
  const [filter, setFilter] = useState<'open' | 'in_progress' | 'resolved' | ''>('');
  const cases = useAsync(() => reviewApi.list(filter || undefined), [filter], 5000);
  const [acting, setActing] = useState<{ c: ReviewCase; action: ReviewAction } | null>(null);
  const [reason, setReason] = useState('');
  const [correction, setCorrection] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const perform = async () => {
    if (!acting) return;
    setBusy(true);
    setError(null);
    try {
      let payload: unknown;
      if (acting.action === 'append_correction') {
        try {
          payload = correction.trim() ? JSON.parse(correction) : undefined;
        } catch {
          throw new Error(t('review.invalidJson'));
        }
      }
      await reviewApi.act(acting.c.case_id, { action: acting.action, revision: acting.c.revision, reason: reason.trim(), payload });
      toast(acting.action === 'leave_open' ? t('review.leftOpen') : t('review.decisionSaved'));
      setActing(null);
      setReason('');
      setCorrection('');
      cases.reload();
      void refreshWorkspace();
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        setError(new Error(t('review.staleRevision')));
        cases.reload();
      } else setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="review-section" id="review" aria-labelledby="review-title">
      <div className="source-group-heading">
        <div>
          <h2 id="review-title">{t('review.title')}</h2>
          <p>{t('review.intro')}</p>
        </div>
        <label className="filter-field">
          <span>{t('review.filterState')}</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="">{t('review.states.all')}</option>
            <option value="open">{t('review.states.open')}</option>
            <option value="in_progress">{t('review.states.in_progress')}</option>
            <option value="resolved">{t('review.states.resolved')}</option>
          </select>
        </label>
      </div>
      {cases.loading && !cases.data && <Loading />}
      <ErrorNote error={cases.error} onRetry={cases.reload} />
      {cases.data && cases.data.length === 0 && <p className="info-strip"><Icon name="check" /> {t('review.empty')}</p>}
      <div className="review-list">
        {cases.data?.map((c) => (
          <article className="review-card" key={c.case_id} aria-labelledby={`case-${c.case_id}`}>
            <div className="review-card-head">
              <StatusBadge kind={c.state} label={t(`review.states.${c.state}`)} />
              <span className="type-tag">{t(`review.types.${c.type}`)}</span>
              <span className="muted mono">{c.case_id} · rev {c.revision}</span>
              {c.recalculating && <StatusBadge kind="working" label={t('review.recalculating', { required: c.required_cursor ?? '?', applied: c.applied_cursor ?? '?' })} />}
            </div>
            <h3 id={`case-${c.case_id}`}>{c.reason}</h3>
            <dl className="detail-meta compact-meta">
              <div>
                <dt>{t('review.source')}</dt>
                <dd>
                  <Link to={`/app/sources/${c.source.connection_id}`}>{t(`providers.${c.source.provider}.name`, { defaultValue: c.source.provider })}</Link> {c.source.account_label ? `· ${c.source.account_label}` : ''}
                </dd>
              </div>
              <div>
                <dt>{t('review.stage')}</dt>
                <dd>{t(`phases.${c.stage}`, { defaultValue: c.stage })}</dd>
              </div>
              <div>
                <dt>{t('review.affectedRecords')}</dt>
                <dd>{c.affected.records.join(', ') || t('common.none')}</dd>
              </div>
              <div>
                <dt>{t('review.affectedQuestions')}</dt>
                <dd>{c.affected.questions.map((q) => <Link key={q} to={`/app/questions?q=${q}`} className="entity-link">{t(`questionsCatalog.${q}.q`)}</Link>)}</dd>
              </div>
              <div>
                <dt>{t('review.evidence')}</dt>
                <dd>{c.evidence_ref ? <code className="mono">{c.evidence_ref}</code> : t('review.noEvidenceRetained')}</dd>
              </div>
              {c.proposed_link && (
                <div>
                  <dt>{t('review.proposedLink')}</dt>
                  <dd>
                    <code className="mono">{c.proposed_link.from}</code> → <code className="mono">{c.proposed_link.to}</code>
                  </dd>
                </div>
              )}
              <div>
                <dt>{t('review.logs')}</dt>
                <dd>
                  <Link to={`/app/system?connection_id=${c.source.connection_id}${c.run_id ? `&run_id=${c.run_id}` : ''}`}>{t('sources.viewLogs')}</Link>
                </dd>
              </div>
            </dl>
            <details>
              <summary>{t('review.historyTitle', { count: c.history.length })}</summary>
              <ul className="plain-list">
                {c.history.map((h, i) => (
                  <li key={i}>
                    <time dateTime={h.at}>{f.dateTimeSeconds(h.at)}</time> · {h.actor} · {t(`review.actions.${h.action}`, { defaultValue: h.action })}
                    {h.reason ? ` — ${h.reason}` : ''}
                  </li>
                ))}
              </ul>
            </details>
            {c.state !== 'resolved' && !c.recalculating && (
              <div className="review-actions">
                {c.available_actions.map((a) => (
                  <button key={a} type="button" className={`btn small ${a === 'leave_open' ? 'secondary' : 'primary'}`} onClick={() => setActing({ c, action: a })}>
                    {t(`review.actions.${a}`)}
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      {acting && (
        <Modal title={t(`review.actions.${acting.action}`)} onClose={() => setActing(null)}>
          <p>{t(`review.actionHelp.${acting.action}`)}</p>
          <p className="micro">
            {acting.c.case_id} · rev {acting.c.revision}
          </p>
          {acting.action !== 'leave_open' && (
            <Field label={t('review.reason')} htmlFor="review-reason" hint={t('review.reasonHint')}>
              <textarea id="review-reason" className="field" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          )}
          {acting.action === 'append_correction' && (
            <Field label={t('review.correctionPayload')} htmlFor="review-correction" hint={t('review.correctionHint')}>
              <textarea id="review-correction" className="field mono" rows={5} value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder='{"assertion":"payout_match","payout":"PO-2026-10-30","evidence_ref":"EVD-011"}' />
            </Field>
          )}
          <ErrorNote error={error} />
          <div className="onboard-actions">
            <button type="button" className="btn primary" disabled={busy || (acting.action !== 'leave_open' && !reason.trim())} onClick={() => void perform()}>
              {busy ? t('common.working') : t('review.confirmAction')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setActing(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
