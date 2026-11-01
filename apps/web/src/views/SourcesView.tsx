import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeading, toast } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { ErrorNote, Loading, StatusBadge } from '../components/ui';
import { sources as sourcesApi } from '../api/endpoints';
import type { CatalogueItem, SourceCategory } from '../api/types';
import { useAsync } from '../hooks';
import { useFormat } from '../format';
import { ConnectDialog } from './ConnectDialog';
import { ReviewList } from './ReviewList';

const CATEGORIES: SourceCategory[] = ['shops', 'payment', 'billing', 'shipping', 'other'];
const CATEGORY_ICON: Record<SourceCategory, string> = { shops: 'box', payment: 'arrow', billing: 'list', shipping: 'truck', other: 'code' };
const PROVIDER_CLASS: Record<string, string> = { shopify: 'shopify', shopify_payments: 'shopify_payments', generic: 'api', replay: 'api', email: 'email', woocommerce: 'api', shopware: 'shopware', bank_csv: 'api', stripe: 'stripe', paypal: 'paypal', mollie: 'mollie', easybill: 'easybill', lexware: 'lexware', sevdesk: 'sevdesk', billbee: 'billbee', sufio: 'sufio', dhl: 'dhl', dpd: 'dpd', ups: 'ups' };
const PROVIDER_GLYPH: Record<string, string> = { shopify: 'S', shopify_payments: 'Sp', generic: '</>', replay: '⟲', email: '✉', woocommerce: 'W', shopware: 'sw', bank_csv: '¤', stripe: 'S', paypal: 'P', mollie: 'm', easybill: 'eb', lexware: 'Lx', sevdesk: 'sv', billbee: 'Bb', sufio: 'su', dhl: 'DHL', dpd: 'dpd', ups: 'ups' };

export function SourcesView() {
  const { t } = useTranslation();
  const f = useFormat();
  const navigate = useNavigate();
  const catalogue = useAsync(() => sourcesApi.catalogue(), [], 10000);
  const [connecting, setConnecting] = useState<CatalogueItem | null>(null);

  useEffect(() => {
    document.title = `${t('nav.sources')} — ${t('meta.title')}`;
  }, [t]);
  useEffect(() => {
    if (window.location.hash === '#review') document.getElementById('review')?.scrollIntoView();
  }, [catalogue.data]);

  const items = catalogue.data?.catalogue ?? [];
  const connected = items.flatMap((i) => i.connections);
  const degraded = connected.filter((c) => c.degraded);
  const reasonText = (reason: string | null) => (reason ? t(`nextCheckReason.${reason.split(':')[0].trim()}`, { defaultValue: reason, detail: reason.split(':').slice(1).join(':').trim() }) : '');

  return (
    <>
      <PageHeading title={t('sources.title')} subtitle={t('sources.subtitle')} />
      <div className="source-jump-links" role="navigation" aria-label={t('sources.jumpLabel')}>
        {CATEGORIES.map((c) => (
          <a key={c} href={`#cat-${c}`} className="btn secondary small">
            <Icon name={CATEGORY_ICON[c]} /> {t(`sources.categories.${c}.title`)}
          </a>
        ))}
        <a href="#review" className="btn secondary small">
          <Icon name="shield" /> {t('review.title')}
        </a>
      </div>
      {catalogue.loading && !catalogue.data && <Loading />}
      <ErrorNote error={catalogue.error} onRetry={catalogue.reload} />

      {connected.length > 0 && (
        <section className="source-group" aria-labelledby="connected-title">
          <div className="source-group-heading">
            <div>
              <h2 id="connected-title">{t('sources.connectedTitle', { count: connected.length })}</h2>
              <p>{degraded.length ? t('sources.connectedDegraded', { count: degraded.length }) : t('sources.connectedOk')}</p>
            </div>
          </div>
          <div className="ledger-table-wrap">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>{t('sources.columns.connection')}</th>
                  <th>{t('sources.columns.state')}</th>
                  <th>{t('sources.columns.lastCheck')}</th>
                  <th>{t('sources.columns.lastNewEvent')}</th>
                  <th>{t('sources.columns.nextCheck')}</th>
                  <th>{t('sources.columns.created')}</th>
                  <th>
                    <span className="sr-only">{t('common.open')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...degraded, ...connected.filter((c) => !degraded.includes(c))].map((c) => (
                  <tr key={c.connection_id} data-action="open" onClick={() => navigate(`/app/sources/${c.connection_id}`)}>
                    <td>
                      <strong>{c.display_name}</strong>
                      <br />
                      <small className="muted">
                        {t(`providers.${c.provider}.name`, { defaultValue: c.provider })}
                        {c.account_label ? ` · ${c.account_label}` : ''}
                        {c.demo ? ` · ${t('sources.demoLabel')}` : ''}
                      </small>
                    </td>
                    <td>
                      <StatusBadge kind={c.state} label={t(`sourceState.${c.state}`)} />
                    </td>
                    <td>
                      <time dateTime={c.last_successful_check_at ?? undefined} title={f.dateTimeSeconds(c.last_successful_check_at)}>{c.last_successful_check_at ? f.relative(c.last_successful_check_at) : t('common.never')}</time>
                    </td>
                    <td>
                      <time dateTime={c.last_new_event_at ?? undefined} title={f.dateTimeSeconds(c.last_new_event_at)}>{c.last_new_event_at ? f.relative(c.last_new_event_at) : t('common.never')}</time>
                    </td>
                    <td>
                      {c.next_check_at ? f.dateTime(c.next_check_at) : t('sources.noNextCheck')}
                      <br />
                      <small className="muted">{reasonText(c.next_check_reason)}</small>
                    </td>
                    <td>
                      <time dateTime={c.created_at} title={f.dateTimeSeconds(c.created_at)}>{f.date(c.created_at)}</time>
                    </td>
                    <td>
                      <Link className="icon-btn" to={`/app/sources/${c.connection_id}`} aria-label={t('sources.openConnection', { name: c.display_name })} onClick={(e) => e.stopPropagation()}>
                        <Icon name="chevron" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {CATEGORIES.map((cat) => {
        const group = items.filter((i) => i.category === cat);
        if (!group.length) return null;
        return (
          <section className="source-group" id={`cat-${cat}`} key={cat} aria-labelledby={`cat-title-${cat}`}>
            <div className="source-group-heading">
              <div>
                <h2 id={`cat-title-${cat}`}>{t(`sources.categories.${cat}.title`)}</h2>
                <p>{t(`sources.categories.${cat}.description`)}</p>
              </div>
            </div>
            <div className="app-section-grid">
              {group.map((item) => (
                <article className="integration-card" key={item.provider} aria-labelledby={`prov-${item.provider}`}>
                  <div className="integration-top">
                    <span className={`source-icon ${PROVIDER_CLASS[item.provider] ?? 'api'}`} aria-hidden="true">
                      {PROVIDER_GLYPH[item.provider] ?? item.provider.slice(0, 2)}
                    </span>
                    <StatusBadge kind={item.state} label={t(`providerState.${item.state}`)} />
                  </div>
                  <h2 id={`prov-${item.provider}`}>{t(`providers.${item.provider}.name`, { defaultValue: item.name })}</h2>
                  <p>{t(`providers.${item.provider}.description`, { defaultValue: item.name })}</p>
                  <div className="integration-info">
                    {item.capabilities.map((c) => (
                      <span key={c.id} className="capability-pill" title={`${t(`sourceState.${c.state}`, { defaultValue: c.state })}${c.next_check_reason ? ` · ${reasonText(c.next_check_reason)}` : ''}${c.limitations.length ? ` · ${c.limitations.join('; ')}` : ''}`}>
                        {t(`capabilities.${c.id}`, { defaultValue: c.id })} · <StatusBadge kind={c.state} label={t(`sourceState.${c.state}`, { defaultValue: c.state })} />
                        {c.limitations.length ? ' *' : ''}
                      </span>
                    ))}
                    {item.from_api && item.state !== 'planned' && item.state !== 'unsupported' && item.capabilities.length === 0 && <span className="capability-pill muted">{t('sources.noCapabilitiesYet')}</span>}
                  </div>
                  {item.capabilities.some((c) => c.limitations.length > 0) && (
                    <ul className="limitations">
                      {item.capabilities.flatMap((c) => c.limitations.map((l) => <li key={`${c.id}-${l}`}>* {t(`limitations.${l}`, { defaultValue: l })}</li>))}
                    </ul>
                  )}
                  {item.connections.length > 0 && (
                    <div className="connection-state">
                      <Icon name="check" /> {t('sources.connectionsOnCard', { count: item.connections.length })}
                    </div>
                  )}
                  {item.connect_kind ? (
                    <button type="button" className={`btn ${item.connections.length ? 'secondary' : 'primary'}`} onClick={() => setConnecting(item)}>
                      <Icon name={item.connections.length ? 'plus' : 'plug'} /> {item.connections.length ? t('sources.connectAnother') : t('sources.connect')}
                    </button>
                  ) : item.state === 'planned' || item.state === 'unsupported' ? (
                    <button type="button" className="btn secondary" disabled aria-disabled="true" title={t(item.state === 'unsupported' ? 'providerState.unsupportedHint' : 'providerState.plannedHint')}>
                      <Icon name="clock" /> {t(item.state === 'unsupported' ? 'providerState.unsupported' : 'providerState.planned')}
                    </button>
                  ) : (
                    <button type="button" className="btn secondary" disabled aria-disabled="true" title={t('providerState.apiOnlyHint')}>
                      <Icon name="code" /> {t('providerState.apiOnly')}
                    </button>
                  )}
                  {item.connections.map((c) => (
                    <Link key={c.connection_id} className="billing-card-link" to={`/app/sources/${c.connection_id}`}>
                      {c.display_name} · <StatusBadge kind={c.state} label={t(`sourceState.${c.state}`)} /> <Icon name="arrow" />
                    </Link>
                  ))}
                </article>
              ))}
            </div>
            {cat === 'shipping' && <p className="payment-source-note">{t('sources.shippingNote')}</p>}
            {cat === 'billing' && <p className="payment-source-note">{t('sources.billingNote')}</p>}
          </section>
        );
      })}

      <div className="info-strip">
        <Icon name="info" />
        <span>
          {t('sources.modeNote')} {t('sources.plannedNote')}
          {catalogue.data?.readiness_observed_at ? ` ${t('sources.observedAt', { time: f.dateTimeSeconds(catalogue.data.readiness_observed_at) })}` : ''}
        </span>
      </div>

      <ReviewList />

      {connecting && (
        <ConnectDialog
          item={connecting}
          onClose={() => setConnecting(null)}
          onConnected={(c) => {
            setConnecting(null);
            toast(t('sources.connected', { name: c.display_name }));
            catalogue.reload();
            navigate(`/app/sources/${c.connection_id}`);
          }}
        />
      )}
    </>
  );
}
