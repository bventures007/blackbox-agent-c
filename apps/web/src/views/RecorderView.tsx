import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeading, toast } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { ErrorNote, Loading, Modal, StatusBadge } from '../components/ui';
import { EntryDrawer } from '../components/EntryDrawer';
import { ingest, journal as journalApi, sources as sourcesApi, questions as questionsApi } from '../api/endpoints';
import { TRACKS, type JournalEntry, type Track } from '../api/types';
import { useAsync } from '../hooks';
import { useFormat } from '../format';
import { useSession } from '../auth/SessionContext';

const SHORTCUTS = ['order-01', 'delivery-01', 'invoice-01', 'collection-01', 'settlement-01', 'reversal-01'];

export function RecorderView() {
  const { t } = useTranslation();
  const f = useFormat();
  const navigate = useNavigate();
  const { workspace, refreshWorkspace } = useSession();
  const journal = useAsync(() => journalApi.list({ limit: 60 }), [], 10000);
  const catalogue = useAsync(() => sourcesApi.catalogue(), [], 15000);
  const templates = useAsync(() => questionsApi.list(), []);
  const [openEntry, setOpenEntry] = useState<string | null>(null);
  const [demoDialog, setDemoDialog] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState<unknown>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    document.title = `${t('nav.recorder')} — ${t('meta.title')}`;
  }, [t]);

  const entries = journal.data?.entries ?? [];
  const byTrack = (track: Track) => entries.filter((e) => e.track === track).slice(0, 4);
  const connections = catalogue.data?.catalogue.flatMap((c) => c.connections) ?? [];
  const degraded = connections.filter((c) => c.state === 'delayed' || c.state === 'error' || c.state === 'disconnected');
  const latestRecorded = entries[0]?.recorded_at ?? null;
  const lastNewEvent = connections.reduce<string | null>((acc, c) => (c.last_new_event_at && (!acc || c.last_new_event_at > acc) ? c.last_new_event_at : acc), null);
  const readyQuestions = templates.data?.filter((q) => q.readiness.status === 'ready').length ?? 0;

  const runDemo = async (confirm: boolean) => {
    setDemoBusy(true);
    setDemoError(null);
    try {
      const r = await ingest.demoRun(confirm);
      toast(r.already_loaded ? t('recorder.demoAlready') : t('recorder.demoLoaded', { count: r.loaded }));
      setDemoDialog(false);
      journal.reload();
      catalogue.reload();
      templates.reload();
      void refreshWorkspace();
    } catch (e) {
      setDemoError(e);
    } finally {
      setDemoBusy(false);
    }
  };

  return (
    <>
      <PageHeading
        title={t('recorder.title')}
        subtitle={t('recorder.subtitle')}
        actions={
          <>
            <button type="button" className="btn secondary" onClick={() => setDemoDialog(true)}>
              <Icon name="play" /> {t('recorder.runExample')}
            </button>
            <Link className="btn primary" to="/app/sources">
              <Icon name="plus" /> {t('recorder.connectSource')}
            </Link>
          </>
        }
      />
      <div className="stats-grid">
        <div className="stat">
          <div className="stat-label">
            {t('recorder.stats.sources')} <Icon name="plug" />
          </div>
          <div className="stat-value">
            {catalogue.data ? connections.length : '–'} <small>{t('recorder.stats.sourcesUnit')}</small>
          </div>
          <div className="stat-foot">
            {degraded.length ? <StatusBadge kind="degraded" label={t('recorder.stats.degraded', { count: degraded.length })} /> : <StatusBadge kind="current" label={t('recorder.stats.allCurrent')} />}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">
            {t('recorder.stats.entries')} <Icon name="wave" />
          </div>
          <div className="stat-value">
            {journal.data ? f.number(journal.data.page.snapshot_cursor > 0 ? journal.data.page.snapshot_cursor - 1000 : entries.length) : '–'} <small>{t('recorder.stats.entriesUnit')}</small>
          </div>
          <div className="stat-foot">
            <Icon name="clock" /> {t('recorder.stats.lastRecorded')}: {latestRecorded ? f.relative(latestRecorded) : t('common.never')}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">
            {t('recorder.stats.readyQuestions')} <Icon name="spark" />
          </div>
          <div className="stat-value">
            {templates.data ? readyQuestions : '–'} <small>{t('recorder.stats.of24')}</small>
          </div>
          <div className="stat-foot">
            <Link to="/app/questions">{t('recorder.stats.openQuestions')} →</Link>
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">
            {t('recorder.stats.review')} <Icon name="shield" />
          </div>
          <div className="stat-value">
            {workspace ? workspace.unresolved_review_count : '–'} <small>{t('recorder.stats.reviewUnit')}</small>
          </div>
          <div className="stat-foot">
            <Link to="/app/sources#review">{t('recorder.stats.openReview')} →</Link>
          </div>
        </div>
      </div>

      <section className="recorder" aria-label={t('recorder.tracksLabel')}>
        <div className="recorder-header">
          <div className="recorder-title">
            <Icon name="wave" /> {t('recorder.recorderTitle')}
            <span className="live-label">
              <i className="dot" /> {paused ? t('recorder.paused') : t('recorder.live')}
            </span>
          </div>
          <div className="recorder-tools">
            <span className="recording-status">{t('recorder.sourcesActive', { count: connections.filter((c) => c.state === 'current' || c.state === 'initial_import').length })}</span>
            <button type="button" className="icon-btn" onClick={() => setPaused((p) => !p)} aria-pressed={paused} aria-label={paused ? t('recorder.resumeView') : t('recorder.pauseView')} title={paused ? t('recorder.resumeView') : t('recorder.pauseView')}>
              <Icon name={paused ? 'play' : 'pause'} />
            </button>
            <button type="button" className="btn secondary small" onClick={() => journal.reload()}>
              <Icon name="refresh" /> {t('common.refresh')}
            </button>
          </div>
        </div>
        <div className="recorder-ruler">
          <span className="ruler-caption">{t('recorder.ruler')}</span>
          <div className="ruler-times">
            <span>{entries.length ? f.time(entries[Math.min(entries.length - 1, 20)].occurred_at) : ''}</span>
            <span>{lastNewEvent ? `${t('recorder.lastNewEvent')} ${f.time(lastNewEvent)}` : ''}</span>
            <span>{entries.length ? `${f.time(entries[0].occurred_at)} · ${t('recorder.now')}` : t('recorder.now')}</span>
          </div>
        </div>
        {journal.loading && !journal.data && <Loading />}
        <ErrorNote error={journal.error} onRetry={journal.reload} />
        {TRACKS.map((track) => (
          <div className="track-row" key={track} data-track={track}>
            <div className="track-name">
              <i aria-hidden="true" />
              {t(`tracks.${track}`)}
              <small>{entries.filter((e) => e.track === track).length}</small>
            </div>
            <div className="track-lane">
              {byTrack(track).length === 0 && <span className="lane-empty">{journal.data ? t('recorder.laneEmpty') : ''}</span>}
              {(paused ? byTrack(track) : byTrack(track)).map((e: JournalEntry) => (
                <button type="button" className="event-chip" key={e.entry_id} onClick={() => setOpenEntry(e.entry_id)} title={e.summary ?? e.record_id}>
                  <Icon name={track === 'source' ? 'plug' : track === 'fact' ? 'check' : track === 'commitment' ? 'clock' : track === 'movement' ? 'arrow' : 'lock'} />
                  <span>{e.summary ?? e.record_id}</span>
                  <time dateTime={e.occurred_at}>{f.time(e.occurred_at)}</time>
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="recorder-bottom">
          <span>
            <Icon name="shield" /> {t('recorder.footerNote')}
          </span>
          <Link to="/app/journal">{t('recorder.allEntries')} ↗</Link>
        </div>
      </section>

      <div className="dashboard-lower">
        <section className="ask-panel" aria-labelledby="ask-title">
          <div className="panel-head">
            <span id="ask-title">
              <Icon name="spark" /> {t('recorder.askTitle')}
            </span>
            <small>{t('recorder.askNoModel')}</small>
          </div>
          <p>{t('recorder.askIntro')}</p>
          <div className="question-suggestions">
            {SHORTCUTS.map((id) => {
              const tpl = templates.data?.find((q) => q.id === id);
              return (
                <button key={id} type="button" onClick={() => navigate(`/app/questions?q=${id}`)}>
                  {t(`questionsCatalog.${id}.q`)}
                  {tpl && <> · <StatusBadge kind={tpl.readiness.status} label={t(`readinessState.${tpl.readiness.status}`)} /></>}
                </button>
              );
            })}
          </div>
          <div className="ask-foot">
            <Icon name="shield" /> {t('recorder.askFoot')}
          </div>
        </section>
        <section className="activity-panel" aria-labelledby="activity-title">
          <div className="panel-head">
            <span id="activity-title">
              <Icon name="clock" /> {t('recorder.activityTitle')}
            </span>
            <small>{latestRecorded ? f.date(latestRecorded) : ''}</small>
          </div>
          {entries.slice(0, 6).map((e) => (
            <button type="button" className="activity-item as-row" key={e.entry_id} onClick={() => setOpenEntry(e.entry_id)}>
              <span className="activity-symbol">
                <Icon name="wave" />
              </span>
              <div>
                <strong>{e.summary ?? e.record_id}</strong>
                <p>
                  {t(`tracks.${e.track}`)} · <code className="mono">{e.event_type}</code>
                </p>
              </div>
              <time dateTime={e.recorded_at}>{f.time(e.recorded_at)}</time>
            </button>
          ))}
          {journal.data && entries.length === 0 && <p className="muted">{t('recorder.noActivity')}</p>}
          <h3 className="panel-sub">{t('recorder.sourceReadiness')}</h3>
          {catalogue.loading && !catalogue.data && <Loading />}
          <ErrorNote error={catalogue.error} onRetry={catalogue.reload} />
          {connections.map((c) => (
            <Link key={c.connection_id} className="activity-item" to={`/app/sources/${c.connection_id}`}>
              <span className="activity-symbol">
                <Icon name="plug" />
              </span>
              <div>
                <strong>
                  {c.display_name} <StatusBadge kind={c.state} label={t(`sourceState.${c.state}`)} />
                </strong>
                <p>
                  {t('readiness.lastSuccessfulCheck')}: {c.last_successful_check_at ? f.relative(c.last_successful_check_at) : t('common.never')} · {t('readiness.lastNewEvent')}:{' '}
                  {c.last_new_event_at ? f.relative(c.last_new_event_at) : t('common.never')}
                </p>
              </div>
            </Link>
          ))}
          {catalogue.data && connections.length === 0 && <p className="muted">{t('recorder.noSources')}</p>}
        </section>
      </div>
      <p className="context-note">
        <span>{t('recorder.contextNote')}</span>
        <span>{t('recorder.contextModel')}</span>
      </p>

      {openEntry && <EntryDrawer entryId={openEntry} onClose={() => setOpenEntry(null)} onOpenEntry={setOpenEntry} />}
      {demoDialog && (
        <Modal title={t('recorder.demoTitle')} onClose={() => setDemoDialog(false)}>
          <p>{t('recorder.demoBody')}</p>
          <ul className="plain-list">
            <li>{t('recorder.demoPoint1')}</li>
            <li>{t('recorder.demoPoint2')}</li>
            <li>{t('recorder.demoPoint3')}</li>
          </ul>
          <ErrorNote error={demoError} />
          <div className="onboard-actions">
            <button type="button" className="btn primary" disabled={demoBusy} onClick={() => void runDemo(false)}>
              <Icon name="play" /> {demoBusy ? t('common.working') : t('recorder.demoConfirm')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setDemoDialog(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
