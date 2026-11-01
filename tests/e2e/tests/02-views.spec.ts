import { expect, test } from '@playwright/test';
import { T, expectWithinViewport, login, openMobileNav, screenshot, type Locale } from './helpers';

for (const locale of ['en', 'de'] as Locale[]) {
  test.describe(`views in ${locale}`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, locale);
    });

    test('recorder shows five tracks, question shortcuts, readiness and example action', async ({ page }, testInfo) => {
      const tx = T[locale];
      await expect(page.getByRole('heading', { name: tx.recorder })).toBeVisible();
      const tracks = locale === 'en' ? ['Sources', 'Facts', 'Commitments', 'Movements', 'Reservations'] : ['Quellen', 'Fakten', 'Zusagen', 'Bewegungen', 'Reservierungen'];
      for (const name of tracks) await expect(page.locator('.track-name', { hasText: name })).toBeVisible();
      await expect(page.getByRole('button', { name: tx.runExample })).toBeVisible();
      await expect(page.getByText(locale === 'en' ? 'Source readiness' : 'Quellenstatus')).toBeVisible();
      await expectWithinViewport(page, [page.getByRole('button', { name: tx.runExample }), page.locator('.stat').first(), page.locator('.recorder-header')]);
      await screenshot(page, testInfo, locale, '08-recorder');
    });

    test('sources catalogue: grouped categories, provider state badges, Xentral absent, needs-review list', async ({ page }, testInfo) => {
      await page.goto('/app/sources');
      await expect(page.getByRole('heading', { name: T[locale].sources })).toBeVisible();
      const cats = locale === 'en' ? ['Shops & business', 'Payments & payouts', 'Invoices & accounting', 'Shipping sources'] : ['Shops & Business', 'Zahlungen & Auszahlungen', 'Rechnungen & Buchhaltung', 'Versandquellen'];
      for (const c of cats) await expect(page.getByRole('heading', { name: c, exact: true })).toBeVisible();
      await expect(page.getByText(/xentral/i)).toHaveCount(0);
      await expect(page.locator('.status-badge[data-state="planned"]').first()).toBeVisible();
      await expect(page.locator('.status-badge[data-state="implemented"], .status-badge[data-state="syncing"], .status-badge[data-state="degraded"]').first()).toBeVisible();
      await expect(page.getByRole('heading', { name: T[locale].review })).toBeVisible();
      await expect(page.locator('.review-card').first()).toBeVisible();
      await expectWithinViewport(page, [page.locator('.integration-card .btn').first(), page.locator('.source-jump-links a').first()]);
      await screenshot(page, testInfo, locale, '11-sources');
      // connect dialog (shopify) opens, has fields, Escape closes it
      await page.locator('.integration-card', { hasText: 'Shopify' }).first().getByRole('button').first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel(locale === 'en' ? 'Shop domain' : 'Shop-Domain')).toBeVisible();
      await screenshot(page, testInfo, locale, '16-connect-shopify');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });

    test('connection detail: import plan with timezone/UTC boundaries, runs, health, view logs link', async ({ page }, testInfo) => {
      await page.goto('/app/sources');
      await page.locator('.ledger-table tr[data-action]').first().click();
      await expect(page.getByRole('heading', { name: locale === 'en' ? 'Import plan' : 'Importplan' })).toBeVisible();
      await expect(page.getByText('UTC').first()).toBeVisible();
      await expect(page.getByText(locale === 'en' ? 'Last successful check' : 'Letzte erfolgreiche Prüfung').first()).toBeVisible();
      await expect(page.getByText(locale === 'en' ? 'Last new event' : 'Letztes neues Ereignis').first()).toBeVisible();
      await expect(page.getByRole('link', { name: T[locale].navSources === 'Sources' ? 'View logs' : 'Logs anzeigen' }).first()).toBeVisible();
      await expect(page.locator('.run-card').first()).toBeVisible();
      await screenshot(page, testInfo, locale, '61-connection-detail');
      // import plan dialog shows the five presets
      await page.getByRole('button', { name: locale === 'en' ? /import period/i : /Importzeitraum/ }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('radio')).toHaveCount(5);
      await expect(dialog.getByText(locale === 'en' ? 'From now on (advanced)' : 'Ab jetzt (erweitert)')).toBeVisible();
      await screenshot(page, testInfo, locale, '65-import-plan');
      await page.keyboard.press('Escape');
    });

    test('questions: six groups, 24 templates, labeled search box, typed parameter form', async ({ page }, testInfo) => {
      await page.goto('/app/questions');
      await expect(page.getByRole('heading', { name: T[locale].questions })).toBeVisible();
      await expect(page.locator('.otc-card')).toHaveCount(6);
      await expect(page.locator('.otc-question')).toHaveCount(24);
      await expect(page.getByText(locale === 'en' ? 'search only — not a chat' : 'nur Suche — kein Chat')).toBeVisible();
      await screenshot(page, testInfo, locale, '21-answers-empty');
      await page.locator('.otc-question-button').first().click();
      await expect(page.getByRole('button', { name: T[locale].ask, exact: true })).toBeVisible();
      await expect(page.getByLabel(locale === 'en' ? 'Item *' : 'Artikel *')).toBeVisible();
    });

    test('journal: filters, table, entry drawer with payload and evidence', async ({ page }, testInfo) => {
      await page.goto('/app/journal');
      await expect(page.getByRole('heading', { name: T[locale].journal })).toBeVisible();
      await expect(page.getByLabel(locale === 'en' ? 'Track' : 'Spur')).toBeVisible();
      const rows = page.locator('.ledger-table tr[data-action]');
      if ((await rows.count()) > 0) {
        await rows.first().click();
        const drawer = page.getByRole('dialog');
        await expect(drawer).toBeVisible();
        await expect(drawer.getByText(locale === 'en' ? 'Typed payload' : 'Typisierte Nutzlast')).toBeVisible();
        await screenshot(page, testInfo, locale, '29-event-src-001');
        await page.keyboard.press('Escape');
      } else {
        await expect(page.getByText(locale === 'en' ? 'No entries match these filters.' : 'Keine Einträge passen zu diesen Filtern.')).toBeVisible();
      }
      await screenshot(page, testInfo, locale, '56-journal');
    });

    test('agents & MCP: grant explanation, create key shown once, copyable stdio config', async ({ page }, testInfo) => {
      await page.goto('/app/agents');
      await expect(page.getByRole('heading', { name: T[locale].agents })).toBeVisible();
      await expect(page.getByText('workspace.read_business').first()).toBeVisible();
      await expect(page.locator('.config-code').first()).toContainText('mcpServers');
      await expect(page.getByText('127.0.0.1').first()).toBeVisible();
      await screenshot(page, testInfo, locale, '46-agents');
      await page.getByRole('button', { name: locale === 'en' ? 'Create agent key' : 'Agentenschlüssel anlegen' }).click();
      await page.getByLabel(locale === 'en' ? 'Name' : 'Name', { exact: true }).fill(`e2e-${locale}`);
      await page.getByRole('dialog').getByRole('button', { name: locale === 'en' ? 'Create key' : 'Schlüssel anlegen' }).click();
      await expect(page.locator('.key-display')).toContainText('bba_');
      await screenshot(page, testInfo, locale, '47-agent-key-shown');
      await page.getByRole('button', { name: locale === 'en' ? 'I saved the key' : 'Ich habe den Schlüssel gespeichert' }).click();
      await expect(page.locator('.ledger-table', { hasText: `e2e-${locale}` })).toBeVisible();
    });

    test('system & diagnostics: seven health cards, logs table, debug and export controls', async ({ page }, testInfo) => {
      await page.goto('/app/system');
      await expect(page.getByRole('heading', { name: T[locale].system, exact: true })).toBeVisible();
      await expect(page.locator('.health-card')).toHaveCount(7);
      await expect(page.locator('.log-table tbody tr').first()).toBeVisible();
      await expect(page.getByRole('button', { name: T[locale].warnings })).toBeVisible();
      await expect(page.getByRole('button', { name: locale === 'en' ? 'Export diagnostics' : 'Diagnose exportieren' })).toBeVisible();
      await screenshot(page, testInfo, locale, '62-system-diagnostics');
    });

    test('settings: backups & recovery states, retention, storage, key rotation, lifecycle', async ({ page }, testInfo) => {
      await page.goto('/app/settings');
      await expect(page.getByRole('heading', { name: T[locale].settings, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: locale === 'en' ? /Backups & recovery/ : /Sicherung & Wiederherstellung/ })).toBeVisible();
      await expect(page.getByText(locale === 'en' ? 'Request backup now' : 'Sicherung jetzt anfordern')).toBeVisible();
      await expect(page.getByRole('button', { name: locale === 'en' ? 'Rotate key' : 'Schlüssel erneuern' })).toBeVisible();
      await expect(page.getByText('./blackbox down')).toBeVisible();
      await screenshot(page, testInfo, locale, '63-settings');
    });

    test('keyboard navigation of the main nav and of a dialog', async ({ page }) => {
      const isMobile = (page.viewportSize()?.width ?? 1440) < 600;
      if (isMobile) {
        await openMobileNav(page, locale);
        await expect(page.locator('.sidebar')).toHaveClass(/mobile-open/);
      }
      const nav = page.getByRole('navigation', { name: locale === 'en' ? 'Application' : 'Anwendung' });
      await nav.getByRole('link').first().focus();
      await page.keyboard.press('Tab');
      await expect(nav.getByRole('link').nth(1)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: T[locale].sources })).toBeVisible();
      await page.goto('/app');
      await page.getByRole('button', { name: T[locale].runExample }).focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button').first()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: T[locale].runExample })).toBeFocused();
    });
  });
}
