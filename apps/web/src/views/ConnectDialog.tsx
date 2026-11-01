import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../components/Icon';
import { ErrorNote, Field, Modal } from '../components/ui';
import { ingest, sources as sourcesApi } from '../api/endpoints';
import type { CatalogueItem, ConnectionSummary } from '../api/types';

/** Connect dialogs (prototype 16–20 style): shopify, shopify_payments, generic signed API, bank CSV upload (preview before commit), replay. */
export function ConnectDialog({ item, onClose, onConnected }: { item: CatalogueItem; onClose: () => void; onConnected: (c: ConnectionSummary) => void }) {
  const { t } = useTranslation();
  const kind = item.connect_kind;
  const [displayName, setDisplayName] = useState(t(`providers.${item.provider}.name`, { defaultValue: item.provider }));
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<{ rows: number; parsed: Array<Record<string, string>>; ambiguous: number; errors: string[] } | null>(null);
  const [created, setCreated] = useState<ConnectionSummary | null>(null);
  const [replayJson, setReplayJson] = useState('');
  const [replayResult, setReplayResult] = useState<{ accepted: number; duplicate: number; conflict: number; rejected: number } | null>(null);

  const set = (k: string, v: string) => setConfig((c) => ({ ...c, [k]: v }));
  const setS = (k: string, v: string) => setSecret((c) => ({ ...c, [k]: v }));
  const providerName = t(`providers.${item.provider}.name`, { defaultValue: item.provider });

  const createConnection = async (): Promise<ConnectionSummary> => {
    const c = await sourcesApi.createConnection({ provider: item.provider, display_name: displayName.trim(), config, secret: Object.keys(secret).length ? secret : undefined });
    setCreated(c);
    return c;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (kind === 'bank_csv') {
        const conn = created ?? (await createConnection());
        if (!preview) {
          setPreview(await ingest.bankCsvPreview(conn.connection_id, csv));
        } else {
          await ingest.bankCsvCommit(conn.connection_id, csv);
          onConnected(conn);
        }
        return;
      }
      if (kind === 'replay') {
        const conn = created ?? (await createConnection());
        let events: unknown[] = [];
        if (replayJson.trim()) {
          const parsed = JSON.parse(replayJson) as unknown;
          events = Array.isArray(parsed) ? parsed : (parsed as { events?: unknown[] }).events ?? [];
        }
        if (events.length) setReplayResult(await ingest.replay(conn.connection_id, events));
        else onConnected(conn);
        return;
      }
      const conn = await createConnection();
      onConnected(conn);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const steps = (keys: string[]) => (
    <div className="flow-summary">
      {keys.map((k, i) => (
        <div key={k}>
          <Icon name={['plug', 'wave', 'spark'][i] ?? 'check'} />
          <div>
            {t(`connect.steps.${k}.title`)}
            <small>{t(`connect.steps.${k}.detail`)}</small>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <Modal title={t('connect.title', { provider: providerName })} onClose={onClose}>
      <p>{t(`providers.${item.provider}.description`)}</p>
      {steps(['recognize', 'append', 'context'])}
      <form onSubmit={(e) => void submit(e)} noValidate>
        <Field label={t('connect.displayName')} htmlFor="conn-name">
          <input id="conn-name" className="field" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </Field>
        {kind === 'shopify' && (
          <>
            <Field label={t('connect.shopify.domain')} htmlFor="shop-domain" hint={t('connect.shopify.domainHint')}>
              <input id="shop-domain" className="field" placeholder="your-store.myshopify.com" value={config.shop_domain ?? ''} onChange={(e) => set('shop_domain', e.target.value)} />
            </Field>
            <Field label={t('connect.shopify.token')} htmlFor="shop-token" hint={t('connect.shopify.tokenHint')}>
              <input id="shop-token" className="field" type="password" autoComplete="off" value={secret.admin_api_token ?? ''} onChange={(e) => setS('admin_api_token', e.target.value)} />
            </Field>
            <div className="demo-callout">{t('connect.shopify.limits')}</div>
          </>
        )}
        {kind === 'shopify_payments' && (
          <>
            <Field label={t('connect.shopifyPayments.account')} htmlFor="sp-account" hint={t('connect.shopifyPayments.accountHint')}>
              <input id="sp-account" className="field" value={config.account ?? ''} onChange={(e) => set('account', e.target.value)} />
            </Field>
            <Field label={t('connect.shopify.token')} htmlFor="sp-token" hint={t('connect.shopify.tokenHint')}>
              <input id="sp-token" className="field" type="password" autoComplete="off" value={secret.admin_api_token ?? ''} onChange={(e) => setS('admin_api_token', e.target.value)} />
            </Field>
            <div className="demo-callout">{t('connect.shopifyPayments.limits')}</div>
          </>
        )}
        {kind === 'generic' && (
          <>
            <Field label={t('connect.generic.producerId')} htmlFor="gen-producer" hint={t('connect.generic.producerHint')}>
              <input id="gen-producer" className="field" value={config.producer_id ?? ''} onChange={(e) => set('producer_id', e.target.value)} />
            </Field>
            <Field label={t('connect.generic.secret')} htmlFor="gen-secret" hint={t('connect.generic.secretHint')}>
              <input id="gen-secret" className="field" type="password" autoComplete="off" value={secret.hmac_secret ?? ''} onChange={(e) => setS('hmac_secret', e.target.value)} />
            </Field>
            <div className="demo-callout">
              {t('connect.generic.howTo')}
              <pre className="config-code">{`POST http://127.0.0.1:19180/api/ingest/generic\nX-Producer-Id: <producer_id>\nX-Producer-Timestamp: <unix seconds>\nX-Producer-Signature: HMAC-SHA256(timestamp + body)`}</pre>
            </div>
          </>
        )}
        {kind === 'bank_csv' && (
          <>
            <Field label={t('connect.bank.file')} htmlFor="bank-file" hint={t('connect.bank.fileHint')}>
              <input
                id="bank-file"
                className="field"
                type="file"
                accept=".csv,text/csv"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setCsv(await file.text());
                    setPreview(null);
                  }
                }}
              />
            </Field>
            <Field label={t('connect.bank.paste')} htmlFor="bank-csv">
              <textarea id="bank-csv" className="field" rows={5} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} placeholder={'date;reference;amount;currency\n2026-10-31;SHOPIFY PAYOUT PO-2026-10-31;91,70;EUR'} />
            </Field>
            {preview && (
              <div className="evidence-box">
                <h3>{t('connect.bank.previewTitle', { rows: preview.rows, ambiguous: preview.ambiguous, errors: preview.errors.length })}</h3>
                <div className="ledger-table-wrap">
                  <table className="ledger-table small">
                    <thead>
                      <tr>
                        {Object.keys(preview.parsed[0] ?? { date: '', reference: '', amount: '', currency: '' }).map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.parsed.map((row, i) => (
                        <tr key={i}>
                          {Object.values(row).map((v, j) => (
                            <td key={j}>{v}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.errors.length > 0 && <p className="form-error">{preview.errors.join('; ')}</p>}
                <p className="micro">{t('connect.bank.previewNote')}</p>
              </div>
            )}
          </>
        )}
        {kind === 'replay' && (
          <>
            <Field label={t('connect.replay.events')} htmlFor="replay-json" hint={t('connect.replay.eventsHint')}>
              <textarea id="replay-json" className="field mono" rows={6} value={replayJson} onChange={(e) => setReplayJson(e.target.value)} placeholder='[{"provider_event_id":"fixture-1","kind":"order.accepted","occurred_at":"2026-10-31T09:02:00Z","entity":{"order":"#1001"},"payload":{}}]' />
            </Field>
            {replayResult && (
              <div className="evidence-box">
                <h3>{t('connect.replay.result')}</h3>
                <p>{t('connect.replay.counts', replayResult)}</p>
                <button type="button" className="btn small primary" onClick={() => created && onConnected(created)}>
                  {t('common.done')}
                </button>
              </div>
            )}
          </>
        )}
        {kind === null && <div className="demo-callout">{t(item.state === 'unsupported' ? 'connect.unsupported' : 'connect.planned', { provider: providerName })}</div>}
        <div className="demo-callout">{t('connect.secretNote')}</div>
        <ErrorNote error={error} />
        {kind !== null && (
          <button type="submit" className="btn primary full" disabled={busy || (kind === 'bank_csv' && !csv.trim())}>
            {busy ? t('common.working') : kind === 'bank_csv' ? (preview ? t('connect.bank.commit') : t('connect.bank.preview')) : kind === 'replay' ? t('connect.replay.submit') : t('connect.submit')}
            <Icon name="arrow" />
          </button>
        )}
      </form>
    </Modal>
  );
}
