import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeading, toast } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { CopyButton, DefinitionList, ErrorNote, Field, Loading, Modal, StatusBadge } from '../components/ui';
import { auth as authApi, settings as settingsApi, workspace as workspaceApi } from '../api/endpoints';
import type { Locale } from '../api/types';
import { useAsync } from '../hooks';
import { useFormat } from '../format';
import { useSession } from '../auth/SessionContext';
import { HttpError } from '../api/client';

export function SettingsView() {
  const { t } = useTranslation();
  const f = useFormat();
  const { workspace, refreshWorkspace, locale, setLocale, logout } = useSession();
  const backups = useAsync(() => settingsApi.backups(), [], 5000);
  const retention = useAsync(() => settingsApi.retention(), []);
  const storage = useAsync(() => settingsApi.storage(), []);
  const security = useAsync(() => settingsApi.security(), [], 15000);
  const [name, setName] = useState(workspace?.display_name ?? '');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<unknown>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [currentKey, setCurrentKey] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [retentionDraft, setRetentionDraft] = useState<Record<string, number>>({});
  const [retentionError, setRetentionError] = useState<unknown>(null);
  const [thresholds, setThresholds] = useState<{ warning_percent: number; warning_bytes: number; critical_percent: number; critical_bytes: number } | null>(null);
  const [storageError, setStorageError] = useState<unknown>(null);
  const [backupError, setBackupError] = useState<unknown>(null);

  useEffect(() => {
    document.title = `${t('nav.settings')} — ${t('meta.title')}`;
  }, [t]);
  useEffect(() => {
    if (workspace) setName(workspace.display_name);
  }, [workspace]);
  useEffect(() => {
    if (retention.data) setRetentionDraft(Object.fromEntries(retention.data.classes.map((c) => [c.id, c.days])));
  }, [retention.data]);
  useEffect(() => {
    if (storage.data) setThresholds(storage.data.thresholds);
  }, [storage.data]);
  useEffect(() => {
    if (window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [backups.data]);

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setNameBusy(true);
    setNameError(null);
    try {
      await workspaceApi.patch({ display_name: name.trim() });
      await refreshWorkspace();
      toast(t('settings.saved'));
    } catch (err) {
      setNameError(err);
    } finally {
      setNameBusy(false);
    }
  };
  const rotate = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setRotateError(null);
    try {
      const r = await authApi.rotateKey(currentKey.trim());
      setNewKey(r.new_key);
      setCurrentKey('');
    } catch (err) {
      setRotateError(err instanceof HttpError && err.status === 401 ? new Error(t('settings.rotate.wrongKey')) : err);
    } finally {
      setBusy(false);
    }
  };
  const saveRetention = async () => {
    setRetentionError(null);
    try {
      retention.setData(await settingsApi.patchRetention(Object.entries(retentionDraft).map(([id, days]) => ({ id, days }))));
      toast(t('settings.saved'));
    } catch (err) {
      setRetentionError(err);
    }
  };
  const saveStorage = async () => {
    if (!thresholds) return;
    setStorageError(null);
    try {
      storage.setData(await settingsApi.patchStorage(thresholds));
      toast(t('settings.saved'));
    } catch (err) {
      setStorageError(err);
    }
  };
  const requestBackup = async () => {
    setBackupError(null);
    try {
      await settingsApi.runBackup();
      toast(t('settings.backups.requested'));
      backups.reload();
    } catch (err) {
      setBackupError(err);
    }
  };

  const b = backups.data;
  return (
    <>
      <PageHeading title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <div className="settings-layout">
        <section className="white-panel" id="workspace" aria-labelledby="ws-title">
          <h2 id="ws-title">{t('settings.workspace.title')}</h2>
          <form onSubmit={(e) => void saveName(e)} noValidate>
            <Field label={t('settings.workspace.name')} htmlFor="ws-name">
              <input id="ws-name" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </Field>
            <Field label={t('settings.workspace.locale')} htmlFor="ws-locale" hint={t('settings.workspace.localeHint')}>
              <select id="ws-locale" className="field" value={locale} onChange={(e) => void setLocale(e.target.value as Locale)}>
                <option value="en">English</option>
                <option value="de">Deutsch</option>
              </select>
            </Field>
            <ErrorNote error={nameError} />
            <button type="submit" className="btn primary" disabled={nameBusy || !name.trim()}>
              {nameBusy ? t('common.working') : t('common.save')}
            </button>
          </form>
          <p className="micro">
            {t('settings.workspace.tenant')}: <code className="mono">{workspace?.tenant_id}</code> · {t('settings.workspace.created')}: {f.dateTime(workspace?.created_at)}
          </p>
        </section>

        <section className="white-panel" id="backups" aria-labelledby="bk-title">
          <h2 id="bk-title">
            {t('settings.backups.title')} {b && <StatusBadge kind={b.status} label={t(`backups.status.${b.status}`)} />}
          </h2>
          <p>{t('settings.backups.intro')}</p>
          {backups.loading && !b && <Loading />}
          <ErrorNote error={backups.error} onRetry={backups.reload} />
          {b && (
            <>
              {b.status === 'not_configured' && <div className="answer-warning">{t('settings.backups.unprotected')}</div>}
              {b.status === 'overdue' && <div className="answer-warning">{t('settings.backups.overdueWarning')}</div>}
              {b.status === 'failed' && <div className="answer-warning">{t('settings.backups.failedWarning', { error: b.last_error ?? '' })}</div>}
              {b.same_device && <div className="answer-warning">{t('settings.backups.sameDevice')}</div>}
              <DefinitionList
                rows={[
                  { label: t('settings.backups.destination'), value: b.destination_label ?? t('settings.backups.noDestination') },
                  { label: t('settings.backups.lastAttempt'), value: b.last_attempt_at ? f.dateTimeSeconds(b.last_attempt_at) : t('common.never') },
                  { label: t('settings.backups.lastCompleted'), value: b.last_completed_at ? `${f.dateTimeSeconds(b.last_completed_at)} · ${t('settings.backups.cutoff')} ${f.dateTimeSeconds(b.last_cutoff)}` : t('common.never') },
                  { label: t('settings.backups.recoverableAge'), value: b.recoverable_age_seconds === null ? t('settings.backups.nothingRecoverable') : f.duration(b.recoverable_age_seconds) },
                  { label: t('settings.backups.nextDue'), value: b.next_due_at ? f.dateTimeSeconds(b.next_due_at) : t('common.none') },
                  { label: t('settings.backups.retention'), value: t('settings.backups.retentionText', { daily: b.retention.daily, weekly: b.retention.weekly }) },
                  { label: t('settings.backups.lastRestoreTest'), value: b.last_restore_test_at ? f.dateTimeSeconds(b.last_restore_test_at) : t('settings.backups.noRestoreTest') },
                ]}
              />
              <ErrorNote error={backupError} />
              <div className="onboard-actions">
                <button type="button" className="btn primary" disabled={b.status === 'not_configured' || b.status === 'running'} onClick={() => void requestBackup()}>
                  <Icon name="shield" /> {t('settings.backups.request')}
                </button>
              </div>
              <p className="demo-callout">
                {t('settings.backups.enrolHint')}
                <pre className="config-code">{'./blackbox backup setup\n./blackbox backup\n./blackbox restore <backup-path>'}</pre>
              </p>
            </>
          )}
        </section>

        <section className="white-panel" id="retention" aria-labelledby="ret-title">
          <h2 id="ret-title">{t('settings.retention.title')}</h2>
          <p>{t('settings.retention.intro')}</p>
          {retention.loading && !retention.data && <Loading />}
          <ErrorNote error={retention.error} onRetry={retention.reload} />
          {retention.data && (
            <>
              {retention.data.classes.map((c) => (
                <Field key={c.id} label={t(`evidenceClasses.${c.id}`, { defaultValue: c.id })} htmlFor={`ret-${c.id}`} hint={t('settings.retention.bounds', { min: c.min_days, max: c.provider_limit_days ? Math.min(c.max_days, c.provider_limit_days) : c.max_days }) + (c.provider_limit_days ? ` · ${t('settings.retention.providerLimit', { days: c.provider_limit_days })}` : '')}>
                  <input id={`ret-${c.id}`} className="field" type="number" min={c.min_days} max={c.provider_limit_days ? Math.min(c.max_days, c.provider_limit_days) : c.max_days} value={retentionDraft[c.id] ?? c.days} onChange={(e) => setRetentionDraft((d) => ({ ...d, [c.id]: Number(e.target.value) }))} />
                </Field>
              ))}
              <ErrorNote error={retentionError} />
              <button type="button" className="btn primary" onClick={() => void saveRetention()}>
                {t('common.save')}
              </button>
              <p className="micro">{t('settings.retention.note')}</p>
            </>
          )}
        </section>

        <section className="white-panel" id="storage" aria-labelledby="st-title">
          <h2 id="st-title">{t('settings.storage.title')}</h2>
          <p>{t('settings.storage.intro')}</p>
          {storage.loading && !storage.data && <Loading />}
          <ErrorNote error={storage.error} onRetry={storage.reload} />
          {thresholds && (
            <div className="param-grid">
              <Field label={t('settings.storage.warningPercent')} htmlFor="st-wp">
                <input id="st-wp" className="field" type="number" min={1} max={99} value={thresholds.warning_percent} onChange={(e) => setThresholds({ ...thresholds, warning_percent: Number(e.target.value) })} />
              </Field>
              <Field label={t('settings.storage.warningGib')} htmlFor="st-wb">
                <input id="st-wb" className="field" type="number" min={1} value={Math.round(thresholds.warning_bytes / 1024 ** 3)} onChange={(e) => setThresholds({ ...thresholds, warning_bytes: Number(e.target.value) * 1024 ** 3 })} />
              </Field>
              <Field label={t('settings.storage.criticalPercent')} htmlFor="st-cp">
                <input id="st-cp" className="field" type="number" min={1} max={99} value={thresholds.critical_percent} onChange={(e) => setThresholds({ ...thresholds, critical_percent: Number(e.target.value) })} />
              </Field>
              <Field label={t('settings.storage.criticalGib')} htmlFor="st-cb">
                <input id="st-cb" className="field" type="number" min={1} value={Math.round(thresholds.critical_bytes / 1024 ** 3)} onChange={(e) => setThresholds({ ...thresholds, critical_bytes: Number(e.target.value) * 1024 ** 3 })} />
              </Field>
            </div>
          )}
          <ErrorNote error={storageError} />
          <button type="button" className="btn primary" disabled={!thresholds} onClick={() => void saveStorage()}>
            {t('common.save')}
          </button>
          {storage.data && (
            <ul className="plain-list">
              {storage.data.volumes.map((v) => (
                <li key={v.id}>
                  {t(`volumes.${v.id}`, { defaultValue: v.id })}: {f.bytes(v.used_bytes)} {t('settings.storage.used')} · <StatusBadge kind={v.state} label={t(`storageState.${v.state}`)} />
                </li>
              ))}
            </ul>
          )}
          <p className="micro">{t('settings.storage.note')}</p>
        </section>

        <section className="white-panel" id="security" aria-labelledby="sec-title">
          <h2 id="sec-title">{t('settings.security.title')}</h2>
          {security.loading && !security.data && <Loading />}
          <ErrorNote error={security.error} onRetry={security.reload} />
          {security.data && (
            <>
              <DefinitionList
                rows={[
                  ...Object.entries(security.data.counts).map(([k, v]) => ({ label: t(`securityCounts.${k}`, { defaultValue: k }), value: f.number(v) })),
                  { label: t('settings.security.activeSessions'), value: f.number(security.data.owner_sessions_active) },
                  { label: t('settings.security.activeAgentKeys'), value: f.number(security.data.agent_keys_active) },
                ]}
              />
              <h3 className="drawer-subtitle">{t('settings.security.lastEvents')}</h3>
              <ul className="plain-list">
                {security.data.last_events.map((e, i) => (
                  <li key={i}>
                    <time dateTime={e.at}>{f.dateTimeSeconds(e.at)}</time> · {t(`securityEvents.${e.event}`, { defaultValue: e.event })} · {e.actor}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3 className="drawer-subtitle">{t('settings.rotate.title')}</h3>
          <p>{t('settings.rotate.intro')}</p>
          <button type="button" className="btn secondary" onClick={() => setRotateOpen(true)}>
            <Icon name="key" /> {t('settings.rotate.open')}
          </button>
          <p className="micro">
            {t('settings.rotate.resetHint')} <code>./blackbox reset-access</code>
          </p>
        </section>

        <section className="white-panel" id="lifecycle" aria-labelledby="lc-title">
          <h2 id="lc-title">{t('settings.lifecycle.title')}</h2>
          <p>{t('settings.lifecycle.browserClose')}</p>
          <p>{t('settings.lifecycle.stop')}</p>
          <pre className="config-code">{'./blackbox status\n./blackbox down\n./blackbox up\n./blackbox upgrade\n./blackbox logs --follow --level warn'}</pre>
          <p>{t('settings.lifecycle.sleep')}</p>
          <p className="micro">{t('settings.lifecycle.noAutostart')}</p>
        </section>
      </div>

      {rotateOpen && (
        <Modal title={t('settings.rotate.title')} onClose={() => { setRotateOpen(false); setNewKey(null); }}>
          {!newKey ? (
            <form onSubmit={(e) => void rotate(e)} noValidate>
              <p>{t('settings.rotate.confirmIntro')}</p>
              <Field label={t('settings.rotate.currentKey')} htmlFor="rotate-current">
                <input id="rotate-current" className="field" type="password" autoComplete="current-password" value={currentKey} onChange={(e) => setCurrentKey(e.target.value)} />
              </Field>
              <ErrorNote error={rotateError} />
              <div className="onboard-actions">
                <button type="submit" className="btn primary" disabled={busy || !currentKey.trim()}>
                  {busy ? t('common.working') : t('settings.rotate.submit')}
                </button>
                <button type="button" className="btn secondary" onClick={() => setRotateOpen(false)}>
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          ) : (
            <>
              <p>{t('settings.rotate.newKeyIntro')}</p>
              <pre className="config-code key-display">{newKey}</pre>
              <div className="onboard-actions">
                <CopyButton text={newKey} label={t('agents.copyKey')} />
                <button type="button" className="btn primary" onClick={() => void logout()}>
                  {t('settings.rotate.relogin')}
                </button>
              </div>
              <p className="fineprint">{t('settings.rotate.newKeyNote')}</p>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
