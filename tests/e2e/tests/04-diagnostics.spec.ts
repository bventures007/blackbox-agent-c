import { expect, test } from '@playwright/test';
import { login, screenshot } from './helpers';

test.describe('system & diagnostics', () => {
  test('filters: warnings preset, component filter, literal search, record drawer with trace siblings', async ({ page }, testInfo) => {
    await login(page, 'en');
    await page.goto('/app/system');
    const rows = page.locator('.log-table tbody tr');
    await expect(rows.first()).toBeVisible();
    await page.getByRole('button', { name: 'Warnings & errors' }).click();
    await expect(page.locator('.active-filters')).toContainText('WARN, ERROR');
    await expect(rows.first()).toBeVisible();
    const levels = await rows.locator('td:nth-child(2)').allInnerTexts();
    expect(levels.every((l) => /WARN|ERROR/.test(l))).toBe(true);
    await page.getByLabel('Worker', { exact: true }).check();
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('.active-filters')).toContainText('Component: worker');
    const comps = await rows.locator('td:nth-child(3)').allInnerTexts();
    expect(comps.every((c) => c === 'Worker')).toBe(true);
    await page.getByLabel('Literal search').fill('rate limit');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(rows.first()).toContainText('provider.rate_limited');
    await screenshot(page, testInfo, 'en', '66-diagnostics-filtered');
    await rows.first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Record ID')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Copy safe details' })).toBeVisible();
    await expect(drawer.getByText(/Trace \(/)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.locator('.active-filters')).toContainText('Minimum level: INFO');
  });

  test('live mode appends records, pause freezes with a new-record counter, resume merges', async ({ page }, testInfo) => {
    await login(page, 'en');
    await page.goto('/app/system');
    const rows = page.locator('.log-table tbody tr');
    await expect(rows.first()).toBeVisible();
    const firstBefore = await rows.first().innerText();
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    await expect(page.getByRole('button', { name: /Live · on/ })).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => rows.first().innerText(), { timeout: 10_000 }).not.toBe(firstBefore);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('button', { name: /Resume \(\d+ new\)/ })).toBeVisible();
    await expect.poll(async () => page.getByRole('button', { name: /Resume \((\d+) new\)/ }).innerText(), { timeout: 10_000 }).toMatch(/Resume \([1-9]\d* new\)/);
    await screenshot(page, testInfo, 'en', '67-diagnostics-live-paused');
    await page.getByRole('button', { name: /Resume \(/ }).click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  });

  test('debug controls bound minutes to 15 and show expiry; export dialog previews before download', async ({ page }) => {
    await login(page, 'en');
    await page.goto('/app/system');
    await page.getByLabel('Minutes (1–15)').fill('30');
    await expect(page.getByLabel('Minutes (1–15)')).toHaveValue('15');
    await page.getByRole('button', { name: /Start 15 min debug/ }).click();
    await expect(page.getByText('Debug recording active')).toBeVisible();
    await expect(page.getByText(/Expires .* remaining/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Stop now' }).click();
    await expect(page.getByRole('button', { name: /Start \d+ min debug/ })).toBeVisible();
    await page.getByRole('button', { name: 'Export diagnostics' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Never included: business records')).toBeVisible();
    await dialog.getByRole('button', { name: 'Preview bundle' }).click();
    await expect(dialog.getByText('Estimated size')).toBeVisible();
    await expect(dialog.getByText('/ 10 MiB')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Download bundle' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('view logs deep link from a source applies the connection filter', async ({ page }) => {
    await login(page, 'en');
    await page.goto('/app/sources');
    await page.locator('.ledger-table tr[data-action]').first().click();
    await page.getByRole('link', { name: 'View logs' }).first().click();
    await expect(page).toHaveURL(/\/app\/system\?connection_id=/);
    await expect(page.locator('.active-filters')).toContainText('Connection ID:');
  });
});
