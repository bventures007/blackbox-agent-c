import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { journal as journalApi } from '../api/endpoints';
import type { EvidenceMeta, JournalEntryDetail } from '../api/types';
import { useAsync } from '../hooks';
import { useFormat } from '../format';
import { DefinitionList, Drawer, ErrorNote, Loading, StatusBadge } from './ui';
import { Icon } from './Icon';

/** Journal entry drawer: payload, evidence (original excerpt), links to supersedes/superseded/derived entries and entities. */
export function EntryDrawer({ entryId, onClose, onOpenEntry }: { entryId: string; onClose: () => void; onOpenEntry: (id: string) => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const entry = useAsync(() => journalApi.entry(entryId), [entryId]);
  const e = entry.data;
  return (
    <Drawer onClose={onClose} eyebrow={<><Icon name="wave" /> {t('journal.entryEyebrow')}</>} title={e ? e.summary ?? e.record_id : t('common.loading')}>
      {entry.loading && <Loading />}
      <ErrorNote error={entry.error} onRetry={entry.reload} />
      {e && (
        <>
          <p>
            <span className="type-tag" data-track={e.track}>
              {t(`tracks.${e.track}`)}
            </span>{' '}
            <code className="mono">{e.event_type}</code>
            {e.history_kind && <> · <StatusBadge kind={e.history_kind} tone="neutral" label={t(`journal.historyKind.${e.history_kind}`)} /></>}
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
              ...(e.derivation_rule ? [{ label: t('journal.fields.derivation'), value: <code>{e.derivation_rule} v{e.derivation_version}</code> }] : []),
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
          {e.evidence.length === 0 && <p className="muted">{t('journal.noEvidence')}</p>}
          {e.evidence.map((ev) => (
            <EvidenceBox key={ev.evidence_id} evidence={ev} />
          ))}
          <h3 className="drawer-subtitle">{t('journal.links')}</h3>
          <div className="link-list">
            {e.supersedes_entry_id && (
              <button type="button" className="detail-link" onClick={() => onOpenEntry(e.supersedes_entry_id as string)}>
                <span>{t('journal.supersedes')}</span>
                <Icon name="chevron" />
              </button>
            )}
            {e.superseded_by_entry_id && (
              <button type="button" className="detail-link" onClick={() => onOpenEntry(e.superseded_by_entry_id as string)}>
                <span>{t('journal.supersededBy')}</span>
                <Icon name="chevron" />
              </button>
            )}
            {e.input_entry_ids.map((id) => (
              <button key={id} type="button" className="detail-link" onClick={() => onOpenEntry(id)}>
                <span>{t('journal.inputEntry')} <code className="mono">{id.slice(-6)}</code></span>
                <Icon name="chevron" />
              </button>
            ))}
            {e.derived_entry_ids.map((id) => (
              <button key={id} type="button" className="detail-link" onClick={() => onOpenEntry(id)}>
                <span>{t('journal.derivedEntry')} <code className="mono">{id.slice(-6)}</code></span>
                <Icon name="chevron" />
              </button>
            ))}
            {!e.supersedes_entry_id && !e.superseded_by_entry_id && !e.input_entry_ids.length && !e.derived_entry_ids.length && <p className="muted">{t('common.none')}</p>}
          </div>
          <p className="demo-callout">{t('journal.appendOnlyNote')}</p>
        </>
      )}
    </Drawer>
  );
}

export function EvidenceBox({ evidence }: { evidence: EvidenceMeta }) {
  const { t } = useTranslation();
  const f = useFormat();
  const [content, setContent] = useState<string | null>(evidence.excerpt ?? null);
  const [error, setError] = useState<unknown>(null);
  const load = async () => {
    try {
      const r = await journalApi.evidence(evidence.evidence_id);
      setContent(r.content ?? r.excerpt ?? null);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="evidence-box">
      <h3>
        {t('journal.originalExcerpt')} · <code className="mono">{evidence.evidence_id}</code> <StatusBadge kind={evidence.status} label={t(`evidenceStatus.${evidence.status}`)} />
      </h3>
      {evidence.status === 'available' ? (
        <>
          {content ? <blockquote>{content}</blockquote> : <button type="button" className="btn small secondary" onClick={() => void load()}>{t('journal.loadEvidence')}</button>}
          <p className="micro">
            {evidence.provider ? t(`providers.${evidence.provider}.name`, { defaultValue: evidence.provider }) : ''} · {evidence.content_type} · {f.dateTimeSeconds(evidence.received_at)} · {f.bytes(evidence.size_bytes ?? null)}
          </p>
        </>
      ) : (
        <p className="micro">{t(`evidenceReason.${evidence.reason ?? 'unknown'}`, { defaultValue: evidence.reason ?? t('common.unknown') })}</p>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

export function EntryPreview({ entry }: { entry: JournalEntryDetail }) {
  return <pre className="config-code payload-code">{JSON.stringify(entry.payload, null, 2)}</pre>;
}
