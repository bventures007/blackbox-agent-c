import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { journal as journalApi } from '../api/endpoints';
import type { JournalEntry } from '../api/types';
import { useAsync } from '../hooks';
import { useFormat } from '../format';
import { DefinitionList, Drawer, ErrorNote, Loading, StatusBadge } from './ui';
import { Icon } from './Icon';

/** Short human label for an entry: event type plus the entity it is about. */
export function entrySummary(e: Pick<JournalEntry, 'record_id' | 'event_type'>): string {
  return `${e.event_type} · ${e.record_id}`;
}

/** Journal entry drawer: payload, evidence (original excerpt), links to supersedes/superseded/derived entries and entities. */
export function EntryDrawer({ entryId, onClose, onOpenEntry }: { entryId: string; onClose: () => void; onOpenEntry: (id: string) => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const entry = useAsync(() => journalApi.entry(entryId), [entryId]);
  const e = entry.data;
  return (
    <Drawer onClose={onClose} eyebrow={<><Icon name="wave" /> {t('journal.entryEyebrow')}</>} title={e ? e.record_id : t('common.loading')}>
      {entry.loading && <Loading />}
      <ErrorNote error={entry.error} onRetry={entry.reload} />
      {e && (
        <>
          <p>
            <span className="type-tag" data-track={e.track}>
              {t(`tracks.${e.track}`)}
            </span>{' '}
            <code className="mono">{e.event_type}</code>
            {e.supersedes_entry_id && <> · <StatusBadge tone="info" label={t('journal.supersedesShort')} /></>}
            {e.superseded_by.length > 0 && <> · <StatusBadge tone="warn" label={t('journal.supersededBy')} /></>}
          </p>
          <DefinitionList
            rows={[
              { label: t('journal.fields.recordId'), value: <code>{e.record_id}</code> },
              { label: t('journal.fields.sequence'), value: e.journal_sequence },
              { label: t('journal.fields.occurredAt'), value: f.dateTimeSeconds(e.occurred_at) },
              { label: t('journal.fields.recordedAt'), value: f.dateTimeSeconds(e.recorded_at) },
              { label: t('journal.fields.provider'), value: e.provider ? t(`providers.${e.provider}.name`, { defaultValue: e.provider }) : t('common.unknown') },
              { label: t('journal.fields.connection'), value: e.connection_id ? <Link to={`/app/sources/${e.connection_id}`}>{t('journal.openConnection')}</Link> : t('common.none') },
              { label: t('journal.fields.providerEventId'), value: e.provider_event_id ?? t('common.none') },
              { label: t('journal.fields.schemaVersion'), value: e.schema_version },
              ...(e.correlation_id ? [{ label: t('journal.fields.correlation'), value: <code className="mono">{e.correlation_id}</code> }] : []),
              ...(e.derivation_rule ? [{ label: t('journal.fields.derivation'), value: <code>{e.derivation_rule} v{e.derivation_version}</code> }] : []),
              ...(e.payload_hash ? [{ label: t('journal.fields.payloadHash'), value: <code className="mono">{e.payload_hash.slice(0, 16)}…</code> }] : []),
            ]}
          />
          <h3 className="drawer-subtitle">{t('journal.entities')}</h3>
          <div className="chip-row">
            {Object.entries(e.entity_refs).map(([type, id]) => (
              <Link key={type} className="citation-btn" to={`/app/entities/${type}/${encodeURIComponent(id)}`}>
                {t(`entityTypes.${type}`, { defaultValue: type })} · {id}
              </Link>
            ))}
            {!Object.keys(e.entity_refs).length && <span className="muted">{t('common.none')}</span>}
          </div>
          <h3 className="drawer-subtitle">{t('journal.payload')}</h3>
          <pre className="config-code payload-code">{JSON.stringify(e.payload, null, 2)}</pre>
          <h3 className="drawer-subtitle">{t('journal.evidence')}</h3>
          {e.evidence_refs.length === 0 && <p className="muted">{t('journal.noEvidence')}</p>}
          {e.evidence_refs.map((id) => (
            <EvidenceBox key={id} evidenceId={id} />
          ))}
          <h3 className="drawer-subtitle">{t('journal.links')}</h3>
          <div className="link-list">
            {e.supersedes && (
              <button type="button" className="detail-link" onClick={() => onOpenEntry(e.supersedes!.entry_id)}>
                <span>{t('journal.supersedes')} <code className="mono">{entrySummary(e.supersedes)}</code></span>
                <Icon name="chevron" />
              </button>
            )}
            {e.superseded_by.map((s) => (
              <button key={s.entry_id} type="button" className="detail-link" onClick={() => onOpenEntry(s.entry_id)}>
                <span>{t('journal.supersededBy')} <code className="mono">{entrySummary(s)}</code></span>
                <Icon name="chevron" />
              </button>
            ))}
            {e.derived_from.map((s) => (
              <button key={s.entry_id} type="button" className="detail-link" onClick={() => onOpenEntry(s.entry_id)}>
                <span>{t('journal.inputEntry')} <code className="mono">{entrySummary(s)}</code></span>
                <Icon name="chevron" />
              </button>
            ))}
            {e.derivations.map((s) => (
              <button key={s.entry_id} type="button" className="detail-link" onClick={() => onOpenEntry(s.entry_id)}>
                <span>
                  {t('journal.derivedEntry')} <span className="type-tag" data-track={s.track}>{t(`tracks.${s.track}`)}</span> <code className="mono">{entrySummary(s)}</code>
                </span>
                <Icon name="chevron" />
              </button>
            ))}
            {!e.supersedes && !e.superseded_by.length && !e.derived_from.length && !e.derivations.length && <p className="muted">{t('common.none')}</p>}
          </div>
          <p className="demo-callout">{t('journal.appendOnlyNote')}</p>
        </>
      )}
    </Drawer>
  );
}

/** One raw evidence object (GET /api/evidence/:id): status, metadata and the inline excerpt when the policy allows it. */
export function EvidenceBox({ evidenceId }: { evidenceId: string }) {
  const { t } = useTranslation();
  const f = useFormat();
  const ev = useAsync(() => journalApi.evidence(evidenceId), [evidenceId]);
  const d = ev.data;
  const meta = d?.evidence;
  const content = d?.content === undefined || d.content === null ? null : typeof d.content === 'string' ? d.content : JSON.stringify(d.content, null, 2);
  return (
    <div className="evidence-box">
      <h3>
        {t('journal.originalExcerpt')} · <code className="mono">{evidenceId}</code> {d && <StatusBadge kind={d.status} label={t(`evidenceStatus.${d.status}`, { defaultValue: d.status })} />}
      </h3>
      {ev.loading && !d && <Loading />}
      <ErrorNote error={ev.error} onRetry={ev.reload} />
      {d && d.status === 'available' && (
        <>
          {content ? <blockquote>{content.length > 4000 ? `${content.slice(0, 4000)}…` : content}</blockquote> : <p className="micro">{t('journal.binaryEvidence')}</p>}
          <p className="micro">
            {meta?.kind ?? ''} · {meta?.media_type ?? ''} · {f.dateTimeSeconds(meta?.received_at)} · {f.bytes(meta?.byte_size ?? null)}
            {meta?.evidence_class ? ` · ${t(`evidenceClasses.${meta.evidence_class}`, { defaultValue: meta.evidence_class })}` : ''}
          </p>
        </>
      )}
      {d && d.status !== 'available' && <p className="micro">{t(`evidenceReason.${d.reason ?? 'unknown'}`, { defaultValue: d.reason ?? t('common.unknown') })}</p>}
    </div>
  );
}
