import { expect, test } from '@playwright/test';
import { T, login, screenshot, type Locale } from './helpers';

test.describe('demo scenario and question order-01', () => {
  for (const locale of ['en', 'de'] as Locale[]) {
    test(`run the demo and ask inventory.available_to_sell in ${locale}`, async ({ page }, testInfo) => {
      await login(page, locale);
      await page.getByRole('button', { name: T[locale].runExample }).click();
      await page.getByRole('button', { name: T[locale].demoConfirm }).click();
      await expect(page.locator('.toast.show')).toBeVisible();
      await expect(page.locator('.track-row[data-track="source"] .event-chip').first()).toBeVisible();
      await page.goto('/app/questions?q=order-01');
      const form = page.getByRole('form', { name: /Can I still sell 100 Olive Cups|Kann ich noch 100 Olive Cups/ });
      await expect(form).toBeVisible();
      await form.getByLabel(locale === 'en' ? 'Item *' : 'Artikel *').fill('CUP');
      await form.getByRole('button', { name: locale === 'en' ? 'Look up' : 'Nachschlagen' }).click();
      await form.getByRole('option', { name: /Olive/ }).click();
      await expect(form.getByLabel(locale === 'en' ? 'Item *' : 'Artikel *')).toHaveValue('CUP-OLV');
      await form.getByLabel(locale === 'en' ? 'Quantity' : 'Menge').fill('100');
      await form.getByRole('button', { name: T[locale].ask, exact: true }).click();
      const answer = page.locator('.answer-output');
      await expect(answer).toBeVisible();
      await expect(answer.locator('.status-badge[data-state="complete"]').first()).toBeVisible();
      await expect(answer.locator('.status-badge[data-state="insufficient_data"]')).toHaveCount(0);
      await expect(answer.getByText(locale === 'en' ? /Yes to 78/ : /Ja zu 78/)).toBeVisible();
      await expect(answer.locator('.citation-btn').first()).toBeVisible();
      await expect(answer.locator('.math-item')).toHaveCount(3);
      await expect(answer.getByText(locale === 'en' ? 'Data status' : 'Datenstatus')).toBeVisible();
      await screenshot(page, testInfo, locale, '22-answer-inventory');
      // evidence drawer lists supporting entries
      await answer.getByRole('button', { name: /Evidence \(|Belege \(/ }).click();
      const drawer = page.getByRole('dialog');
      await expect(drawer).toBeVisible();
      await expect(drawer.locator('.detail-link').first()).toBeVisible();
      await screenshot(page, testInfo, locale, '30-evidence-drawer');
      await page.keyboard.press('Escape');
    });
  }

  test('an unknown item returns insufficient data with missing inputs, not a fabricated zero', async ({ page }) => {
    await login(page, 'en');
    await page.goto('/app/questions?q=order-01');
    const form = page.getByRole('form', { name: /Can I still sell/ });
    await form.getByLabel('Item *').fill('CUP-UNKNOWN');
    await form.getByRole('button', { name: 'Ask', exact: true }).click();
    const answer = page.locator('.answer-output');
    await expect(answer.locator('.status-badge[data-state="insufficient_data"]')).toBeVisible();
    await expect(answer.getByText(/Missing inputs/)).toBeVisible();
  });

  test('entity lifecycle view: invoice INV-1001 shows positions, semantics and history', async ({ page }, testInfo) => {
    await login(page, 'en');
    await page.goto('/app/entities/invoice/INV-1001');
    await expect(page.getByRole('heading', { name: 'Invoice INV-1001', exact: true })).toBeVisible();
    await expect(page.getByText('Currently outstanding')).toBeVisible();
    await expect(page.getByText(/credit note is not a refund/)).toBeVisible();
    await expect(page.locator('.shipment-history-row').first()).toBeVisible();
    await screenshot(page, testInfo, 'en', '35-invoice-issued');
    await page.goto('/app/entities/transaction/TX-1001');
    await expect(page.getByText('In transit to bank')).toBeVisible();
    await screenshot(page, testInfo, 'en', '39-payment-lifecycle');
  });

  test('needs review: revision-safe action appends a decision and shows recalculating', async ({ page }, testInfo) => {
    await login(page, 'en');
    await page.goto('/app/sources#review');
    await expect(page.locator('.review-card').first()).toBeVisible();
    await screenshot(page, testInfo, 'en', '64-needs-review');
    // Pick whichever open case still offers a decision (another project may have resolved one already).
    const actionable = page.locator('.review-card').filter({ has: page.getByRole('button', { name: /Confirm link|Retry processing/ }) }).first();
    await expect(actionable).toBeVisible();
    const caseId = (await actionable.locator('.muted.mono').first().innerText()).split(' ')[0];
    const card = page.locator('.review-card', { hasText: caseId });
    const confirm = actionable.getByRole('button', { name: 'Confirm link' });
    const action = (await confirm.count()) ? confirm : actionable.getByRole('button', { name: 'Retry processing' });
    await action.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/rev \d+/)).toBeVisible();
    await dialog.getByLabel('Reason').fill('Reference text matches payout PO-2026-10-30 on the provider statement.');
    await dialog.getByRole('button', { name: 'Save decision' }).click();
    await expect(page.locator('.toast.show')).toContainText('Decision saved');
    await expect(card.getByText(/recalculating|Resolved|In progress/).first()).toBeVisible();
  });
});
