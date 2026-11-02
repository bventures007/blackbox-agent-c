#!/usr/bin/env node
// UI-01 / LOCAL-06 per-screen capture of the installed web app in real Chromium (Playwright, headless) for the
// reference comparison: every view and dialog, EN and DE, 1440x1000 and 390x844, plus keyboard/focus checks and a
// "no clipped essential controls" check per screen. Reads the owner key from a 0600 file (never printed); the
// agent key shown once in the UI is masked in the DOM before its capture. Output: <out>/<locale>/<width>/<name>.png
// and <out>/capture-report.json (per screen: url, title, checks, clipped controls, focus results).
//   node scripts/verify/ui-capture.mjs --api http://127.0.0.1:19180 --owner-key-file <file> --out reports/evidence/UI-01/screens
import { chromium, devices } from "/Users/benediktsauter/GitHub/blackbox-agent-c/tests/e2e/node_modules/@playwright/test/index.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const API = opt("api", "http://127.0.0.1:19180"); const OUT = opt("out", "reports/evidence/UI-01/screens");
const key = readFileSync(opt("owner-key-file"), "utf8").trim();
const T = {
  en: { login: "Sign in with your access key", keyLabel: "Personal access key", signIn: "Sign in", recorder: "Your business. In view now.", runExample: "Run the example (demo)", demoConfirm: "Load demo scenario", sources: "Your business has many sources.", importPeriod: /import period/i, questions: "Good questions. Evidence-backed answers.", item: "Item *", qty: "Quantity *", lookup: "Look up", ask: "Ask", evidence: /Evidence \(/, journal: "Every entry has a history.", openEntry: /^Open entry/, agents: "Your agent. With business memory.", createKey: "Create agent key", createKeyBtn: "Create key", saved: "I saved the key", system: "System & Diagnostics", warnings: "Warnings & errors", live: "Live", pause: "Pause", debugMin: "Minutes (1–15)", startDebug: /Start \d+ min debug/, stopDebug: "Stop now", exportBtn: "Export diagnostics", preview: "Preview bundle", settings: "Settings", review: "Needs review", connect: /Connect/, openNav: "Open navigation", nav: "Application", close: "Close" },
  de: { login: "Mit deinem Zugangsschlüssel anmelden", keyLabel: "Persönlicher Zugangsschlüssel", signIn: "Anmelden", recorder: "Dein Business. Jetzt im Bild.", runExample: "Beispiel ausführen (Demo)", demoConfirm: "Demo-Szenario laden", sources: "Dein Business hat viele Quellen.", importPeriod: /Importzeitraum/, questions: "Gute Fragen. Belegbare Antworten.", item: "Artikel *", qty: "Menge *", lookup: "Nachschlagen", ask: "Fragen", evidence: /Belege \(/, journal: "Jeder Eintrag hat eine Geschichte.", openEntry: /^Eintrag .* öffnen$/, agents: "Dein Agent. Mit Business-Gedächtnis.", createKey: "Agentenschlüssel anlegen", createKeyBtn: "Schlüssel anlegen", saved: "Ich habe den Schlüssel gespeichert", system: "System & Diagnose", warnings: "Warnungen & Fehler", live: "Live", pause: "Pausieren", debugMin: "Minuten (1–15)", startDebug: /min Debug starten/, stopDebug: "Jetzt beenden", exportBtn: "Diagnose exportieren", preview: "Bündel prüfen (Vorschau)", settings: "Einstellungen", review: "Prüfung erforderlich", connect: /Verbinden/, openNav: "Navigation öffnen", nav: "Anwendung", close: "Schließen" },
};
const report = { api: API, captured_at: new Date().toISOString(), screens: [] };
const browser = await chromium.launch();

async function clippedControls(page) {
  // essential controls: visible buttons/links/inputs inside main; flag any that extend beyond the viewport horizontally
  return page.evaluate(() => {
    const w = window.innerWidth; const bad = [];
    for (const el of document.querySelectorAll("main button, main a, main input, main select, main textarea, [role=dialog] button, [role=dialog] input, [role=dialog] select")) {
      const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none") continue;
      if (r.left < -1 || r.right > w + 1) bad.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" x=${Math.round(r.left)}..${Math.round(r.right)} (vw ${w})`);
    }
    return bad;
  });
}
async function shot(page, locale, width, name, extra = {}) {
  const dir = path.join(OUT, locale, String(width)); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  const hasDialog = await page.locator('[role="dialog"]').count();
  await page.screenshot({ path: file, fullPage: !hasDialog });
  const clipped = await clippedControls(page);
  report.screens.push({ locale, width, name, url: page.url(), title: await page.title(), clipped_controls: clipped, ...extra });
  return file;
}

const LOCALES = (opt("locales", "en,de")).split(",");
for (const locale of LOCALES) {
  for (const [width, ctxOpts] of [[1440, { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }], [390, { ...devices["Pixel 5"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }]]) {
    const tx = T[locale];
    const ctx = await browser.newContext({ ...ctxOpts, locale: locale === "en" ? "en-GB" : "de-DE", timezoneId: "Europe/Berlin" });
    const page = await ctx.newPage();
    await page.addInitScript((l) => { try { localStorage.setItem("blackbox.locale", l); } catch {} }, locale);
    const mobile = width < 600;
    const openNav = async () => { const b = page.getByRole("button", { name: tx.openNav }); if (await b.isVisible().catch(() => false)) await b.click(); };
    // login (keyboard tab order recorded)
    await page.goto(API + "/login");
    await page.getByRole("heading", { name: tx.login }).waitFor({ timeout: 60000 });
    const tabOrder = [];
    await page.keyboard.press("Tab");
    for (let i = 0; i < 6; i++) { tabOrder.push(await page.evaluate(() => { const a = document.activeElement; return a ? a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") + ":" + (a.getAttribute("aria-label") || a.textContent || a.getAttribute("placeholder") || "").trim().slice(0, 25) : null; })); await page.keyboard.press("Tab"); }
    await shot(page, locale, width, "60-login", { tab_order: tabOrder });
    await page.getByLabel(tx.keyLabel).fill(key);
    await page.getByRole("button", { name: tx.signIn, exact: true }).click();
    await page.locator(".app-layout").waitFor({ timeout: 180000 });
    if ((await page.locator("html").getAttribute("lang")) !== locale) { const saved = page.waitForResponse((r) => r.url().includes("/api/workspace") && r.request().method() === "PATCH"); await page.locator(".app-topbar select").selectOption(locale); await saved; }
    await page.getByRole("heading", { name: tx.recorder }).waitFor({ timeout: 60000 });
    // sidebar keyboard navigation
    let navCheck = null;
    try {
      await openNav(); const nav = page.getByRole("navigation", { name: tx.nav }); await nav.getByRole("link").first().focus(); await page.keyboard.press("Tab");
      const focusedSecond = await nav.getByRole("link").nth(1).evaluate((el) => el === document.activeElement); await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: tx.sources }).waitFor({ timeout: 60000 }); navCheck = { tab_moves_to_second_link: focusedSecond, enter_navigates: true };
    } catch (e) { navCheck = { error: e.message.split("\n")[0] }; }
    await page.goto(API + "/app"); await page.getByRole("heading", { name: tx.recorder }).waitFor({ timeout: 60000 }); await page.waitForTimeout(800);
    await shot(page, locale, width, "08-recorder", { sidebar_keyboard: navCheck });
    // demo dialog + focus trap / escape / focus restore
    const demoBtn = page.getByRole("button", { name: tx.runExample }); await demoBtn.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog"); await dialog.waitFor();
    const firstFocused = await dialog.getByRole("button").first().evaluate((el) => el === document.activeElement);
    await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); const stillInside = await dialog.evaluate((d) => d.contains(document.activeElement));
    await shot(page, locale, width, "08b-recorder-demo-dialog", { focus_trap: { first_control_focused: firstFocused, focus_stays_inside_after_tabs: stillInside } });
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" }); const restored = await demoBtn.evaluate((el) => el === document.activeElement);
    report.screens[report.screens.length - 1].focus_trap.escape_closes_and_restores_focus = restored;
    // sources + connect dialogs
    await page.goto(API + "/app/sources"); await page.getByRole("heading", { name: tx.sources }).waitFor({ timeout: 60000 }); await page.waitForTimeout(500);
    await shot(page, locale, width, "11-sources");
    for (const [name, text] of [["16-connect-shopify", "Shopify"], ["20-connect-shopify_payments", "Shopify Payments"], ["17-connect-api", /Signed API|Signierte API|API/], ["17b-connect-bank-csv", /Bank CSV|Bank-CSV/], ["17c-connect-replay", /Replay/]]) {
      const card = page.locator(".integration-card", { hasText: text }).first();
      if (!(await card.count())) continue;
      const btn = card.getByRole("button").first(); if (!(await btn.isEnabled().catch(() => false))) continue;
      await btn.click(); const d = page.getByRole("dialog"); if (await d.isVisible().catch(() => false)) { await shot(page, locale, width, name); await page.keyboard.press("Escape"); await d.waitFor({ state: "hidden" }); }
    }
    // needs review
    await page.goto(API + "/app/sources#review"); await page.waitForTimeout(800); await page.getByRole("heading", { name: tx.review }).scrollIntoViewIfNeeded().catch(() => {}); await shot(page, locale, width, "64-needs-review");
    // connection detail + import plan dialog
    await page.goto(API + "/app/sources"); await page.locator(".ledger-table tr[data-action]").first().click(); await page.getByRole("heading", { name: /Import plan|Importplan/ }).waitFor({ timeout: 60000 }); await page.waitForTimeout(500);
    await shot(page, locale, width, "61-connection-detail");
    await page.getByRole("button", { name: tx.importPeriod }).click(); await page.getByRole("dialog").waitFor(); await shot(page, locale, width, "65-import-plan"); await page.keyboard.press("Escape");
    // questions: empty, answer, unknown, evidence drawer
    await page.goto(API + "/app/questions"); await page.getByRole("heading", { name: tx.questions }).waitFor({ timeout: 60000 }); await page.waitForTimeout(500); await shot(page, locale, width, "21-answers-empty");
    await page.goto(API + "/app/questions?q=order-01"); const form = page.getByRole("form", { name: /Olive Cups/ }); await form.waitFor();
    const itemField = form.locator(".entity-field", { has: page.getByLabel(tx.item) });
    await form.getByLabel(tx.item).fill("CUP"); await itemField.getByRole("button", { name: tx.lookup }).click(); await itemField.getByRole("option", { name: /CUP-OLV/ }).click();
    await form.getByLabel(tx.qty).fill("100"); await form.getByRole("button", { name: tx.ask, exact: true }).click();
    await page.locator(".answer-output .status-badge").first().waitFor({ timeout: 120000 }); await page.waitForTimeout(500); await shot(page, locale, width, "22-answer-inventory");
    await page.locator(".answer-output").getByRole("button", { name: tx.evidence }).click(); await page.getByRole("dialog").waitFor(); await page.locator(".evidence-box").first().waitFor({ timeout: 60000 }); await shot(page, locale, width, "30-evidence-drawer"); await page.keyboard.press("Escape");
    await form.getByLabel(tx.item).fill("CUP-UNKNOWN"); await form.getByLabel(tx.qty).fill("100"); await form.getByRole("button", { name: tx.ask, exact: true }).click();
    await page.locator('.answer-output .status-badge[data-state="unknown"]').first().waitFor({ timeout: 120000 }); await shot(page, locale, width, "28-answer-unknown");
    // journal + entry drawer; filtered + empty
    await page.goto(API + "/app/journal"); await page.getByRole("heading", { name: tx.journal }).waitFor({ timeout: 60000 }); await page.getByRole("button", { name: tx.openEntry }).first().waitFor({ timeout: 60000 }); await page.waitForTimeout(500); await shot(page, locale, width, "56-journal");
    await page.getByRole("button", { name: tx.openEntry }).first().click(); await page.getByRole("dialog").waitFor(); await page.waitForTimeout(800); await shot(page, locale, width, "29-event-src-001"); await page.keyboard.press("Escape");
    await page.goto(API + "/app/journal?track=commitment"); await page.waitForTimeout(1500); await shot(page, locale, width, "57-journal-filtered");
    await page.goto(API + "/app/journal?record_id=NO-SUCH-RECORD-XYZ"); await page.waitForTimeout(1500); await shot(page, locale, width, "58-journal-empty");
    // entity lifecycle views
    await page.goto(API + "/app/entities/invoice/INV-1001"); await page.getByRole("heading", { name: /INV-1001/ }).waitFor({ timeout: 60000 }); await page.waitForTimeout(500); await shot(page, locale, width, "35-invoice-issued");
    await page.goto(API + "/app/entities/transaction/TX-1001"); await page.getByRole("heading", { name: /TX-1001/ }).waitFor({ timeout: 60000 }); await page.waitForTimeout(500); await shot(page, locale, width, "39-payment-lifecycle");
    // agents + key shown once (masked) + MCP config
    await page.goto(API + "/app/agents"); await page.getByRole("heading", { name: tx.agents }).waitFor({ timeout: 60000 }); await page.waitForTimeout(500); await shot(page, locale, width, "46-agents");
    await page.getByRole("button", { name: tx.createKey }).click(); await page.getByLabel(/^Name$/).fill(`ui-capture-${locale}-${width}`); await page.getByRole("dialog").getByRole("button", { name: tx.createKeyBtn }).click();
    await page.locator(".key-display").waitFor(); await page.evaluate(() => { for (const el of document.querySelectorAll(".key-display, .key-display *")) for (const n of el.childNodes) if (n.nodeType === 3 && /bba_/.test(n.textContent)) n.textContent = n.textContent.replace(/bba_[A-Za-z0-9_-]+/g, "bba_<masked for the evidence capture>"); });
    await shot(page, locale, width, "47-agent-key-shown"); await page.getByRole("button", { name: tx.saved }).click();
    // system & diagnostics: cards, warnings filter, live/paused, record drawer, debug, export preview
    await page.goto(API + "/app/system"); await page.getByRole("heading", { name: tx.system, exact: true }).waitFor({ timeout: 60000 }); await page.locator(".log-table tbody tr").first().waitFor({ timeout: 60000 }); await page.waitForTimeout(500); await shot(page, locale, width, "62-system-diagnostics");
    await page.getByRole("button", { name: tx.warnings }).click(); await page.waitForTimeout(1500); await shot(page, locale, width, "66-diagnostics-filtered");
    await page.locator(".log-table tbody tr").first().click(); await page.getByRole("dialog").waitFor(); await page.waitForTimeout(500); await shot(page, locale, width, "66b-diagnostics-record-drawer"); await page.keyboard.press("Escape");
    await page.getByRole("button", { name: tx.live, exact: true }).click(); await page.waitForTimeout(1500); await page.request.get(API + "/api/entities/order/%231001/state"); await page.waitForTimeout(2500); await page.getByRole("button", { name: tx.pause, exact: true }).click(); await page.request.get(API + "/api/entities/order/%231001/state"); await page.waitForTimeout(2500); await shot(page, locale, width, "67-diagnostics-live-paused");
    const stop = page.getByRole("button", { name: tx.stopDebug }); if (await stop.isVisible().catch(() => false)) await stop.click();
    await page.getByLabel(tx.debugMin).fill("15"); await page.getByRole("button", { name: tx.startDebug }).first().click(); await page.waitForTimeout(1500); await shot(page, locale, width, "68-diagnostics-debug-active"); const stop2 = page.getByRole("button", { name: tx.stopDebug }); if (await stop2.isVisible().catch(() => false)) await stop2.click();
    await page.getByRole("button", { name: tx.exportBtn }).click(); await page.getByRole("dialog").waitFor(); await page.getByRole("dialog").getByRole("button", { name: tx.preview }).click(); await page.waitForTimeout(3000); await shot(page, locale, width, "69-diagnostics-export-preview"); await page.keyboard.press("Escape");
    // settings
    await page.goto(API + "/app/settings"); await page.getByRole("heading", { name: tx.settings, exact: true }).waitFor({ timeout: 60000 }); await page.waitForTimeout(800); await shot(page, locale, width, "63-settings");
    // mobile navigation drawer
    if (mobile) { await page.goto(API + "/app"); await page.getByRole("heading", { name: tx.recorder }).waitFor(); const b = page.locator(".mobile-menu-btn").first(); if (await b.isVisible().catch(() => false)) { await b.click(); await page.waitForTimeout(400); const expanded = await b.getAttribute("aria-expanded"); await shot(page, locale, width, "m07-navigation-open", { aria_expanded: expanded, aria_label: await b.getAttribute("aria-label") }); } else report.screens.push({ locale, width, name: "m07-navigation-open", skipped: "mobile menu button not visible", clipped_controls: [] }); }
    await ctx.close();
    console.log(`${locale}/${width}: ${report.screens.filter((s) => s.locale === locale && s.width === width).length} screens`);
  }
}
await browser.close();
const reportFile = path.join(OUT, "capture-report.json");
try { const prev = JSON.parse(readFileSync(reportFile, "utf8")); report.screens = [...prev.screens.filter((s) => !LOCALES.includes(s.locale)), ...report.screens]; } catch {}
writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
const clipped = report.screens.filter((s) => s.clipped_controls.length);
console.log(`total ${report.screens.length} screens; screens with clipped controls: ${clipped.length}`);
for (const s of clipped) console.log(" ", s.locale, s.width, s.name, s.clipped_controls.slice(0, 3));
