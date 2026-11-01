import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEY = process.env.BLACKBOX_E2E_KEY ?? 'bbk_demo_0000000000000000000000000000000000000000000';
/** Upper bound for the sign-in round trip (slow key hash + first render) — well above the default 10 s expect timeout. */
export const LOGIN_TIMEOUT = 180_000;
export type Locale = 'en' | 'de';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCREENSHOT_DIR = path.resolve(here, '..', 'screenshots');

export const T = {
  en: {
    loginTitle: 'Sign in with your access key',
    remember: 'Stay signed in on this computer',
    invalid: 'This access key is not valid.',
    recorder: 'Your business. In view now.',
    sources: 'Your business has many sources.',
    questions: 'Good questions. Evidence-backed answers.',
    journal: 'Every entry has a history.',
    agents: 'Your agent. With business memory.',
    system: 'System & Diagnostics',
    settings: 'Settings',
    runExample: 'Run the example (demo)',
    demoConfirm: 'Load demo scenario',
    ask: 'Ask',
    evidence: 'Evidence',
    navSources: 'Sources',
    navQuestions: 'Questions & Answers',
    warnings: 'Warnings & errors',
    live: 'Live',
    review: 'Needs review',
    download: 'Download for Mac',
    unavailable: 'Download not available yet',
    guide: 'Installation guide',
  },
  de: {
    loginTitle: 'Mit deinem Zugangsschlüssel anmelden',
    remember: 'Auf diesem Computer angemeldet bleiben',
    invalid: 'Dieser Zugangsschlüssel ist ungültig.',
    recorder: 'Dein Business. Jetzt im Bild.',
    sources: 'Dein Business hat viele Quellen.',
    questions: 'Gute Fragen. Belegbare Antworten.',
    journal: 'Jeder Eintrag hat eine Geschichte.',
    agents: 'Dein Agent. Mit Business-Gedächtnis.',
    system: 'System & Diagnose',
    settings: 'Einstellungen',
    runExample: 'Beispiel ausführen (Demo)',
    demoConfirm: 'Demo-Szenario laden',
    ask: 'Fragen',
    evidence: 'Belege',
    navSources: 'Quellen',
    navQuestions: 'Fragen & Antworten',
    warnings: 'Warnungen & Fehler',
    live: 'Live',
    review: 'Prüfung erforderlich',
    download: 'Für Mac herunterladen',
    unavailable: 'Download noch nicht verfügbar',
    guide: 'Installationsanleitung',
  },
} as const;

export async function setLocale(page: Page, locale: Locale): Promise<void> {
  await page.addInitScript((l) => {
    try {
      window.localStorage.setItem('blackbox.locale', l);
    } catch {
      /* ignore */
    }
  }, locale);
}

export async function login(page: Page, locale: Locale = 'en', remember = true): Promise<void> {
  await setLocale(page, locale);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: T[locale].loginTitle })).toBeVisible();
  await page.getByLabel(locale === 'en' ? 'Personal access key' : 'Persönlicher Zugangsschlüssel').fill(KEY);
  if (remember) await page.getByLabel(T[locale].remember).check();
  await page.getByRole('button', { name: locale === 'en' ? 'Sign in' : 'Anmelden', exact: true }).click();
  // Key verification is a deliberate slow hash (scrypt); on a loaded Mac the round trip takes several seconds.
  // After login the server-persisted workspace locale applies; the shell toggle persists a change through PATCH /api/workspace.
  await expect(page.locator('.app-layout')).toBeVisible({ timeout: LOGIN_TIMEOUT });
  const currentLang = await page.locator('html').getAttribute('lang');
  if (currentLang !== locale) await switchLocale(page, locale);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.getByRole('heading', { name: T[locale].recorder })).toBeVisible();
}

/** Switches the shell language and waits until the preference is persisted (PATCH /api/workspace) so later document loads keep it. */
export async function switchLocale(page: Page, locale: Locale): Promise<void> {
  const saved = page.waitForResponse((r) => r.url().includes('/api/workspace') && r.request().method() === 'PATCH', { timeout: LOGIN_TIMEOUT });
  await page.locator('.app-topbar select').selectOption(locale);
  await saved;
}

export async function screenshot(page: Page, testInfo: TestInfo, locale: Locale, name: string): Promise<void> {
  const dir = path.join(SCREENSHOT_DIR, locale);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = testInfo.project.name === 'mobile' ? '-mobile' : '';
  await page.screenshot({ path: path.join(dir, `${name}${suffix}.png`), fullPage: true });
}

/** Asserts every listed control sits inside the viewport horizontally and is visible (no clipped essential controls). */
export async function expectWithinViewport(page: Page, locators: Locator[]): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) return;
  for (const locator of locators) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box, 'bounding box').not.toBeNull();
    if (!box) continue;
    expect(box.x, 'left edge').toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width, 'right edge').toBeLessThanOrEqual(viewport.width + 1);
    expect(box.width, 'width').toBeGreaterThan(8);
    expect(box.height, 'height').toBeGreaterThan(8);
  }
}

export async function openMobileNav(page: Page, locale: Locale): Promise<void> {
  const btn = page.getByRole('button', { name: locale === 'en' ? 'Open navigation' : 'Navigation öffnen' });
  if (await btn.isVisible()) await btn.click();
}
