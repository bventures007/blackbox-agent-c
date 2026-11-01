import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeading } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { Drawer, EmptyState, ErrorNote, Loading, StatusBadge } from '../components/ui';
import { EntryDrawer, EvidenceBox } from '../components/EntryDrawer';
import { ReadinessSummary } from '../components/ReadinessSummary';
import { journal as journalApi, questions as questionsApi } from '../api/endpoints';
import type { EvidenceRef, ParamSchemaProperty, QuestionResult, QuestionTemplate, SearchResult } from '../api/types';
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
      if (v === '' || v === undefined) continue;
      params[k] = p.type === 'integer' || p.type === 'number' ? Number(v) : v;
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
  if (schema['x-entity']) {
    const lookup = async () => {
      setLookupError(null);
      try {
        const r = await journalApi.search(String(value ?? ''));
        setCandidates(r.entities.filter((e) => e.type === schema['x-entity']));
      } catch (e) {
        setLookupError(e);
      }
    };
    return (
      <div className="filter-field entity-field">
        <label htmlFor={id}>{label}</label>
        <div className="key-input-row">
          <input id={id} className="field" value={String(value ?? '')} onChange={(e) => { onChange(e.target.value); setCandidates(null); }} placeholder={t(`entityPlaceholder.${schema['x-entity']}`)} aria-describedby={`${id}-hint`} />
          <button type="button" className="btn small secondary" onClick={() => void lookup()}>
            <Icon name="search" /> {t('questions.lookup')}
          </button>
        </div>
        <small id={`${id}-hint`} className="muted">
          {t('questions.entityHint', { type: t(`entityTypes.${schema['x-entity']}`) })}
        </small>
        <ErrorNote error={lookupError} />
        {candidates && (
          <div className="question-suggestions" role="listbox" aria-label={t('questions.candidates')}>
            {candidates.length === 0 && <span className="muted">{t('questions.noCandidates')}</span>}
            {candidates.map((c) => (
              <button key={c.id} type="button" role="option" aria-selected={value === c.id} onClick={() => { onChange(c.id); setCandidates(null); }}>
                {c.label} <small>({c.id}{c.secondary ? ` · ${c.secondary}` : ''})</small>
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
  const headline = useMemo(() => {
    if (!result.headline) return null;
    const h = result.headline;
    if (h.kind === 'money') return f.money(h.value as number, h.currency);
    if (h.kind === 'quantity') return f.quantity(h.value, h.unit);
    if (h.kind === 'count') return f.number(h.value as number);
    return String(h.value ?? t('common.unknown'));
  }, [result, f, t]);
  const summary = result.summary_key ? t(`answerSummaries.${result.summary_key}`, { ...(result.summary_params ?? {}), defaultValue: '' }) : '';

  return (
    <section className="answer-output" aria-live="polite" aria-label={t('answer.title')}>
      <div className="eyebrow">
        <Icon name="spark" /> {t('answer.eyebrow')} · <StatusBadge kind={result.status} label={t(`answerStatus.${result.status}`)} />
      </div>
      <h3>{result.status === 'insufficient_data' ? t('answer.unknownHeadline') : result.status === 'conflict' ? t('answer.conflictHeadline') : headline ?? t(`questionsCatalog.${templateId}.q`)}</h3>
      {summary && <p>{summary}</p>}
      {result.scope.entity && (
        <p className="micro">
          {t('answer.entity')}: <Link to={`/app/entities/${result.scope.entity.type}/${encodeURIComponent(result.scope.entity.id)}`}>{result.scope.entity.label}</Link>
        </p>
      )}
      {result.calculation.steps.length > 0 && (
        <div className="math-row" aria-label={t('answer.calculation')}>
          {result.calculation.steps.map((s, i) => (
            <span key={i} className="math-pair">
              <span className="math-item">
                <strong>{s.currency ? f.money(s.value as number, s.currency) : s.unit ? f.quantity(s.value, s.unit) : String(s.value ?? '–')}</strong>
                <small>{t(`calcLabels.${s.label_key}`, { defaultValue: s.label })}</small>
              </span>
              {s.operator && <span className="math-op" aria-label={t(`operators.${s.operator}`, { defaultValue: s.operator })}>{s.operator}</span>}
            </span>
          ))}
        </div>
      )}
      <p className="micro">
        {t('answer.rule')}: <code>{result.calculation.rule} v{result.calculation.version}</code>
      </p>
      {result.result && result.result.rows.length > 0 && (
        <div className="ledger-table-wrap">
          <table className="ledger-table small">
            <thead>
              <tr>
                {(result.result.columns ?? result.result.rows[0].cells.map((c) => c.key)).map((c) => (
                  <th key={c}>{t(`columns.${c}`, { defaultValue: c })}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.result.rows.map((row) => (
                <tr key={row.id}>
                  {row.cells.map((c) => (
                    <td key={c.key}>
                      {c.kind === 'money' ? f.money(c.value as number, c.currency) : c.kind === 'quantity' ? f.quantity(c.value, c.unit) : c.kind === 'date' ? f.date(String(c.value)) : c.kind === 'status' ? <StatusBadge kind={String(c.value)} label={t(`values.${c.value}`, { defaultValue: String(c.value) })} /> : t(`values.${c.value}`, { defaultValue: String(c.value ?? '–') })}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {result.result.truncated && <p className="micro">{t('answer.truncated')}</p>}
        </div>
      )}
      {result.result && result.result.rows.length === 0 && result.status === 'complete' && <p className="muted">{t('answer.emptyWithCoverage')}</p>}
      {result.warnings.map((w) => (
        <div className="answer-warning" key={w}>
          {t(`answerWarnings.${w}`, { defaultValue: w })}
        </div>
      ))}
      {result.missing_inputs.length > 0 && (
        <div className="answer-warning">
          <strong>{t('answer.missingInputs')}:</strong> {result.missing_inputs.map((m) => t(`missingInputs.${m}`, { defaultValue: m })).join(', ')}
          <br />
          <Link to="/app/sources">{t('answer.connectMissing')} →</Link>
        </div>
      )}
      {result.conflicts.map((c) => (
        <div className="answer-warning" key={c.code}>
          <strong>{t('answer.conflict')} ({c.code}):</strong> {c.description}{' '}
          {c.entry_ids.map((id) => (
            <button key={id} type="button" className="citation-btn" onClick={() => setOpenEntry(id)}>
              {id.slice(-6)}
            </button>
          ))}
        </div>
      ))}
      <div className="chip-row">
        {result.evidence.map((ev: EvidenceRef) => (
          <button key={ev.entry_id} type="button" className="citation-btn" onClick={() => setOpenEntry(ev.entry_id)}>
            [{ev.record_id}] <Icon name="chevron" />
          </button>
        ))}
        {result.evidence.length > 0 && (
          <button type="button" className="btn small secondary" onClick={() => setEvidenceOpen(true)}>
            <Icon name="list" /> {t('answer.openEvidence', { count: result.evidence.length })}
          </button>
        )}
      </div>
      <p className="proof-line">
        <Icon name="clock" /> {t('answer.cutoffs', { effective: f.dateTimeSeconds(result.effective_at), recorded: f.dateTimeSeconds(result.recorded_cutoff), applied: result.consistency.applied_cursor ?? '–', count: result.evidence.length })}
      </p>
      {result.coverage.length > 0 && (
        <table className="mini-table">
          <thead>
            <tr>
              <th>{t('connection.capability')}</th>
              <th>{t('answer.population')}</th>
              <th>{t('connection.coverageInterval')}</th>
              <th>{t('connection.completeness')}</th>
            </tr>
          </thead>
          <tbody>
            {result.coverage.map((c, i) => (
              <tr key={i}>
                <td>{t(`capabilities.${c.capability_id}`, { defaultValue: c.capability_id })}</td>
                <td>{c.population}</td>
                <td>{c.interval_from ? `${f.dateTime(c.interval_from)} – ${f.dateTime(c.interval_to)}` : t('common.unknown')}</td>
                <td>
                  <StatusBadge kind={c.completeness === 'complete_for_declared_scope' ? 'complete' : c.completeness} label={t(`completeness.${c.completeness}`, { defaultValue: c.completeness })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ReadinessSummary readiness={result.readiness} consistency={result.consistency} compact />
      {evidenceOpen && (
        <Drawer title={t('answer.evidenceDrawerTitle')} eyebrow={<><Icon name="shield" /> {t('answer.evidenceEyebrow')}</>} onClose={() => setEvidenceOpen(false)}>
          <p>{t('answer.evidenceIntro', { count: result.evidence.length })}</p>
          {result.evidence.map((ev) => (
            <EvidenceEntry key={ev.entry_id} ev={ev} onOpen={() => { setEvidenceOpen(false); setOpenEntry(ev.entry_id); }} />
          ))}
        </Drawer>
      )}
      {openEntry && <EntryDrawer entryId={openEntry} onClose={() => setOpenEntry(null)} onOpenEntry={setOpenEntry} />}
    </section>
  );
}

function EvidenceEntry({ ev, onOpen }: { ev: EvidenceRef; onOpen: () => void }) {
  const { t } = useTranslation();
  const meta = useAsync(() => journalApi.evidence(ev.evidence_id), [ev.evidence_id]);
  return (
    <div className="evidence-entry">
      <button type="button" className="detail-link" onClick={onOpen}>
        <span>
          <span className="type-tag" data-track={ev.track}>
            {t(`tracks.${ev.track}`)}
          </span>{' '}
          <code className="mono">{ev.record_id}</code> · {ev.label}
        </span>
        <Icon name="chevron" />
      </button>
      {meta.data && meta.data.evidence_id && <EvidenceBox evidence={meta.data} />}
      {meta.data && !meta.data.evidence_id && <p className="micro">{t('evidenceStatus.unavailable')}</p>}
    </div>
  );
}

export function EmptyQuestions() {
  const { t } = useTranslation();
  return <EmptyState>{t('questions.empty')}</EmptyState>;
}
