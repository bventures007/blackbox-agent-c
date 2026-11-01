import { expect, test } from '@playwright/test';
import { T, login, screenshot, type Locale } from './helpers';

// Oracle: GOLDEN-ORDER-TO-CASH.json checkpoint after G19 — physical 112, reserved 0, quarantined 0, available 112.
const GOLDEN_AVAILABLE = '112';
/** Upper bound for POST /api/demo/run (durable journal commit of the whole scenario). */
const DEMO_TIMEOUT = 900_000;

test.describe('demo scenario and question order-01', () => {
  for (const locale of ['en', 'de'] as Locale[]) {
    test(`run the demo and ask inventory.available_to_sell in ${locale}`, async ({ page }, testInfo) => {
      test.setTimeout(1_500_000);
      await login(page, locale);
      await page.getByRole('button', { name: T[locale].runExample }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: T[locale].demoConfirm }).click();
      // Loading the scenario through the real ingestion path takes tens of seconds on a busy Mac. When non-demo
      // connections already hold data the API answers 409 confirmation_required and the dialog asks a second time.
      const toast = page.locator('.toast.show');
      const alongside = dialog.getByRole('button', { name: locale === 'en' ? 'Add demo data alongside my data' : 'Demo-Daten neben meinen Daten laden' });
      await expect(toast.or(alongside)).toBeVisible({ timeout: DEMO_TIMEOUT });
      if (await alongside.isVisible()) {
        await alongside.click();
        await expect(toast).toBeVisible({ timeout: DEMO_TIMEOUT });
      }
      await expect(page.locator('.track-row[data-track="source"] .event-chip').first()).toBeVisible();
      await expect(page.locator('.track-row[data-track="fact"] .event-chip').first()).toBeVisible();
      await page.goto('/app/questions?q=order-01');
      const form = page.getByRole('form', { name: /Can I still sell 100 Olive Cups|Kann ich noch 100 Olive Cups/ });
      await expect(form).toBeVisible();
      // Entity disambiguation is a literal journal search (GET /api/search), never a model.
      await form.getByLabel(locale === 'en' ? 'Item *' : 'Artikel *').fill('CUP');
      await form.getByRole('button', { name: locale === 'en' ? 'Look up' : 'Nachschlagen' }).click();
      await form.getByRole('option', { name: /CUP-OLV/ }).click();
      await expect(form.getByLabel(locale === 'en' ? 'Item *' : 'Artikel *')).toHaveValue('CUP-OLV');
      await form.getByLabel(locale === 'en' ? 'Quantity *' : 'Menge *').fill('100');
      await form.getByRole('button', { name: T[locale].ask, exact: true }).click();
      const answer = page.locator('.answer-output');
      await expect(answer).toBeVisible();
      await expect(answer.locator('.status-badge[data-state="complete"]').first()).toBeVisible();
      await expect(answer.locator('.status-badge[data-state="unknown"]')).toHaveCount(0);
      await expect(answer.getByText(locale === 'en' ? new RegExp(`Yes — ${GOLDEN_AVAILABLE}`) : new RegExp(`Ja — ${GOLDEN_AVAILABLE}`))).toBeVisible();
      // Calculation steps come from the engine envelope (formula + values), the UI computes nothing.
      expect(await answer.locator('.math-item').count()).toBeGreaterThanOrEqual(2);
      await expect(answer.locator('.math-item .formula').first()).toContainText('available = physical');
      await expect(answer.locator('.citation-btn').first()).toBeVisible();
      await expect(answer.getByText(locale === 'en' ? 'Data status' : 'Datenstatus')).toBeVisible();
      await expect(answer.getByText(locale === 'en' ? /applied cursor \d+/ : /angewendeter Cursor \d+/)).toBeVisible();
      await screenshot(page, testInfo, locale, '22-answer-inventory');
      // evidence drawer lists the cited journal entries with their raw evidence
      await answer.getByRole('button', { name: /Evidence \(|Belege \(/ }).click();
      const drawer = page.getByRole('dialog');
      await expect(drawer).toBeVisible();
      await expect(drawer.locator('.detail-link').first()).toBeVisible();
      await expect(drawer.locator('.evidence-box').first()).toBeVisible();
      await screenshot(page, testInfo, locale, '30-evidence-drawer');
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
    });
  }

  test('an unknown item returns status unknown with the missing basis, not a fabricated zero', async ({ page }, testInfo) => {
    await login(page, 'en');
    await page.goto('/app/questions?q=order-01');
    const form = page.getByRole('form', { name: /Can I still sell/ });
    await form.getByLabel('Item *').fill('CUP-UNKNOWN');
    await form.getByLabel('Quantity *').fill('100');
    await form.getByRole('button', { name: 'Ask', exact: true }).click();
    const answer = page.locator('.answer-output');
    await expect(answer.locator('.status-badge[data-state="unknown"]').first()).toBeVisible();
    await expect(answer.getByText(/Missing inputs/)).toBeVisible();
    await expect(answer.getByText(/no stock observation/)).toBeVisible();
    await expect(answer.getByText(/Yes —|No —/)).toHaveCount(0);
    await screenshot(page, testInfo, 'en', '28-answer-unknown');
  });

  test('entity lifecycle view: invoice INV-1001 shows positions, semantics, tracks and history', async ({ page }, testInfo) => {
    await login(page, 'en');
    await page.goto('/app/entities/invoice/INV-1001');
    await expect(page.getByRole('heading', { name: 'Invoice INV-1001', exact: true })).toBeVisible();
    await expect(page.getByText('Currently outstanding')).toBeVisible();
    await expect(page.getByText(/credit note is not a refund/)).toBeVisible();
    await expect(page.locator('.track-summary-row')).toHaveCount(5);
    await expect(page.locator('.shipment-history-row').first()).toBeVisible();
    await screenshot(page, testInfo, 'en', '35-invoice-issued');
    await page.goto('/app/entities/transaction/TX-1001');
    await expect(page.getByRole('heading', { name: 'Payment TX-1001', exact: true })).toBeVisible();
    await expect(page.locator('.payment-position')).toContainText('Captured');
    await expect(page.locator('.payment-position')).toContainText('Refunded');
    await screenshot(page, testInfo, 'en', '39-payment-lifecycle');
  });

  test('needs review: an ambiguous bank credit opens a case; a revision-safe decision appends and resolves it', async ({ page }, testInfo) => {
    await login(page, 'en');
    const stamp = Date.now().toString(36);
    // 1. Two unmatched payouts with the same amount through the deterministic replay producer (owner-only UI dialog).
    await page.goto('/app/sources');
    await page.locator('.integration-card', { hasText: 'Replay (fixtures)' }).getByRole('button', { name: /Connect/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Connection name').fill(`e2e replay ${stamp}`);
    const events = ['A', 'B'].map((x) => ({ provider_event_id: `e2e-${stamp}-${x}`, kind: 'payout.sent', occurred_at: '2026-10-30T10:00:00Z', entity: { payout: `OUT-${stamp}-${x}` }, payload: { payout: `OUT-${stamp}-${x}`, amount_minor: 4242, currency: 'EUR' }, evidence_refs: [] }));
    await dialog.getByLabel('Fixture events (JSON array)').fill(JSON.stringify(events));
    await dialog.getByRole('button', { name: 'Create and replay' }).click();
    await expect(dialog.getByText(/Accepted 2/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page).toHaveURL(/\/app\/sources\//);
    // 2. A bank credit of the same amount without a payout reference → ambiguous → review case (nothing is linked silently).
    await page.goto('/app/sources');
    await page.locator('.integration-card', { hasText: 'Bank CSV' }).getByRole('button', { name: /Connect/ }).click();
    const bank = page.getByRole('dialog');
    await bank.getByLabel('Connection name').fill(`e2e bank ${stamp}`);
    await bank.getByLabel('Or paste CSV').fill(`date;amount;currency;reference;counterparty;booking_text\n2026-10-31;42,42;EUR;PAYOUT ${stamp};Provider;credit`);
    await bank.getByRole('button', { name: 'Preview rows' }).click();
    await expect(bank.getByText(/1 rows · 1 ambiguous/)).toBeVisible();
    await bank.getByRole('button', { name: 'Commit rows to journal' }).click();
    await expect(page).toHaveURL(/\/app\/sources\//);
    // 3. The case is listed under Needs review with the two candidates; confirm the link with a reason.
    await page.goto('/app/sources#review');
    const card = page.locator('.review-card', { hasText: `OUT-${stamp}-A` }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText(/Ambiguous bank match/)).toBeVisible();
    await screenshot(page, testInfo, 'en', '64-needs-review');
    const revision = (await card.locator('.muted.mono').first().innerText()).match(/rev (\d+)/)?.[1];
    await card.getByRole('button', { name: 'Confirm link' }).click();
    const decision = page.getByRole('dialog');
    await expect(decision.getByText(new RegExp(`rev ${revision}`))).toBeVisible();
    await decision.getByLabel('Reason').fill(`Reference text matches payout OUT-${stamp}-A on the provider statement.`);
    await decision.getByRole('button', { name: 'Save decision' }).click();
    await expect(page.locator('.toast.show')).toContainText('Decision saved');
    await expect(page.locator('.review-card', { hasText: `OUT-${stamp}-A` }).first().locator('.status-badge[data-state="resolved"]')).toBeVisible();
  });
});
