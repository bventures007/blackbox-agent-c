import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeading, toast } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { CopyButton, ErrorNote, Field, Loading, Modal, StatusBadge } from '../components/ui';
import { agents as agentsApi } from '../api/endpoints';
import type { AgentCredential } from '../api/types';
import { useAsync } from '../hooks';
import { useFormat } from '../format';

export function AgentsView() {
  const { t } = useTranslation();
  const f = useFormat();
  const list = useAsync(() => agentsApi.list(), [], 10000);
  const mcp = useAsync(() => agentsApi.mcpConfig(), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ credential_id: string; key: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<AgentCredential | null>(null);
  const [client, setClient] = useState<'claude' | 'inspector' | 'custom'>('claude');

  useEffect(() => {
    document.title = `${t('nav.agents')} — ${t('meta.title')}`;
  }, [t]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await agentsApi.create(name.trim(), expires ? new Date(expires).toISOString() : undefined);
      setCreated({ ...r, name: name.trim() });
      setName('');
      setExpires('');
      setCreateOpen(false);
      list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await agentsApi.revoke(revoking.credential_id);
      toast(t('agents.revoked', { name: revoking.name }));
      setRevoking(null);
      list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const configSnippet = mcp.data ? mcp.data.snippet : '';

  return (
    <>
      <PageHeading
        title={t('agents.title')}
        subtitle={t('agents.subtitle')}
        actions={
          <button type="button" className="btn primary" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" /> {t('agents.create')}
          </button>
        }
      />
      <div className="agent-config-layout">
        <section className="white-panel">
          <h2>{t('agents.keysTitle')}</h2>
          <p>{t('agents.keysIntro')}</p>
          <div className="permission-list">
            <span>
              <Icon name="check" /> {t('agents.grantRead')} <code className="mono">workspace.read_business</code>
            </span>
            <span>
              <Icon name="check" /> {t('agents.grantScope')}
            </span>
            <span>
              <Icon name="lock" /> {t('agents.grantExcluded')}
            </span>
          </div>
          {list.loading && !list.data && <Loading />}
          <ErrorNote error={list.error} onRetry={list.reload} />
          {list.data && list.data.length === 0 && <p className="muted">{t('agents.none')}</p>}
          {list.data && list.data.length > 0 && (
            <div className="ledger-table-wrap">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>{t('agents.columns.name')}</th>
                    <th>{t('agents.columns.status')}</th>
                    <th>{t('agents.columns.created')}</th>
                    <th>{t('agents.columns.lastUsed')}</th>
                    <th>{t('agents.columns.expires')}</th>
                    <th>
                      <span className="sr-only">{t('agents.columns.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((a) => (
                    <tr key={a.credential_id}>
                      <td>
                        <strong>{a.name}</strong>
                        <br />
                        <small className="mono muted">{a.credential_id.slice(0, 8)} · {t('agents.grantShort')}</small>
                      </td>
                      <td>
                        <StatusBadge kind={a.status} label={t(`agents.status.${a.status}`)} />
                      </td>
                      <td>{f.dateTime(a.created_at)}</td>
                      <td>{a.last_used_at ? f.dateTimeSeconds(a.last_used_at) : t('agents.neverUsed')}</td>
                      <td>{a.expires_at ? f.dateTime(a.expires_at) : t('agents.noExpiry')}</td>
                      <td>
                        {a.status === 'active' && (
                          <button type="button" className="btn small secondary" onClick={() => setRevoking(a)}>
                            {t('agents.revoke')}
                          </button>
                        )}
                        {a.revoked_at && <small className="muted">{f.dateTime(a.revoked_at)}</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2 className="section-gap">{t('agents.localFlowTitle')}</h2>
          <div className="numbered-step">
            <span>1</span>
            <div>
              <b>{t('agents.flow1Title')}</b> — {t('agents.flow1Body')}
            </div>
          </div>
          <div className="numbered-step">
            <span>2</span>
            <div>
              <b>{t('agents.flow2Title')}</b> — {t('agents.flow2Body')}
            </div>
          </div>
          <div className="numbered-step">
            <span>3</span>
            <div>
              <b>{t('agents.flow3Title')}</b> — {t('agents.flow3Body')} <Link to="/app/questions">{t('nav.questions')} →</Link>
            </div>
          </div>
        </section>
        <section className="white-panel">
          <h2>{t('agents.connectTitle')}</h2>
          <p>{t('agents.connectIntro')}</p>
          <div className="agent-options" role="group" aria-label={t('agents.clientChoice')}>
            {(['claude', 'inspector', 'custom'] as const).map((c) => (
              <button key={c} type="button" className={`agent-option${client === c ? ' selected' : ''}`} aria-pressed={client === c} onClick={() => setClient(c)}>
                <Icon name={c === 'custom' ? 'code' : c === 'inspector' ? 'search' : 'spark'} /> {t(`agents.clients.${c}`)}
              </button>
            ))}
          </div>
          <p className="demo-callout">{t(`agents.clientNote.${client}`)}</p>
          <div className="code-head">
            <span>{t('agents.configLabel')} · stdio</span>
            {configSnippet && <CopyButton text={configSnippet} label={t('common.copy')} />}
          </div>
          {mcp.loading && !mcp.data && <Loading />}
          <ErrorNote error={mcp.error} onRetry={mcp.reload} />
          {mcp.data && (
            <>
              <pre className="config-code">{configSnippet}</pre>
              <p className="micro">{t('agents.configNote', { env: 'BLACKBOX_AGENT_KEY_FILE', alt: 'BLACKBOX_AGENT_KEY' })}</p>
              <p className="micro">
                {t('agents.bridgeCommand')}: <code className="mono">{[mcp.data.command, ...mcp.data.args].join(' ')}</code> · {t('agents.apiUrl')}: <code className="mono">{mcp.data.env.BLACKBOX_API_URL}</code>
              </p>
              <ul className="plain-list micro">
                {mcp.data.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <p className="micro">{t('agents.testedClients')}: {t('agents.testedClientsNote')}</p>
            </>
          )}
          <h2 className="section-gap">{t('agents.reachTitle')}</h2>
          <p>{t('agents.reachBody')}</p>
          <div className="tools-list">
            {['query_business', 'search_events', 'get_business_state', 'get_journal_entry', 'get_entity_history', 'get_evidence'].map((tool) => (
              <div className="tool-row" key={tool}>
                <code>{tool}</code>
                <p>{t(`agents.tools.${tool}`)}</p>
              </div>
            ))}
          </div>
          <p className="micro">{t('agents.untrustedNote')}</p>
        </section>
      </div>

      {createOpen && (
        <Modal title={t('agents.createTitle')} onClose={() => setCreateOpen(false)}>
          <p>{t('agents.createIntro')}</p>
          <form onSubmit={(e) => void create(e)} noValidate>
            <Field label={t('agents.nameLabel')} htmlFor="agent-name" hint={t('agents.nameHint')}>
              <input id="agent-name" className="field" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
            </Field>
            <Field label={t('agents.expiresLabel')} htmlFor="agent-expires" hint={t('agents.expiresHint')}>
              <input id="agent-expires" className="field" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </Field>
            <ErrorNote error={error} />
            <div className="onboard-actions">
              <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
                {busy ? t('common.working') : t('agents.createConfirm')}
              </button>
              <button type="button" className="btn secondary" onClick={() => setCreateOpen(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {created && (
        <Modal title={t('agents.keyShownTitle', { name: created.name })} onClose={() => setCreated(null)}>
          <p>{t('agents.keyShownIntro')}</p>
          <pre className="config-code key-display" aria-label={t('agents.keyLabel')}>
            {created.key}
          </pre>
          <div className="onboard-actions">
            <CopyButton text={created.key} label={t('agents.copyKey')} />
            <button type="button" className="btn primary" onClick={() => setCreated(null)}>
              {t('agents.keySaved')}
            </button>
          </div>
          <p className="fineprint">{t('agents.keyShownNote')}</p>
        </Modal>
      )}
      {revoking && (
        <Modal title={t('agents.revokeTitle', { name: revoking.name })} onClose={() => setRevoking(null)}>
          <p>{t('agents.revokeBody')}</p>
          <ErrorNote error={error} />
          <div className="onboard-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void revoke()}>
              {busy ? t('common.working') : t('agents.revoke')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setRevoking(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
