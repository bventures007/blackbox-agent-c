import { expect, test } from '@playwright/test';
import { KEY, T, login, openMobileNav, screenshot, setLocale } from './helpers';

test.describe('access-key sign-in', () => {
  test('rejects an invalid key with a localized error and never stores the key in localStorage', async ({ page }) => {
    await setLocale(page, 'en');
    await page.goto('/login');
    await page.getByLabel('Personal access key').fill('bbk_not_a_valid_key');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(T.en.invalid);
    const stored = await page.evaluate(() => JSON.stringify(Object.entries(window.localStorage)));
    expect(stored).not.toContain('bbk_');
    expect(stored).toContain('blackbox.locale');
  });

  test('signs in with BLACKBOX_E2E_KEY, remembers the session across reload and explains owner access', async ({ page }, testInfo) => {
    await setLocale(page, 'en');
    await page.goto('/login');
    await expect(page.getByText('This key grants owner access.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Installation guide' })).toBeVisible();
    await screenshot(page, testInfo, 'en', '60-login');
    await page.getByLabel('Personal access key').fill(KEY);
    await page.getByLabel(T.en.remember).check();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: T.en.recorder })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: T.en.recorder })).toBeVisible();
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'bb_session');
    expect(session?.httpOnly).toBe(true);
  });

  test('German login copy', async ({ page }, testInfo) => {
    await setLocale(page, 'de');
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: T.de.loginTitle })).toBeVisible();
    await expect(page.getByText('Dieser Schlüssel gewährt Inhaberzugriff.')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await screenshot(page, testInfo, 'de', '60-login');
  });

  test('logout ends the session', async ({ page }) => {
    await login(page, 'en');
    await openMobileNav(page, 'en');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: T.en.loginTitle })).toBeVisible();
    await page.goto('/app');
    await expect(page.getByRole('heading', { name: T.en.loginTitle })).toBeVisible();
  });
});
