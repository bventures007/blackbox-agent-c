import { expect, test } from '@playwright/test';
import { LANDING_URL } from '../playwright.config';
import { T, expectWithinViewport, screenshot, type Locale } from './helpers';

test.describe('landing page (served from a separate static base URL)', () => {
  for (const locale of ['en', 'de'] as Locale[]) {
    test(`shows the release metadata or the truthful unavailable state in ${locale}`, async ({ page }, testInfo) => {
      await page.goto(`${LANDING_URL}?lang=${locale}`);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const tx = T[locale];
      const manifest = (await (await page.request.get(new URL('release-manifest.json', LANDING_URL).toString())).json()) as { status: string; version?: string; sha256?: string | null };
      const ctas = page.locator('#download-nav, #download-hero, #download-closing');
      await expect(ctas).toHaveCount(3);
      await expect(page.locator('#release')).toBeVisible();
      if (manifest.status === 'released') {
        for (const cta of await ctas.all()) {
          await expect(cta).toHaveAttribute('data-release', 'released');
          await expect(cta).toHaveAttribute('href', /.+/);
        }
        await expect(page.locator('#release')).toContainText(String(manifest.sha256));
        await expect(page.locator('#release')).toContainText('arm64');
      } else {
        for (const cta of await ctas.all()) {
          await expect(cta).toHaveAttribute('aria-disabled', 'true');
          await expect(cta).toContainText(tx.unavailable);
        }
        await expect(page.locator('#release')).toContainText(tx.unavailable);
      }
      await expect(page.locator('#release')).toContainText(locale === 'en' ? 'Platform' : 'Plattform');
      await expect(page.getByRole('heading', { name: locale === 'en' ? 'From download to first answer.' : 'Vom Download zur ersten Antwort.' })).toBeVisible();
      await expect(page.getByText('./blackbox doctor').first()).toBeVisible();
      await expect(page.getByText('./blackbox setup').first()).toBeVisible();
      await expect(page.getByText('./blackbox up').first()).toBeVisible();
      await expect(page.getByText('127.0.0.1:19180').first()).toBeVisible();
      await expect(page.getByRole('link', { name: /sign ?up|register|registrieren|anmelden/i })).toHaveCount(0);
      await expect(page.locator('form')).toHaveCount(0);
      await expect(page.getByText(/private preview/i).first()).toBeVisible();
      const demo = page.locator('a.demo-btn');
      await expect(demo).toHaveAttribute('href', /127\.0\.0\.1:19180/);
      await expectWithinViewport(page, [page.locator('#download-hero'), demo, page.locator('#locale')]);
      await screenshot(page, testInfo, locale, '01-landing');
      // Keyboard: the hero download control is focusable when released; a disabled preview button is not a live download.
      if (manifest.status === 'released') {
        await page.locator('#download-hero').focus();
        await expect(page.locator('#download-hero')).toBeFocused();
      } else {
        await expect(page.locator('#download-hero')).toBeDisabled();
      }
    });
  }

  test('the HTML contains no embedded credentials or private tokens', async ({ page }) => {
    await page.goto(LANDING_URL);
    const html = await page.content();
    expect(html).not.toMatch(/ghp_[A-Za-z0-9]{20,}|bbk_[A-Za-z0-9_-]{20,}|bba_[A-Za-z0-9_-]{20,}|Authorization: Bearer/);
  });
});
