import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeading, toast } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { DefinitionList, ErrorNote, Field, Loading, Modal, StatusBadge } from '../components/ui';
import { ReadinessSummary } from '../components/ReadinessSummary';
import { sources as sourcesApi } from '../api/endpoints';
import type { ImportPlan, ImportPreset, ImportRun } from '../api/types';
import { useAsync } from '../hooks';
import { useFormat } from '../format';

const PRESETS: ImportPreset[] = ['last_30_days', 'this_year', 'last_12_months', 'custom', 'from_now'];
const PHASES = ['check_connection', 'import_records', 'link_and_process', 'ready_for_queries'] as const;

export function ConnectionView() {
  const { t } = useTranslation();
  const f = useFormat();
  const navigate = useNavigate();
  const { connectionId = '' } = useParams();
  const detail = useAsync(() => sourcesApi.connection(connectionId), [connectionId], 5000);
  const [planOpen, setPlanOpen] = useState(false);
  const [confirm, setConfirm] = useState<'pause' | 'resume' | 'disconnect' | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    if (detail.data) document.title = `${detail.data.connection.display_name} — ${t('meta.title')}`;
  }, [detail.data, t]);

  const d = detail.data;
  const act = async (kind: 'pause' | 'resume' | 'disconnect') => {
    setBusy(true);
    setActionError(null);
    try {
      await sourcesApi[kind](connectionId);
      toast(t(`connection.actions.${kind}Done`));
      setConfirm(null);
      detail.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  };
  const startRun = async (kind: 'backfill' | 'incremental' | 'reconcile' | 'check') => {
    setBusy(true);
    setActionError(null);
    try {
      await sourcesApi.startRun(connectionId, kind);
      toast(t('connection.runStarted'));
      detail.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeading
        title={d ? d.connection.display_name : t('common.loading')}
        subtitle={d ? `${t(`providers.${d.connection.provider}.name`, { defaultValue: d.connection.provider })}${d.connection.account_label ? ` · ${d.connection.account_label}` : ''} · ${t('connection.mode')}` : ''}
        actions={
          d && (
            <>
              <Link className="btn secondary" to={`/app/system?connection_id=${connectionId}`}>
                <Icon name="list" /> {t('sources.viewLogs')}
              </Link>
              {d.connection.state === 'paused' ? (
                <button type="button" className="btn secondary" onClick={() => setConfirm('resume')}>
                  <Icon name="play" /> {t('connection.actions.resume')}
                </button>
              ) : d.connection.state !== 'disconnected' ? (
                <button type="button" className="btn secondary" onClick={() => setConfirm('pause')}>
                  <Icon name="pause" /> {t('connection.actions.pause')}
                </button>
              ) : null}
              {d.connection.state !== 'disconnected' && (
                <button type="button" className="btn secondary" onClick={() => setConfirm('disconnect')}>
                  <Icon name="exit" /> {t('connection.actions.disconnect')}
                </button>
              )}
            </>
          )
        }
      />
      <nav className="breadcrumb-row" aria-label={t('common.breadcrumb')}>
        <Link to="/app/sources">← {t('nav.sources')}</Link>
      </nav>
      {detail.loading && !d && <Loading />}
      <ErrorNote error={detail.error} onRetry={detail.reload} />
      <ErrorNote error={actionError} />
      {d && (
        <div className="connection-layout">
          <section className="white-panel">
            <h2>
              {t('connection.health')} <StatusBadge kind={d.health.state} label={t(`sourceState.${d.health.state}`)} />
            </h2>
            <p>{t('connection.observedAt', { time: f.dateTimeSeconds(d.health.observed_at) })}</p>
            <DefinitionList
              rows={[
                { label: t('connection.fields.lastAttempt'), value: f.dateTimeSeconds(d.health.last_attempt_at) },
                { label: t('connection.fields.lastImportCompleted'), value: d.health.last_import_completed_at ? `${f.dateTimeSeconds(d.health.last_import_completed_at)} · ${d.connection.last_import_outcome ? t(`runOutcome.${d.connection.last_import_outcome}`) : ''}` : t('common.never') },
                { label: t('connection.fields.lastSuccessfulCheck'), value: f.dateTimeSeconds(d.health.last_successful_check_at) },
                { label: t('connection.fields.lastNewEvent'), value: d.health.last_new_event_at ? f.dateTimeSeconds(d.health.last_new_event_at) : t('common.never') },
                { label: t('connection.fields.lastJournalCommit'), value: f.dateTimeSeconds(d.health.last_journal_commit_at) },
                { label: t('connection.fields.lastApplied'), value: f.dateTimeSeconds(d.health.last_applied_at) },
                { label: t('connection.fields.nextCheck'), value: d.health.next_check_at ? f.dateTimeSeconds(d.health.next_check_at) : t('sources.noNextCheck') },
                { label: t('connection.fields.nextCheckReason'), value: d.health.next_check_reason ? t(`nextCheckReason.${d.health.next_check_reason.split(':')[0]}`, { defaultValue: d.health.next_check_reason, detail: d.health.next_check_reason.split(':').slice(1).join(':') }) : t('common.none') },
                { label: t('connection.fields.pending'), value: `${f.number(d.health.pending_count)} (${t('connection.fields.oldestPending')}: ${d.health.oldest_pending_age_seconds === null ? t('common.none') : f.duration(d.health.oldest_pending_age_seconds)})` },
                { label: t('connection.fields.failed'), value: f.number(d.health.failed_count) },
                { label: t('connection.fields.cursors'), value: `${t('readiness.committed')} ${d.health.committed_cursor ?? '–'} · ${t('readiness.applied')} ${d.health.applied_cursor ?? '–'}` },
              ]}
            />
            <p className="micro">{t('connection.checkVsEventNote')}</p>
            <h3 className="drawer-subtitle">{t('connection.coverage')}</h3>
            {d.health.coverage.length === 0 && <p className="muted">{t('connection.noCoverage')}</p>}
            {d.health.coverage.length > 0 && (
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>{t('connection.capability')}</th>
                    <th>{t('connection.coverageInterval')}</th>
                    <th>{t('connection.completeness')}</th>
                    <th>{t('connection.historyKind')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.health.coverage.map((c) => (
                    <tr key={c.capability_id}>
                      <td>{t(`capabilities.${c.capability_id}`, { defaultValue: c.capability_id })}</td>
                      <td>{c.from ? `${f.dateTime(c.from)} – ${f.dateTime(c.to)}` : t('common.unknown')}</td>
                      <td>
                        <StatusBadge kind={c.completeness === 'complete_for_declared_scope' ? 'complete' : c.completeness} label={t(`completeness.${c.completeness}`)} />
                      </td>
                      <td>{t(`historyKind.${c.history_kind}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {d.health.limitations.length > 0 && (
              <>
                <h3 className="drawer-subtitle">{t('connection.limitations')}</h3>
                <ul className="limitations">
                  {d.health.limitations.map((l) => (
                    <li key={l}>{t(`limitations.${l}`, { defaultValue: l })}</li>
                  ))}
                </ul>
              </>
            )}
            <h3 className="drawer-subtitle">{t('connection.config')}</h3>
            <DefinitionList rows={Object.entries(d.connection.config_summary).map(([k, v]) => ({ label: k, value: v }))} />
            <p className="micro">{t('connection.secretsNote')}</p>
          </section>

          <section className="white-panel">
            <h2>{t('connection.importPlan')}</h2>
            {d.import_plan ? (
              <PlanSummary plan={d.import_plan} />
            ) : (
              <p className="answer-warning">{t('connection.noPlan')}</p>
            )}
            <div className="onboard-actions">
              <button type="button" className="btn primary" onClick={() => setPlanOpen(true)}>
                <Icon name="sliders" /> {d.import_plan ? t('connection.changePlan') : t('connection.choosePlan')}
              </button>
              {d.import_plan && (
                <>
                  <button type="button" className="btn secondary" disabled={busy} onClick={() => void startRun('incremental')}>
                    <Icon name="refresh" /> {t('connection.runIncremental')}
                  </button>
                  <button type="button" className="btn secondary" disabled={busy} onClick={() => void startRun('reconcile')}>
                    <Icon name="check" /> {t('connection.runReconcile')}
                  </button>
                  <button type="button" className="btn secondary" disabled={busy} onClick={() => void startRun('check')}>
                    <Icon name="plug" /> {t('connection.runCheck')}
                  </button>
                </>
              )}
            </div>
            <h2 className="section-gap">{t('connection.runs')}</h2>
            {d.runs.length === 0 && <p className="muted">{t('connection.noRuns')}</p>}
            {d.runs.map((r) => (
              <RunCard key={r.run_id} run={r} connectionId={connectionId} />
            ))}
            <ReadinessSummary readiness={d.readiness} compact />
          </section>
        </div>
      )}
      {planOpen && d && (
        <ImportPlanDialog
          connectionId={connectionId}
          current={d.import_plan}
          onClose={() => setPlanOpen(false)}
          onSaved={(plan) => {
            setPlanOpen(false);
            toast(t('connection.planSaved', { revision: plan.plan_revision }));
            detail.reload();
          }}
        />
      )}
      {confirm && (
        <Modal title={t(`connection.actions.${confirm}`)} onClose={() => setConfirm(null)}>
          <p>{t(`connection.actions.${confirm}Help`)}</p>
          <ErrorNote error={actionError} />
          <div className="onboard-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void act(confirm)}>
              {busy ? t('common.working') : t(`connection.actions.${confirm}`)}
            </button>
            <button type="button" className="btn secondary" onClick={() => { setConfirm(null); navigate(`/app/sources/${connectionId}`); }}>
              {t('common.cancel')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function PlanSummary({ plan }: { plan: ImportPlan }) {
  const { t } = useTranslation();
  const f = useFormat();
  return (
    <DefinitionList
      rows={[
        { label: t('plan.preset'), value: `${t(`plan.presets.${plan.preset}`)} (rev ${plan.plan_revision})` },
        { label: t('plan.timezone'), value: plan.timezone },
        { label: t('plan.requestedFrom'), value: plan.requested_from ? `${f.inZone(plan.requested_from, plan.timezone)} · ${f.utc(plan.requested_from)}` : t('plan.noHistory') },
        { label: t('plan.initialCutoff'), value: `${f.inZone(plan.initial_cutoff, plan.timezone)} · ${f.utc(plan.initial_cutoff)}` },
        { label: t('plan.openContext'), value: plan.include_open_context ? t('common.yes') : t('common.no') },
        { label: t('plan.openingState'), value: plan.include_opening_state ? t('common.yes') : t('common.no') },
        { label: t('plan.strictFromNow'), value: plan.strict_from_now ? t('common.yes') : t('common.no') },
        { label: t('plan.selectedBy'), value: `${plan.selected_by} · ${f.dateTimeSeconds(plan.selected_at)}${plan.inherited_from_workspace ? ` · ${t('plan.inherited')}` : ''}` },
        { label: t('plan.restrictions'), value: plan.restrictions.length ? plan.restrictions.map((r) => t(`limitations.${r}`, { defaultValue: r })).join('; ') : t('common.none') },
      ]}
    />
  );
}

function RunCard({ run, connectionId }: { run: ImportRun; connectionId: string }) {
  const { t } = useTranslation();
  const f = useFormat();
  const phaseIndex = PHASES.indexOf(run.phase);
  return (
    <article className="run-card" aria-label={`${t(`runKind.${run.run_kind}`)} ${run.run_id}`}>
      <div className="run-head">
        <strong>{t(`runKind.${run.run_kind}`)}</strong>
        <StatusBadge kind={run.state} label={t(`runState.${run.state}`)} />
        <span className="muted mono">{run.run_id.slice(0, 8)}</span>
        <Link to={`/app/system?connection_id=${connectionId}&run_id=${run.run_id}`} className="text-link small">
          {t('sources.viewLogs')} →
        </Link>
      </div>
      <ol className="phase-steps" aria-label={t('connection.phases')}>
        {PHASES.map((p, i) => (
          <li key={p} className={i < phaseIndex ? 'done' : i === phaseIndex ? 'current' : ''} aria-current={i === phaseIndex ? 'step' : undefined}>
            {t(`phases.${p}`)}
          </li>
        ))}
      </ol>
      <div className="run-counters">
        <span>
          {t('connection.counters.requested')}: <strong>{run.totals_known && run.counters.requested !== null ? f.number(run.counters.requested) : t('connection.counters.unknownTotal')}</strong>
        </span>
        <span>
          {t('connection.counters.loaded')}: <strong>{f.number(run.counters.loaded)}</strong>
        </span>
        <span>
          {t('connection.counters.committed')}: <strong>{f.number(run.counters.committed)}</strong>
        </span>
        <span>
          {t('connection.counters.applied')}: <strong>{f.number(run.counters.applied)}</strong>
        </span>
        <span>
          {t('connection.counters.failed')}: <strong>{f.number(run.counters.failed)}</strong>
        </span>
        <span className="muted">{t('connection.cohort', { cohort: t(`capabilities.${run.cohort}`, { defaultValue: run.cohort }) })}</span>
      </div>
      {run.totals_known && run.percent !== null ? (
        <div className="progress" role="progressbar" aria-valuenow={run.percent} aria-valuemin={0} aria-valuemax={100} aria-label={t('connection.progressLabel', { phase: t(`phases.${run.phase}`) })}>
          <span style={{ width: `${run.percent}%` }} />
          <small>{t('connection.percentOfPhase', { percent: f.number(run.percent), phase: t(`phases.${run.phase}`) })}</small>
        </div>
      ) : (
        <p className="micro">{t('connection.noPercent')}</p>
      )}
      <p className="micro">
        {t('connection.started')}: {f.dateTimeSeconds(run.started_at)} · {t('connection.updated')}: {f.dateTimeSeconds(run.updated_at)}
        {run.finished_at ? ` · ${t('connection.finished')}: ${f.dateTimeSeconds(run.finished_at)}` : ''}
        {run.outcome ? ` · ${t(`runOutcome.${run.outcome}`, { defaultValue: run.outcome })}` : ''}
        {run.error_code ? ` · ${t(`errors.${run.error_code}`, { defaultValue: run.error_code })}` : ''}
        {run.next_action ? ` · ${t(`nextAction.${run.next_action}`, { defaultValue: run.next_action })}` : ''}
      </p>
    </article>
  );
}

function ImportPlanDialog({ connectionId, current, onClose, onSaved }: { connectionId: string; current: ImportPlan | null; onClose: () => void; onSaved: (p: ImportPlan) => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const [preset, setPreset] = useState<ImportPreset>(current?.preset ?? 'last_30_days');
  const [from, setFrom] = useState('');
  const [timezone, setTimezone] = useState(current?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Europe/Berlin');
  const [openContext, setOpenContext] = useState(current?.include_open_context ?? true);
  const [openingState, setOpeningState] = useState(current?.include_opening_state ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const timezones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['Europe/Berlin', 'UTC'];
    } catch {
      return ['Europe/Berlin', 'UTC'];
    }
  }, []);
  // Client-side preview of the boundaries the server will persist (server result is authoritative and displayed after save).
  const previewFrom = useMemo(() => {
    const now = new Date();
    if (preset === 'last_30_days') return new Date(now.getTime() - 30 * 86400000).toISOString();
    if (preset === 'this_year') return `${now.getFullYear()}-01-01`;
    if (preset === 'last_12_months') return `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (preset === 'custom') return from || null;
    return null;
  }, [preset, from]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const plan = await sourcesApi.importPlan(connectionId, { preset, from: preset === 'custom' ? from : undefined, timezone, include_open_context: preset === 'from_now' ? openContext : true, include_opening_state: openingState });
      onSaved(plan);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('plan.title')} onClose={onClose} wide>
      <p>{t('plan.intro')}</p>
      <fieldset className="preset-list">
        <legend className="form-label">{t('plan.choose')}</legend>
        {PRESETS.map((p) => (
          <label key={p} className={`onboard-source${preset === p ? ' selected' : ''}`}>
            <div>
              <strong>{t(`plan.presets.${p}`)}</strong>
              <small>{t(`plan.presetHelp.${p}`)}</small>
            </div>
            <input type="radio" name="preset" value={p} checked={preset === p} onChange={() => setPreset(p)} />
          </label>
        ))}
      </fieldset>
      {preset === 'custom' && (
        <Field label={t('plan.customFrom')} htmlFor="plan-from" hint={t('plan.customFromHint')}>
          <input id="plan-from" className="field" type="date" value={from} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setFrom(e.target.value)} />
        </Field>
      )}
      <Field label={t('plan.timezone')} htmlFor="plan-tz" hint={t('plan.timezoneHint')}>
        <select id="plan-tz" className="field" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {timezones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </Field>
      {preset === 'from_now' ? (
        <label className="checkbox-row">
          <input type="checkbox" checked={openContext} onChange={(e) => setOpenContext(e.target.checked)} />
          <span>
            {t('plan.fromNowContext')}
            <small>{t('plan.fromNowContextHint')}</small>
          </span>
        </label>
      ) : (
        <>
          <p className="demo-callout">{t('plan.openContextAlways')}</p>
          <label className="checkbox-row">
            <input type="checkbox" checked={openingState} onChange={(e) => setOpeningState(e.target.checked)} />
            <span>
              {t('plan.openingState')}
              <small>{t('plan.openingStateHint')}</small>
            </span>
          </label>
        </>
      )}
      <div className="evidence-box">
        <h3>{t('plan.previewTitle')}</h3>
        <p className="micro">
          {t('plan.previewFrom')}: {previewFrom ? (previewFrom.includes('T') ? `${f.inZone(previewFrom, timezone)} · ${f.utc(previewFrom)}` : `${previewFrom} 00:00 (${timezone})`) : t('plan.noHistory')}
          <br />
          {t('plan.previewCutoff')}: {t('plan.previewCutoffNote')}
        </p>
      </div>
      <ErrorNote error={error} />
      <div className="onboard-actions">
        <button type="button" className="btn primary" disabled={busy || (preset === 'custom' && !from)} onClick={() => void save()}>
          {busy ? t('common.working') : t('plan.save')}
        </button>
        <button type="button" className="btn secondary" onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </Modal>
  );
}
