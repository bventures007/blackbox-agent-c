// Static landing page. No backend, login or API is required. All download actions are driven by one
// release-manifest.json fetched at runtime from the same directory as index.html (relative URL).
import i18next from 'i18next';
import { DEFAULT_LOCALE, INTL_TAGS, isLocale, resources, type Locale } from '@blackbox/i18n';
import '@blackbox/ui/styles/prototype.css';
import './landing.css';

interface ReleaseManifest {
  schema_version?: number;
  status: 'released' | 'pending' | string;
  version: string | null;
  date: string | null;
  tested_commit: string | null;
  artifact_filename: string | null;
  platform: string | null;
  format: string | null;
  byte_size: number | null;
  sha256: string | null;
  download_url: string | null;
  guide_url: string | null;
  app_url?: string | null;
  prerequisites?: { container_runtime?: string | null; min_os?: string | null } | null;
  release_notes?: string | null;
}

type ReleaseState = { kind: 'loading' } | { kind: 'released'; manifest: ReleaseManifest } | { kind: 'pending'; manifest: ReleaseManifest } | { kind: 'invalid'; manifest: Partial<ReleaseManifest>; reason: string } | { kind: 'failed'; error: string };

const LOCALE_KEY = 'blackbox.locale';
const MANIFEST_URL = new URL('release-manifest.json', document.baseURI).toString();
const DEFAULT_APP_URL = 'http://127.0.0.1:19180/';

function readLocale(): Locale {
  const fromQuery = new URLSearchParams(location.search).get('lang');
  if (isLocale(fromQuery)) return fromQuery;
  try {
    const stored = localStorage.getItem(LOCALE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    /* ignore */
  }
  return navigator.language.toLowerCase().startsWith('de') ? 'de' : DEFAULT_LOCALE;
}

void i18next.init({ resources, lng: readLocale(), fallbackLng: DEFAULT_LOCALE, interpolation: { escapeValue: false } });
const t = (key: string, opts?: Record<string, unknown>) => i18next.t(key, opts);

let release: ReleaseState = { kind: 'loading' };

function validate(m: unknown): ReleaseState {
  if (!m || typeof m !== 'object') return { kind: 'invalid', manifest: {}, reason: 'not_an_object' };
  const man = m as ReleaseManifest;
  if (man.status !== 'released') return { kind: 'pending', manifest: man };
  const required: Array<keyof ReleaseManifest> = ['version', 'date', 'artifact_filename', 'platform', 'format', 'byte_size', 'sha256', 'download_url', 'tested_commit'];
  for (const key of required) {
    const v = man[key];
    if (v === null || v === undefined || v === '') return { kind: 'invalid', manifest: man, reason: `missing_${String(key)}` };
  }
  if (!/^[0-9a-f]{64}$/i.test(String(man.sha256))) return { kind: 'invalid', manifest: man, reason: 'bad_sha256' };
  if (!(Number(man.byte_size) > 0)) return { kind: 'invalid', manifest: man, reason: 'bad_size' };
  if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/]|\.\/|\/)/.test(String(man.download_url))) return { kind: 'invalid', manifest: man, reason: 'download_url_not_https' };
  if (!/arm64|Apple Silicon/i.test(String(man.platform))) return { kind: 'invalid', manifest: man, reason: 'unsupported_platform' };
  return { kind: 'released', manifest: man };
}

async function loadManifest(): Promise<void> {
  release = { kind: 'loading' };
  render();
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    release = validate(await res.json());
  } catch (e) {
    release = { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
  render();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const icon = (name: string) => {
  const paths: Record<string, string> = {
    download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
    play: '<path d="m9 5 11 7-11 7Z"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    plug: '<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0Zm6 9v5"/>',
    wave: '<path d="M3 16V8h5v8h5V8h5v8h3"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>',
    code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ''}</svg>`;
};
const brand = () => `<span class="brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16V8h5v8h5V8h5v8h3"/></svg></span>blackbox<span class="brand-dot">.</span></span>`;

function fmtBytes(n: number | null | undefined): string {
  if (!n) return '–';
  const tag = INTL_TAGS[i18next.language as Locale] ?? 'en-GB';
  return n < 1024 ** 2 ? `${new Intl.NumberFormat(tag).format(Math.round(n / 1024))} KiB` : `${new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(n / 1024 ** 2)} MiB`;
}
function fmtDate(d: string | null | undefined): string {
  if (!d) return '–';
  const tag = INTL_TAGS[i18next.language as Locale] ?? 'en-GB';
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? d : new Intl.DateTimeFormat(tag, { dateStyle: 'medium' }).format(date);
}

function downloadButton(cls: string, id: string, compact = false): string {
  const label = t('landing.hero.download');
  if (release.kind === 'released') {
    const m = release.manifest;
    return `<a id="${id}" class="btn ${cls}" href="${escapeHtml(String(m.download_url))}" download="${escapeHtml(String(m.artifact_filename))}" data-release="released">${icon('download')} ${label} <small class="mono">${escapeHtml(String(m.version))}</small></a>`;
  }
  const state = release.kind === 'loading' ? 'loading' : release.kind;
  const note = compact ? `<span class="sr-only"> · ${t('landing.release.unavailable')}</span>` : ` · ${t('landing.release.unavailable')}`;
  return `<button id="${id}" type="button" class="btn ${cls}" aria-disabled="true" disabled data-release="${state}" title="${t('landing.release.unavailable')}">${icon('download')} ${label}${note}</button>`;
}

function appUrl(): string {
  const m = release.kind === 'released' || release.kind === 'pending' ? release.manifest : null;
  return m?.app_url || DEFAULT_APP_URL;
}

function releaseCard(): string {
  const m = release.kind === 'released' || release.kind === 'pending' || release.kind === 'invalid' ? release.manifest : null;
  const stateLabel = { loading: '…', released: t('landing.release.preview'), pending: t('landing.release.unavailable'), invalid: t('landing.release.invalid'), failed: t('landing.release.fetchFailed') }[release.kind];
  const rows = m
    ? [
        [t('landing.release.version'), m.version],
        [t('landing.release.date'), fmtDate(m.date)],
        [t('landing.release.platform'), m.platform ?? 'macOS Apple Silicon (arm64)'],
        [t('landing.release.format'), m.format ?? '–'],
        [t('landing.release.size'), fmtBytes(m.byte_size)],
        [t('landing.release.commit'), m.tested_commit ? `<code>${escapeHtml(m.tested_commit.slice(0, 12))}</code>` : '–'],
        [t('landing.release.prerequisites'), `${escapeHtml(m.prerequisites?.container_runtime ?? '–')} · ${escapeHtml(m.prerequisites?.min_os ?? '–')}`],
        [t('landing.release.sha256'), m.sha256 ? `<code>${escapeHtml(m.sha256)}</code>` : '–'],
      ]
    : [];
  let body = '';
  if (release.kind === 'failed') {
    body = `<div class="release-unavailable" role="alert"><strong>${t('landing.release.fetchFailed')}</strong>${escapeHtml(release.error)}<br><button type="button" class="btn small secondary" id="retry-manifest">${t('landing.release.retry')}</button> <a class="btn small secondary" href="#install">${t('landing.release.guide')}</a></div>`;
  } else if (release.kind === 'pending') {
    body = `<div class="release-unavailable" role="status"><strong>${t('landing.release.unavailable')}</strong>${t('landing.release.unavailableBody')}<br><a class="btn small secondary" href="#install">${t('landing.release.guide')}</a></div>`;
  } else if (release.kind === 'invalid') {
    body = `<div class="release-unavailable" role="alert"><strong>${t('landing.release.unavailable')}</strong>${t('landing.release.invalid')} <code class="mono">${escapeHtml(release.reason)}</code><br><a class="btn small secondary" href="#install">${t('landing.release.guide')}</a></div>`;
  }
  return `<section class="release-card" id="release" aria-labelledby="release-title">
    <div class="release-head"><h2 id="release-title">${t('landing.release.title')}${m?.version ? ` · ${escapeHtml(String(m.version))}` : ''}</h2><span class="release-state ${release.kind}">${stateLabel}</span></div>
    ${body}
    ${rows.length ? `<dl class="release-grid">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${typeof v === 'string' && v.startsWith('<') ? v : escapeHtml(String(v ?? '–'))}</dd></div>`).join('')}</dl>` : ''}
    ${m?.release_notes ? `<p class="release-notes"><strong>${t('landing.release.notes')}:</strong> ${escapeHtml(m.release_notes)}</p>` : ''}
    <p class="release-note-line">${t('landing.release.checksumNote')} ${t('landing.release.onlyPlatform')}</p>
    <p class="release-note-line"><a href="#install">${t('landing.release.guide')} →</a></p>
  </section>`;
}

function flightWindow(): string {
  const tracks = ['source', 'fact', 'commitment', 'movement', 'reservation'] as const;
  const chips: Record<string, string[]> = {
    source: ['Shopify · order #1001', 'Bank · entry BK-7781', 'API · stock snapshot'],
    fact: ['#1001 · 10 × CUP-OLV', 'CUP-OLV · 78 available'],
    commitment: ['PO-208 · 80 promised 5 Nov', 'INV-1001 · 95.20 € open'],
    movement: ['Goods out · −10', 'Payout · 91.70 €'],
    reservation: ['R-1001 · 10 reserved', 'Budget · 6,200 € bound'],
  };
  return `<div class="flight-window" aria-hidden="true"><div class="window-bar"><span class="window-label">${icon('wave')} ${t('landing.window.label')}</span><div class="window-meta"><span class="mono">${t('landing.window.demo')}</span><span class="live-label"><i class="dot pulse"></i>${t('landing.window.local')}</span></div></div>
  <div class="pipeline"><div class="pipe-sources"><span class="tiny-label">${t('landing.window.sources')}</span>${['Shopify', 'Shopify Payments', 'Bank CSV', 'API'].map((s) => `<div class="source-pill"><span class="source-icon ${s === 'Shopify' ? 'shopify' : 'api'}">${s[0]}</span>${s}</div>`).join('')}</div>
  <div class="pipe-timeline"><div class="timeline-caption"><span class="tiny-label">${t('landing.window.memory')}</span><span class="record-count">APPEND · CONNECT · REMEMBER</span></div><div class="scan-head" data-now="${t('landing.window.now')}"></div>${tracks.map((tr) => `<div class="mini-track"><span class="mini-track-label">${t(`tracks.${tr}`)}</span>${chips[tr].map((c) => `<span class="mini-event">${c}</span>`).join('')}</div>`).join('')}</div>
  <div class="pipe-answer"><span class="tiny-label">${t('landing.window.answers')}</span><div class="agent-row"><span class="agent-emblem">${icon('spark')}</span>${t('landing.window.agent')}</div><div class="answer-question">${t('landing.window.question')}</div><div class="mini-answer"><b>${t('landing.window.answer')}</b>${t('landing.window.answerDetail')}</div><div class="mini-citations"><span>↗ FAC-STK-002</span><span>↗ SRC-STK-001</span></div></div></div>
  <div class="window-footer"><span><i class="dot"></i>${t('landing.window.footer1')}</span><span>${t('landing.window.footer2')}</span><span>10:42:00 CET</span></div></div>`;
}

const CMD = { doctor: './blackbox doctor', setup: './blackbox setup', up: './blackbox up', open: 'open http://127.0.0.1:19180', stop: './blackbox down', restart: './blackbox up', upgrade: './blackbox upgrade', logs: './blackbox logs --since 1h', reset: './blackbox reset-access' };
const cmd = (c: string) => `<div class="cmd"><code>${escapeHtml(c)}</code><button type="button" data-copy="${escapeHtml(c)}">${t('landing.install.copy')}</button></div>`;

function render(): void {
  const lang = i18next.language.startsWith('de') ? 'de' : 'en';
  document.documentElement.lang = lang;
  document.title = t('meta.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));
  const root = document.getElementById('root') as HTMLElement;
  root.innerHTML = `
  <a class="skip-link" href="#main">${t('common.skipToContent')}</a>
  <header class="wrap"><nav class="site-nav" aria-label="${t('nav.mainLabel')}">
    <a href="#top" aria-label="Blackbox">${brand()}</a>
    <div class="nav-links"><a href="#principle">${t('landing.nav.principle')}</a><a href="#tracks">${t('landing.nav.recorder')}</a><a href="#agents">${t('landing.nav.agents')}</a><a href="#install">${t('landing.nav.install')}</a></div>
    <div class="nav-actions">
      <label class="locale-switch"><span class="sr-only">${t('common.language')}</span><select id="locale" aria-label="${t('common.language')}"><option value="en" ${lang === 'en' ? 'selected' : ''}>English</option><option value="de" ${lang === 'de' ? 'selected' : ''}>Deutsch</option></select></label>
      <a class="btn ghost" href="${escapeHtml(appUrl())}" title="${t('landing.hero.demoNote')}">${t('landing.nav.demo')}</a>
      ${downloadButton('primary', 'download-nav', true)}
    </div></nav></header>
  <main id="main" class="wrap">
    <section class="hero" id="top">
      <span class="eyebrow"><i class="dot"></i>${t('landing.hero.eyebrow')}</span>
      <h1>${t('landing.hero.title1')}<br><em>${t('landing.hero.title2')}</em></h1>
      <p class="hero-copy">${t('landing.hero.copy')}</p>
      <div class="hero-buttons">${downloadButton('primary', 'download-hero')}<a class="btn secondary demo-btn" href="${escapeHtml(appUrl())}">${icon('play')} ${t('landing.hero.demo')} <small>(${t('landing.hero.demoNote')})</small></a></div>
      <p class="micro"><span>${icon('check')} ${t('landing.hero.micro1')}</span><span>${icon('check')} ${t('landing.hero.micro2')}</span><span>${icon('check')} ${t('landing.hero.micro3')}</span></p>
      ${releaseCard()}
      ${flightWindow()}
    </section>
    <div class="source-band"><span class="label">${t('landing.band.label')}</span><strong>Shopify</strong><strong>Shopify Payments</strong><strong>Bank CSV</strong><strong>MCP</strong><span class="plus-more">${t('landing.band.more')}</span></div>
    <section class="principle-section" id="principle"><div class="section-intro"><div><span class="eyebrow">${t('landing.principle.eyebrow')}</span><h2>${t('landing.principle.title')}</h2></div><p>${t('landing.principle.copy')}</p></div>
      <div class="step-grid">${[1, 2, 3].map((n) => `<div class="step"><span class="step-no">0${n} ${icon(['plug', 'wave', 'spark'][n - 1])}</span><h3>${t(`landing.principle.step${n}Title`)}</h3><p>${t(`landing.principle.step${n}`)}</p></div>`).join('')}</div></section>
  </main>
  <section class="tracks-section" id="tracks"><div class="wrap tracks-layout"><div class="tracks-copy"><span class="eyebrow">${t('landing.tracks.eyebrow')}</span><h2>${t('landing.tracks.title')}</h2><p>${t('landing.tracks.copy')}</p><a class="text-link" href="${escapeHtml(appUrl())}">${t('landing.tracks.link')} ${icon('arrow')}</a></div>
    <div class="track-explainer">${(['source', 'fact', 'commitment', 'movement', 'reservation'] as const).map((tr, i) => `<div class="track-explain-row"><span class="track-number">0${i + 1}</span><span class="track-title"><i style="background:${['#8db353', '#779da9', '#aa97c1', '#d8ad70', '#7fae83'][i]}"></i>${t(`tracks.${tr}`)}</span><span class="track-description">${t(`landing.tracks.${tr}`)}</span></div>`).join('')}</div></div></section>
  <section class="wrap questions-section" id="questions"><div class="questions-layout"><div class="questions-copy"><span class="eyebrow">${t('landing.questions.eyebrow')}</span><h2>${t('landing.questions.title')}</h2><div class="example-buttons">${[1, 2, 3, 4, 5].map((n) => `<span class="example-button ${n === 1 ? 'active' : ''}">${t(`landing.questions.q${n}`)} ${icon('arrow')}</span>`).join('')}</div></div>
    <div class="answer-preview"><div class="answer-preview-head"><span>${icon('spark')} ${t('landing.questions.example')}</span>${icon('shield')}</div><span class="eyebrow">${t('landing.questions.answerEyebrow')}</span><h3>${t('landing.questions.answerTitle')}</h3><p>${t('landing.questions.answerCopy')}</p>
    <div class="math-row"><span class="math-item"><strong>112</strong><small>${t('landing.questions.physical')}</small></span><span class="math-op">−</span><span class="math-item"><strong>34</strong><small>${t('landing.questions.committed')}</small></span><span class="math-op">=</span><span class="math-item"><strong>78</strong><small>${t('landing.questions.available')}</small></span></div>
    <p class="answer-warning">${t('landing.questions.warning')}</p><div class="mini-citations"><span>[FAC-STK-002]</span><span>[SRC-STK-001]</span><span>[MOV-SHP-1001]</span><span>[COM-SUP-208]</span></div><p class="proof-line">${icon('clock')} ${t('landing.questions.proof')}</p></div></div></section>
  <section class="wrap" id="agents"><div class="agents-banner"><div><span class="eyebrow">${t('landing.agents.eyebrow')}</span><h2>${t('landing.agents.title')}</h2><p>${t('landing.agents.copy')}</p><a class="btn lime" href="${escapeHtml(appUrl())}agents">${t('landing.agents.cta')} ${icon('arrow')}</a></div>
    <div class="agent-network"><div class="network-core"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16V8h5v8h5V8h5v8h3"/></svg></div><div class="network-line"></div><div class="network-agents"><span class="network-agent">${icon('spark')} ${t('landing.agents.claude')}</span><span class="network-agent">${icon('search')} ${t('landing.agents.inspector')}</span><span class="network-agent">${icon('code')} ${t('landing.agents.own')}</span></div></div></div></section>
  <section class="wrap install-section" id="install"><div class="section-intro"><div><span class="eyebrow">${t('landing.install.eyebrow')}</span><h2>${t('landing.install.title')}</h2></div><p>${t('landing.install.intro')}</p></div>
    <div class="install-grid"><div>
      <h3 class="install-step" style="border:0;padding-top:0">${t('landing.install.prereqTitle')}</h3>
      <ul class="prereq-list"><li>${t('landing.install.prereq1')}</li><li>${t('landing.install.prereq2')}</li><li>${t('landing.install.prereq3')}</li></ul>
      <div class="install-step"><h3><span>01</span>${t('landing.install.step1Title')}</h3><p>${t('landing.install.step1')}</p>${cmd('shasum -a 256 blackbox-<version>-mac-arm64.tar.gz')}${cmd('tar -xzf blackbox-<version>-mac-arm64.tar.gz && cd blackbox-<version>')}</div>
      <div class="install-step"><h3><span>02</span>${t('landing.install.step2Title')}</h3><p>${t('landing.install.step2')}</p>${cmd(CMD.doctor)}</div>
      <div class="install-step"><h3><span>03</span>${t('landing.install.step3Title')}</h3><p>${t('landing.install.step3')}</p>${cmd(CMD.setup)}</div>
    </div><div>
      <div class="install-step" style="border-top:0;padding-top:0"><h3><span>04</span>${t('landing.install.step4Title')}</h3><p>${t('landing.install.step4')}</p>${cmd(CMD.up)}${cmd(CMD.open)}</div>
      <div class="install-step"><h3><span>05</span>${t('landing.install.step5Title')}</h3><p>${t('landing.install.step5')}</p>${cmd(CMD.stop)}${cmd(CMD.restart)}${cmd(CMD.upgrade)}</div>
      <div class="install-step"><h3><span>06</span>${t('landing.install.step6Title')}</h3><p>${t('landing.install.step6')}</p>${cmd(CMD.logs)}${cmd(CMD.reset)}</div>
    </div></div></section>
  <section class="wrap closing-cta" id="closing"><h2>${t('landing.closing.title')}</h2><p>${t('landing.closing.copy')}</p>${downloadButton('primary', 'download-closing')}<p class="micro">${t('landing.release.onlyPlatform')}</p></section>
  <footer class="wrap site-footer">${brand()}<p>${t('landing.footer.tagline')}<small>${t('landing.footer.preview')}</small></p><div class="footer-links"><a href="#principle">${t('landing.footer.principle')}</a><a href="#install">${t('landing.footer.about')}</a><a href="${escapeHtml(appUrl())}">${t('landing.footer.openApp')}</a></div></footer>`;

  (document.getElementById('locale') as HTMLSelectElement).addEventListener('change', (e) => {
    const next = (e.target as HTMLSelectElement).value as Locale;
    try {
      localStorage.setItem(LOCALE_KEY, next);
    } catch {
      /* ignore */
    }
    void i18next.changeLanguage(next).then(render);
  });
  document.getElementById('retry-manifest')?.addEventListener('click', () => void loadManifest());
  root.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy ?? '');
        b.textContent = t('landing.install.copied');
        setTimeout(() => (b.textContent = t('landing.install.copy')), 1500);
      } catch {
        /* clipboard blocked */
      }
    }),
  );
}

render();
void loadManifest();
