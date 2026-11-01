import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeading } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { Drawer, EmptyState, ErrorNote, Loading, StatusBadge } from '../components/ui';
import { EntryDrawer, EvidenceBox, entrySummary } from '../components/EntryDrawer';
import { ReadinessSummary } from '../components/ReadinessSummary';
import { journalRefId } from '../api/adapters';
import { journal as journalApi, questions as questionsApi } from '../api/endpoints';
import type { ParamSchemaProperty, QuestionResult, QuestionTemplate, SearchResult } from '../api/types';

/** Which parameters name an entity (offers the literal journal search as disambiguation). Presentation only. */
const ENTITY_PARAMS: Record<string, string> = { item_id: 'item', order_id: 'order', customer_id: 'customer', invoice_id: 'invoice', shipment_id: 'shipment', transaction_id: 'transaction', payout_id: 'payout', refund_id: 'refund', return_id: 'return', reservation_id: 'reservation', supply_id: 'supplier_order', location_id: 'location', bank_entry_id: 'bank_entry', dispute_id: 'dispute', hold_id: 'hold', case_id: 'case', promise_id: 'promise', entitlement_id: 'entitlement', account_ref: 'provider_account' };
/** Headline field per intent (the API result field that answers the question; no computation). */
const HEADLINE: Record<string, { field: string; kind: 'quantity' | 'money' | 'count' | 'text' | 'boolean' }> = {
  'inventory.available_to_sell': { field: 'available', kind: 'quantity' },
};
import { useAsync } from '../hooks';
import { useFormat } from '../format';

const GROUPS = ['order', 'delivery', 'invoice', 'collection', 'settlement', 'reversal'] as const;
const GROUP_ICON: Record<string, string> = { order: 'box', delivery: 'truck', invoice: 'list', collection: 'check', settlement: 'arrow', reversal: 'refresh' };

export function QuestionsView() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const templates = useAsync(() => questionsApi.list(), []);
  const selectedId = params.get('q');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState<unknown>(null);

  useEffect(() => {
    document.title = `${t('nav.questions')} — ${t('meta.title')}`;
  }, [t]);

  const selected = templates.data?.find((q) => q.id === selectedId) ?? null;
  const runSearch = async (e: FormEvent) => {
    e.preventDefault();
    setSearchError(null);
    if (!search.trim()) {
      setSearchResult(null);
      return;
    }
    try {
      setSearchResult(await questionsApi.search(search.trim()));
    } catch (err) {
      setSearchError(err);
    }
  };

  return (
    <>
      <PageHeading title={t('questions.title')} subtitle={t('questions.subtitle')} actions={<span className="btn secondary static"><Icon name="spark" /> {t('questions.count24')}</span>} />
      <div className="answers-page wide">
        <section className="ask-panel" aria-labelledby="search-title">
          <div className="panel-head">
            <span id="search-title">
              <Icon name="search" /> {t('questions.searchTitle')}
            </span>
            <small>{t('questions.searchKind')}</small>
          </div>
          <p>{t('questions.searchIntro')}</p>
          <form className="question-form" onSubmit={(e) => void runSearch(e)} role="search" aria-label={t('questions.searchTitle')}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('questions.searchPlaceholder')} aria-label={t('questions.searchLabel')} />
            <button type="submit" aria-label={t('questions.searchSubmit')}>
              <Icon name="arrow" />
            </button>
          </form>
          <ErrorNote error={searchError} />
          {searchResult && (
            <div className="question-suggestions">
              {searchResult.templates.map((m) => (
                <button key={m.id} type="button" onClick={() => setParams({ q: m.id })}>
                  {t(`questionsCatalog.${m.id}.q`)}
                </button>
              ))}
              {searchResult.entities.map((e) => (
                <Link key={`${e.type}:${e.id}`} className="citation-btn" to={`/app/entities/${e.type}/${encodeURIComponent(e.id)}`}>
                  {t(`entityTypes.${e.type}`, { defaultValue: e.type })} · {e.label}
                </Link>
              ))}
              {!searchResult.templates.length && !searchResult.entities.length && <span className="muted">{t('questions.searchEmpty')}</span>}
            </div>
          )}
          <div className="ask-foot">
            <Icon name="shield" /> {t('questions.noModelNote')}
          </div>
        </section>

        <div className="otc-filterbar">
          <div className="otc-filters" role="group" aria-label={t('questions.groupFilter')}>
            <button type="button" aria-pressed={groupFilter === 'all'} onClick={() => setGroupFilter('all')}>
              {t('questions.allGroups')}
            </button>
            {GROUPS.map((g) => (
              <button key={g} type="button" aria-pressed={groupFilter === g} onClick={() => setGroupFilter(g)}>
                {t(`questionsCatalog.groups.${g}.number`)} {t(`questionsCatalog.groups.${g}.label`)}
              </button>
            ))}
          </div>
          <span className="otc-count">{t('questions.count24')}</span>
        </div>
        {templates.loading && !templates.data && <Loading />}
        <ErrorNote error={templates.error} onRetry={templates.reload} />
        <div className="otc-grid">
          {GROUPS.filter((g) => groupFilter === 'all' || groupFilter === g).map((g) => (
            <article className="otc-card" key={g} aria-labelledby={`group-${g}`}>
              <div className="otc-card-top">
                <span className="otc-step">{t(`questionsCatalog.groups.${g}.number`)}</span>
                <span className="otc-team">{t(`questionsCatalog.groups.${g}.team`)}</span>
                <Icon name={GROUP_ICON[g]} />
              </div>
              <h3 id={`group-${g}`}>{t(`questionsCatalog.groups.${g}.title`)}</h3>
              <p className="otc-scope">{t(`questionsCatalog.groups.${g}.scope`)}</p>
              <div className="otc-benefit">
                <span>{t('questions.agentRole')} · {t(`questionsCatalog.groups.${g}.agent`)}</span>
                <p>{t(`questionsCatalog.groups.${g}.benefit`)}</p>
              </div>
              <div className="otc-questions">
                {(templates.data ?? []).filter((q) => q.group === g).map((q) => (
                  <div className="otc-question" key={q.id}>
                    <button type="button" className="otc-question-button" aria-expanded={selectedId === q.id} onClick={() => setParams(selectedId === q.id ? {} : { q: q.id })}>
                      <span>{t(`questionsCatalog.${q.id}.q`)}</span>
                      <StatusBadge kind={q.readiness.status} label={t(`readinessState.${q.readiness.status}`)} />
                      <Icon name="plus" />
                    </button>
                    {selectedId === q.id && (
                      <div className="otc-question-body">
                        <dl>
                          <div>
                            <dt>{t('questions.method')}</dt>
                            <dd>{t(`questionsCatalog.${q.id}.method`)}</dd>
                          </div>
                          <div>
                            <dt>{t('questions.need')}</dt>
                            <dd>{t(`questionsCatalog.${q.id}.need`)}</dd>
                          </div>
                          <div>
                            <dt>{t('questions.result')}</dt>
                            <dd>{t(`questionsCatalog.${q.id}.result`)}</dd>
                          </div>
                        </dl>
                        {q.readiness.missing.length > 0 && (
                          <p className="otc-data-note">
                            {t('questions.missingDatasets')}: {q.readiness.missing.map((d) => t(`datasets.${d}`, { defaultValue: d })).join(', ')}
                          </p>
                        )}
                        <AskForm template={q} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="otc-evidence">
                <div>
                  {(t(`questionsCatalog.groups.${g}.tracks`, { returnObjects: true }) as string[]).map((tr) => (
                    <span key={tr} data-track={tr}>
                      {t(`tracks.${tr}`)}
                    </span>
                  ))}
                </div>
                <p>
                  <Icon name="plug" /> {t(`questionsCatalog.groups.${g}.sources`)}
                </p>
              </div>
            </article>
          ))}
        </div>
        {selected && null}
      </div>
    </>
  );
}

/** Typed parameter form built from params_schema; entity parameters offer explicit disambiguation via /api/search. */
function AskForm({ template }: { template: QuestionTemplate }) {
  const { t } = useTranslation();
  const props = template.params_schema.properties;
  const required = new Set(template.params_schema.required ?? []);
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => Object.fromEntries(Object.entries(props).map(([k, p]) => [k, (p.default as string | number | boolean | undefined) ?? (p.type === 'boolean' ? false : '')])));
  const [result, setResult] = useState<QuestionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [consistencyMode, setConsistencyMode] = useState<'latest_committed' | 'at_least_cursor'>('latest_committed');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldError(null);
    for (const k of required) {
      if (values[k] === '' || values[k] === undefined) {
        setFieldError(t('questions.requiredParam', { param: t(`params.${k}`, { defaultValue: k }) }));
        return;
      }
    }
    const params: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(props)) {
      const v = values[k];
      if (v === '' || v === undefined || v === false) continue;
      params[k] = p.type === 'integer' || p.type === 'number' ? Number(v) : p.type === 'array' ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : v;
    }
    setBusy(true);
    try {
      setResult(await questionsApi.ask(template.intent, params, { mode: consistencyMode }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ask-form" onSubmit={(e) => void submit(e)} noValidate aria-label={t('questions.formLabel', { question: t(`questionsCatalog.${template.id}.q`) })}>
      <div className="param-grid">
        {Object.entries(props).map(([key, p]) => (
          <ParamField key={key} name={key} schema={p} required={required.has(key)} value={values[key]} onChange={(v) => setValues((s) => ({ ...s, [key]: v }))} templateId={template.id} />
        ))}
        <label className="filter-field">
          <span>{t('questions.consistency')}</span>
          <select value={consistencyMode} onChange={(e) => setConsistencyMode(e.target.value as typeof consistencyMode)}>
            <option value="latest_committed">{t('questions.latestCommitted')}</option>
            <option value="at_least_cursor">{t('questions.atLeastCursor')}</option>
          </select>
        </label>
      </div>
      {fieldError && (
        <p className="form-error" role="alert">
          {fieldError}
        </p>
      )}
      <ErrorNote error={error} />
      <button type="submit" className="btn primary" disabled={busy || !template.supported}>
        <Icon name="spark" /> {busy ? t('common.working') : t('questions.ask')}
      </button>
      <span className="micro"> {t('questions.intent')}: <code>{template.intent}</code></span>
      {result && <AnswerPanel result={result} templateId={template.id} />}
    </form>
  );
}

function ParamField({ name, schema, required, value, onChange, templateId }: { name: string; schema: ParamSchemaProperty; required: boolean; value: string | number | boolean | undefined; onChange: (v: string | number | boolean) => void; templateId: string }) {
  const { t } = useTranslation();
  const id = `${templateId}-${name}`;
  const label = `${t(`params.${name}`, { defaultValue: name })}${required ? ' *' : ''}`;
  const [candidates, setCandidates] = useState<SearchResult['entities'] | null>(null);
  const [lookupError, setLookupError] = useState<unknown>(null);
  const entityType = ENTITY_PARAMS[name];
  if (entityType) {
    // Literal search over record ids / entity refs (GET /api/search); candidates are the distinct entity ids of the matching entries.
    const lookup = async () => {
      setLookupError(null);
      try {
        const r = await journalApi.search(String(value ?? ''));
        const seen = new Map<string, SearchResult['entities'][number]>();
        for (const e of r.entries) {
          const id = e.entity_refs[entityType] ?? (e.record_id.startsWith(`${entityType}:`) ? e.record_id.slice(entityType.length + 1) : null);
          if (!id || seen.has(id)) continue;
          const name = typeof e.payload.title === 'string' ? e.payload.title : typeof e.payload.name === 'string' ? e.payload.name : typeof e.payload.sku === 'string' ? e.payload.sku : null;
          seen.set(id, { type: entityType, id, label: name && name !== id ? `${name} (${id})` : id, secondary: e.event_type });
        }
        setCandidates(Array.from(seen.values()));
      } catch (e) {
        setLookupError(e);
      }
    };
    return (
      <div className="filter-field entity-field">
        <label htmlFor={id}>{label}</label>
        <div className="key-input-row">
          <input id={id} className="field" value={String(value ?? '')} onChange={(e) => { onChange(e.target.value); setCandidates(null); }} placeholder={t(`entityPlaceholder.${entityType}`, { defaultValue: '' })} aria-describedby={`${id}-hint`} />
          <button type="button" className="btn small secondary" onClick={() => void lookup()}>
            <Icon name="search" /> {t('questions.lookup')}
          </button>
        </div>
        <small id={`${id}-hint`} className="muted">
          {t('questions.entityHint', { type: t(`entityTypes.${entityType}`, { defaultValue: entityType }) })}
        </small>
        <ErrorNote error={lookupError} />
        {candidates && (
          <div className="question-suggestions" role="listbox" aria-label={t('questions.candidates')}>
            {candidates.length === 0 && <span className="muted">{t('questions.noCandidates')}</span>}
            {candidates.map((c) => (
              <button key={c.id} type="button" role="option" aria-selected={value === c.id} onClick={() => { onChange(c.id); setCandidates(null); }}>
                {c.label} <small>{c.secondary ? `· ${c.secondary}` : ''}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (schema.type === 'boolean') {
    return (
      <label className="checkbox-row">
        <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
    );
  }
  if (schema.enum) {
    return (
      <label className="filter-field">
        <span>{label}</span>
        <select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {schema.enum.map((o) => (
            <option key={o} value={o}>
              {t(`paramOptions.${o}`, { defaultValue: o })}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="filter-field">
      <span>{label}</span>
      <input id={id} className="field" type={schema.format === 'date' ? 'date' : schema.format === 'date-time' ? 'datetime-local' : schema.type === 'integer' || schema.type === 'number' ? 'number' : 'text'} min={schema.minimum} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function AnswerPanel({ result, templateId }: { result: QuestionResult; templateId: string }) {
  const { t } = useTranslation();
  const f = useFormat();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [openEntry, setOpenEntry] = useState<string | null>(null);
  const res = result.result ?? {};
  const unit = typeof res.unit === 'string' ? res.unit : undefined;
  const currency = typeof res.currency === 'string' ? res.currency : undefined;
  const fmt = (key: string, v: unknown): string => {
    if (v === null || v === undefined) return t('common.unknown');
    if (typeof v === 'boolean') return v ? t('common.yes') : t('common.no');
    if (key.endsWith('_minor') && (typeof v === 'number' || typeof v === 'string')) return f.money(v, currency);
    if (/_at$|^basis_at$|_date$/.test(key) && typeof v === 'string') return f.dateTimeSeconds(v);
    if (typeof v === 'number') return f.number(v);
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && unit && !key.endsWith('_id')) return f.quantity(v, unit);
    if (typeof v === 'string') return t(`values.${v}`, { defaultValue: v });
    return JSON.stringify(v);
  };
  const headline = useMemo(() => {
    const h = HEADLINE[result.intent];
    if (!h) return null;
    const v = res[h.field];
    if (v === null || v === undefined) return null;
    return fmt(h.field, v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, f, t]);
  const scalarFields = Object.entries(res).filter(([, v]) => v === null || typeof v !== 'object');
  const tables = Object.entries(res).filter(([, v]) => Array.isArray(v)) as Array<[string, unknown[]]>;
  const evidenceEntries = result.evidence_refs.map(journalRefId).filter((x): x is string => Boolean(x));
  const unknown = result.status === 'unknown' || result.status === 'insufficient_data';
  const readinessBlock = { datasets_present: result.coverage?.datasets_present ?? [], datasets_missing: result.coverage?.datasets_missing ?? [], sources: result.readiness?.sources ?? [] };

  return (
    <section className="answer-output" aria-live="polite" aria-label={t('answer.title')}>
      <div className="eyebrow">
        <Icon name="spark" /> {t('answer.eyebrow')} · <StatusBadge kind={result.status} label={t(`answerStatus.${result.status}`, { defaultValue: result.status })} />
        {result.readiness && <> · <StatusBadge kind={result.readiness.status} label={`${t('readiness.title')}: ${t(`readinessState.${result.readiness.status}`)}`} /></>}
      </div>
      <h3>{unknown ? t('answer.unknownHeadline') : result.status === 'conflict' ? t('answer.conflictHeadline') : result.status === 'unsupported' ? t('answer.unsupportedHeadline') : headline ?? t(`questionsCatalog.${templateId}.q`)}</h3>
      {headline && !unknown && result.intent === 'inventory.available_to_sell' && (
        <p>{t(res.can_fulfill === true ? 'answerSummaries.can_fulfill_yes' : res.can_fulfill === false ? 'answerSummaries.can_fulfill_no' : 'answerSummaries.available_to_sell', { available: headline, requested: fmt('requested_quantity', res.requested_quantity), shortfall: fmt('shortfall', res.shortfall) })}</p>
      )}
      {Object.entries(result.params ?? {}).filter(([k]) => ENTITY_PARAMS[k]).map(([k, v]) => (
        <p className="micro" key={k}>
          {t('answer.entity')}: <Link to={`/app/entities/${ENTITY_PARAMS[k]}/${encodeURIComponent(String(v))}`}>{t(`entityTypes.${ENTITY_PARAMS[k]}`, { defaultValue: ENTITY_PARAMS[k] })} {String(v)}</Link>
        </p>
      ))}
      {result.calculation.length > 0 && (
        <div className="math-steps" aria-label={t('answer.calculation')}>
          {result.calculation.map((s, i) => (
            <div key={i} className="math-item">
              <strong>{t(`calcLabels.${s.step}`, { defaultValue: s.step })}</strong>
              <code className="mono formula">{s.formula}</code>
              <small>
                {Object.entries(s.values ?? {}).map(([k, v]) => (
                  <span key={k} className="math-value">
                    {t(`calcLabels.${k}`, { defaultValue: k })} = <b>{fmt(k, v)}</b>
                  </span>
                ))}
              </small>
            </div>
          ))}
        </div>
      )}
      {scalarFields.length > 0 && (
        <dl className="detail-meta answer-fields">
          {scalarFields.map(([k, v]) => (
            <div key={k}>
              <dt>{t(`fields.${k}`, { defaultValue: k })}</dt>
              <dd>{fmt(k, v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {tables.map(([key, rows]) => (
        <div className="ledger-table-wrap" key={key}>
          <h4 className="drawer-subtitle">{t(`fields.${key}`, { defaultValue: key })}</h4>
          {rows.length === 0 ? (
            <p className="muted">{result.status === 'complete' ? t('answer.emptyWithCoverage') : t('common.none')}</p>
          ) : (
            <table className="ledger-table small">
              <thead>
                <tr>
                  {Object.keys((rows[0] as Record<string, unknown>) ?? {}).map((c) => (
                    <th key={c}>{t(`columns.${c}`, { defaultValue: c })}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {Object.entries((row as Record<string, unknown>) ?? {}).map(([c, v]) => (
                      <td key={c}>{typeof v === 'object' && v !== null ? JSON.stringify(v) : fmt(c, v)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      {result.page?.truncated && <p className="micro">{t('answer.truncated')}</p>}
      {(result.warnings ?? []).map((w) => (
        <div className="answer-warning" key={w}>
          {t(`answerWarnings.${w}`, { defaultValue: w })}
        </div>
      ))}
      {(result.readiness?.reasons ?? []).map((r) => (
        <p className="micro" key={r}>
          {r}
        </p>
      ))}
      {result.missing_inputs.length > 0 && (
        <div className="answer-warning">
          <strong>{t('answer.missingInputs')}:</strong> {result.missing_inputs.map((m) => t(`missingInputs.${m}`, { defaultValue: m })).join(', ')}
          <br />
          <Link to="/app/sources">{t('answer.connectMissing')} →</Link>
        </div>
      )}
      {unknown && result.missing_inputs.length === 0 && (
        <div className="answer-warning">
          <strong>{t('answer.missingInputs')}:</strong> {result.calculation.map((c) => c.formula).join('; ') || t('answer.noBasis')}
        </div>
      )}
      {result.conflicts.map((c, i) => (
        <div className="answer-warning" key={i}>
          <strong>{t('answer.conflict')}{typeof c.code === 'string' ? ` (${c.code})` : ''}:</strong> {typeof c.description === 'string' ? c.description : JSON.stringify(c)}{' '}
          {(Array.isArray(c.entry_ids) ? (c.entry_ids as string[]) : []).map((id) => (
            <button key={id} type="button" className="citation-btn" onClick={() => setOpenEntry(id)}>
              {id.slice(0, 8)}
            </button>
          ))}
        </div>
      ))}
      <div className="chip-row">
        {evidenceEntries.slice(0, 12).map((id) => (
          <button key={id} type="button" className="citation-btn" onClick={() => setOpenEntry(id)}>
            [{id.slice(0, 8)}] <Icon name="chevron" />
          </button>
        ))}
        {evidenceEntries.length > 12 && <span className="muted">+{evidenceEntries.length - 12}</span>}
        {evidenceEntries.length > 0 && (
          <button type="button" className="btn small secondary" onClick={() => setEvidenceOpen(true)}>
            <Icon name="list" /> {t('answer.openEvidence', { count: evidenceEntries.length })}
          </button>
        )}
      </div>
      <p className="proof-line">
        <Icon name="clock" /> {t('answer.cutoffs', { effective: f.dateTimeSeconds(result.consistency?.effective_cutoff ?? null), recorded: f.dateTimeSeconds(result.consistency?.recorded_cutoff ?? null), applied: result.consistency?.applied_cursor ?? '–', count: evidenceEntries.length })}
      </p>
      {result.coverage && (
        <p className="micro">
          {t('answer.populationLine', { considered: result.coverage.population?.records_considered ?? '–', returned: result.coverage.population?.returned ?? '–' })}
          {result.coverage.evidence_truncated ? ` · ${t('answer.truncated')}` : ''}
          {result.coverage.incoming_supply_known === false ? ` · ${t('answerWarnings.incoming_supply_not_counted')}` : ''}
        </p>
      )}
      <ReadinessSummary readiness={readinessBlock} consistency={result.consistency} compact />
      {evidenceOpen && (
        <Drawer title={t('answer.evidenceDrawerTitle')} eyebrow={<><Icon name="shield" /> {t('answer.evidenceEyebrow')}</>} onClose={() => setEvidenceOpen(false)}>
          <p>{t('answer.evidenceIntro', { count: evidenceEntries.length })}</p>
          {evidenceEntries.map((id) => (
            <EvidenceEntry key={id} entryId={id} onOpen={() => { setEvidenceOpen(false); setOpenEntry(id); }} />
          ))}
        </Drawer>
      )}
      {openEntry && <EntryDrawer entryId={openEntry} onClose={() => setOpenEntry(null)} onOpenEntry={setOpenEntry} />}
    </section>
  );
}

/** One cited journal entry inside the evidence drawer: track, record, event and its raw evidence objects. */
function EvidenceEntry({ entryId, onOpen }: { entryId: string; onOpen: () => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const entry = useAsync(() => journalApi.entry(entryId), [entryId]);
  const e = entry.data;
  return (
    <div className="evidence-entry">
      <button type="button" className="detail-link" onClick={onOpen}>
        <span>
          {e ? (
            <>
              <span className="type-tag" data-track={e.track}>
                {t(`tracks.${e.track}`)}
              </span>{' '}
              <code className="mono">{entrySummary(e)}</code> · {f.dateTimeSeconds(e.occurred_at)}
            </>
          ) : (
            <code className="mono">{entryId}</code>
          )}
        </span>
        <Icon name="chevron" />
      </button>
      {e?.evidence_refs.map((id) => (
        <EvidenceBox key={id} evidenceId={id} />
      ))}
      {e && e.evidence_refs.length === 0 && <p className="micro">{t('journal.noEvidence')}</p>}
    </div>
  );
}

export function EmptyQuestions() {
  const { t } = useTranslation();
  return <EmptyState>{t('questions.empty')}</EmptyState>;
}
