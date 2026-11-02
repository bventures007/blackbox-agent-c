#!/usr/bin/env node
// DIST-01/02 evidence helper: captures a landing host in EN/DE at desktop (1440x1000) and mobile (390x844):
// full page, the three download CTAs (nav/hero/closing), the release card, plus a JSON dump of the CTA
// attributes (href, aria-disabled, data-release) and the resolved download href. Headless Chromium via the
// repository's Playwright install. Writes <out>/<label>-<locale>-<device>-{page,nav,hero,closing,release}.png
// and <out>/<label>-ctas.json. Nothing is downloaded or installed here.
//   node scripts/verify/landing-capture.mjs --url http://127.0.0.1:19181/ --label released --out reports/evidence/DIST-01
import { chromium } from "/Users/benediktsauter/GitHub/blackbox-agent-c/tests/e2e/node_modules/@playwright/test/index.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const URL_ = opt("url"); const LABEL = opt("label", "landing"); const OUT = opt("out", "reports/evidence/DIST-01");
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const report = { url: URL_, label: LABEL, captured_at: new Date().toISOString(), states: [] };
for (const locale of ["en", "de"]) {
  for (const [device, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: locale === "en" ? "en-GB" : "de-DE" });
    const page = await ctx.newPage();
    await page.goto(`${URL_}?lang=${locale}`, { waitUntil: "networkidle" });
    await page.waitForSelector("#release");
    await page.waitForTimeout(500);
    const base = path.join(OUT, `${LABEL}-${locale}-${device}`);
    await page.screenshot({ path: `${base}-page.png`, fullPage: true });
    for (const [name, sel] of [["nav", "#download-nav"], ["hero", "#download-hero"], ["closing", "#download-closing"], ["release", "#release"]]) {
      const el = page.locator(sel).first();
      if ((await el.count()) && (await el.isVisible())) { await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: `${base}-${name}.png`, timeout: 10_000 }).catch(() => {}); }
    }
    const info = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      ctas: [...document.querySelectorAll("#download-nav, #download-hero, #download-closing")].map((e) => ({ id: e.id, tag: e.tagName, text: e.textContent.trim().replace(/\s+/g, " "), href: e.getAttribute("href"), resolved: e.href ?? null, aria_disabled: e.getAttribute("aria-disabled"), disabled: e.disabled ?? null, data_release: e.getAttribute("data-release"), download_attr: e.getAttribute("download") })),
      release_card: document.querySelector("#release")?.innerText.replace(/\s+/g, " ").slice(0, 1200),
      guide_links: [...document.querySelectorAll("a[href*='INSTALL']")].map((a) => a.href),
      demo: document.querySelector("a.demo-btn")?.href ?? null,
    }));
    report.states.push({ locale, device, ...info });
    await ctx.close();
  }
}
await browser.close();
writeFileSync(path.join(OUT, `${LABEL}-ctas.json`), JSON.stringify(report, null, 2) + "\n");
console.log(`${LABEL}: ${report.states.length} states captured -> ${OUT}`);
for (const s of report.states) console.log(` ${s.locale}/${s.device}: ${s.ctas.map((c) => `${c.id}=${c.data_release}${c.aria_disabled === "true" ? "(disabled)" : ""}`).join(" ")}`);
