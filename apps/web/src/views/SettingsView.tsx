import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeading, toast } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { CopyButton, DefinitionList, ErrorNote, Field, Loading, Modal, StatusBadge } from '../components/ui';
import { auth as authApi, settings as settingsApi, workspace as workspaceApi } from '../api/endpoints';
import type { Locale, StorageThresholds } from '../api/types';
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
  const [thresholds, setThresholds] = useState<StorageThresholds | null>(null);
  const [storageError, setStorageError] = useState<unknown>(null);
  const [backupError, setBackupError] = useState<unknown>(null);

  useEffect(() => {
    document.title = `${t('nav.settings')} — ${t('meta.title')}`;
  }, [t]);
  useEffect(() => {
    if (workspace) setName(workspace.display_name);
  }, [workspace]);
  useEffect(() => {
    if (retention.data) setRetentionDraft(Object.fromEntries(Object.entries(retention.data.classes).map(([id, c]) => [id, c.days])));
  }, [retention.data]);
  useEffect(() => {
    if (storage.data?.thresholds) setThresholds(storage.data.thresholds);
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
      retention.setData(await settingsApi.patchRetention(retentionDraft));
      toast(t('settings.saved'));
    } catch (err) {
      setRetentionError(err);
    }
  };
  const saveStorage = async () => {
    if (!thresholds) return;
    setStorageError(null);
    try {
      storage.setData(await settingsApi.patchStorage({ warn_percent: thresholds.warn_percent, warn_min_bytes: thresholds.warn_min_bytes, critical_percent: thresholds.critical_percent, critical_min_bytes: thresholds.critical_min_bytes, log_cap_bytes: thresholds.log_cap_bytes, log_retention_days: thresholds.log_retention_days }));
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
                <pre className="config-code">{'./blackbox backup-config <destination-dir>\n./blackbox backup\n./blackbox restore <backup-file.tar.age>'}</pre>
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
              {Object.entries(retention.data.classes).map(([id, c]) => (
                <Field key={id} label={t(`evidenceClasses.${id}`, { defaultValue: id })} htmlFor={`ret-${id}`} hint={`${t('settings.retention.bounds', { min: 1, max: 3650 })} · ${t(`settings.retention.source.${c.source}`, { defaultValue: c.source })}`}>
                  <input id={`ret-${id}`} className="field" type="number" min={1} max={3650} value={retentionDraft[id] ?? c.days} onChange={(e) => setRetentionDraft((d) => ({ ...d, [id]: Number(e.target.value) }))} />
                </Field>
              ))}
              <p className="micro">{t('settings.retention.defaultDays', { days: retention.data.default_days })}</p>
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
                <input id="st-wp" className="field" type="number" min={1} max={90} value={thresholds.warn_percent} onChange={(e) => setThresholds({ ...thresholds, warn_percent: Number(e.target.value) })} />
              </Field>
              <Field label={t('settings.storage.warningGib')} htmlFor="st-wb">
                <input id="st-wb" className="field" type="number" min={1} value={Math.round(thresholds.warn_min_bytes / 1024 ** 3)} onChange={(e) => setThresholds({ ...thresholds, warn_min_bytes: Number(e.target.value) * 1024 ** 3 })} />
              </Field>
              <Field label={t('settings.storage.criticalPercent')} htmlFor="st-cp">
                <input id="st-cp" className="field" type="number" min={1} max={50} value={thresholds.critical_percent} onChange={(e) => setThresholds({ ...thresholds, critical_percent: Number(e.target.value) })} />
              </Field>
              <Field label={t('settings.storage.criticalGib')} htmlFor="st-cb">
                <input id="st-cb" className="field" type="number" min={1} value={Math.round(thresholds.critical_min_bytes / 1024 ** 3)} onChange={(e) => setThresholds({ ...thresholds, critical_min_bytes: Number(e.target.value) * 1024 ** 3 })} />
              </Field>
              <Field label={t('settings.storage.logCapMib')} htmlFor="st-lc">
                <input id="st-lc" className="field" type="number" min={1} max={100} value={Math.round(thresholds.log_cap_bytes / 1024 ** 2)} onChange={(e) => setThresholds({ ...thresholds, log_cap_bytes: Number(e.target.value) * 1024 ** 2 })} />
              </Field>
              <Field label={t('settings.storage.logRetentionDays')} htmlFor="st-ld">
                <input id="st-ld" className="field" type="number" min={1} max={7} value={thresholds.log_retention_days} onChange={(e) => setThresholds({ ...thresholds, log_retention_days: Number(e.target.value) })} />
              </Field>
            </div>
          )}
          <ErrorNote error={storageError} />
          <button type="button" className="btn primary" disabled={!thresholds} onClick={() => void saveStorage()}>
            {t('common.save')}
          </button>
          {storage.data && (
            <ul className="plain-list">
              {Object.entries(storage.data.volumes).map(([id, v]) => (
                <li key={id}>
                  {t(`volumes.${id}`, { defaultValue: id })}: {v.free_bytes !== undefined ? `${f.bytes(v.free_bytes)} ${t('settings.storage.free')}` : t('common.unknown')} · <StatusBadge kind={v.state} label={t(`storageState.${v.state}`, { defaultValue: v.state })} />
                </li>
              ))}
              <li>
                {t('volumes.evidence')}: {f.bytes(storage.data.evidence.bytes)} {t('settings.storage.used')} · {t('volumes.logs')}: {f.bytes(storage.data.logs.bytes)} / {f.bytes(storage.data.logs.cap_bytes)}
              </li>
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
              <DefinitionList rows={Object.entries(security.data.counts).map(([k, v]) => ({ label: t(`securityEvents.${k}`, { defaultValue: k }), value: f.number(v) }))} />
              <h3 className="drawer-subtitle">{t('settings.security.lastEvents')}</h3>
              <ul className="plain-list">
                {security.data.last_events.map((e, i) => (
                  <li key={i}>
                    <time dateTime={e.occurred_at}>{f.dateTimeSeconds(e.occurred_at)}</time> · {t(`securityEvents.${e.event}`, { defaultValue: e.event })} · {e.actor_kind} · {e.channel}
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
