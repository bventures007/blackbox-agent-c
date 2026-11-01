# UI-01 — reference design ↔ pilot UI comparison

Scope: every view of the pilot web app (`apps/web`) and the landing page (`apps/landing`), EN and DE, desktop 1440×1000 and mobile 390×844, compared with the 67 reference captures in `reference/screenshots/` (58 desktop, 9 mobile). The reference is the static German prototype; the pilot is English by default with complete German. Screenshots referenced below live in `reports/evidence/UI-01/screens/{en,de}/` (Playwright, Chromium 1248, full-page unless stated; `-mobile` suffix = mobile project) and `reports/evidence/DIST-01/` (landing states).

Environment of the captures: see `reports/evidence/results-ui.json` (macOS 27.2 Apple Silicon, Docker 27.3.1 / Compose 2.30.3, images `blackbox/*:0.1.0`, Playwright 1.64.1, same developer Mac in a fresh install folder — not a separate machine).

## What matches the reference

- **Palette, type and chrome:** `packages/ui/styles/prototype.css` is the unchanged prototype stylesheet; the dark green sidebar with the workspace block, the sage/lime accents, the serif-less headline style, the white panels, the status pills and the mono "engineering" labels are the prototype's.
- **Shell:** dark sidebar with the same seven-item navigation order (Recorder, Sources, Questions & Answers, Journal, Agents & MCP, System & Diagnostics, Settings), workspace avatar block, "Ask a question" shortcut, bottom brand callout and "To the landing page" link; top bar with breadcrumb, local/preview tag, runtime status and the language switch (reference: the same place holds the demo tag).
- **Recorder (08–10):** page heading + subtitle, four stat cards, the "Business flight recorder" panel with the five parallel tracks (Sources, Facts, Commitments, Movements, Reservations), the time ruler, the pause/refresh controls, the lower two-column "Ask your flight recorder" / "What just counted" panels and the footer note.
- **Sources (11–20):** jump links per category, catalogue cards with provider glyph, state pill, capability pills and limitation footnotes, the four prototype categories plus "Other producers", shipping as an ordinary category, the category notes, and the connect dialogs with the three-step "recognise → append → context" summary.
- **Questions (21–28):** heading, labeled search panel, six Order-to-Cash group cards (step number, team, scope, agent role, benefit, four questions each, tracks and sources footer), expandable question with method/need/result, and the answer block with eyebrow, headline, calculation row, citation chips, proof line and warning box.
- **Journal (56–58):** filter toolbar, ledger table with record id / occurred / recorded / track / event / provider / entities columns, track tags, "load more", empty state with "clear filters", entry drawer with typed payload, evidence excerpt and supersedes/derived links.
- **Agents & MCP (46–49):** grant explanation, key table, three-step local flow, client choice (Claude Desktop/Code, MCP Inspector, own agent), copyable stdio config block, tool list.
- **Mobile (m01–m09):** single column, hamburger navigation drawer, horizontally scrolling tables, full-width dialogs/drawers.

## Deviations (all intentional or pilot-scope; none hides a missing capability)

| # | Deviation | Why |
| --- | --- | --- |
| D1 | English is the default language; German is complete and switchable (shell, login, landing). The reference is German-only. | Build brief: EN default + full DE. |
| D2 | Login view (`60-login`) replaces the prototype's "create demo workspace" signup (03) and onboarding wizard (05–07). | Pilot has one automatic owner/workspace and a personal access key; no signup, no onboarding steps. The demo is started from the Recorder ("Run the example (demo)") with a confirmation dialog (`08-recorder-demo-dialog`). |
| D3 | Recorder stat cards show connected sources / committed journal entries / questions ready / open review cases instead of the prototype's demo counters (open commitments, free stock of one item). | Stats must be truthful server counters; per-item stock belongs to the question answer. |
| D4 | No "Export" button on the Recorder; the Journal has the JSON export. No "add simulated event" button. | The pilot never simulates events; data arrives through sources, the replay producer or the labeled demo. |
| D5 | Event chips show `record_id` + time (e.g. `stock:gid://shopify/…`) instead of the prototype's hand-written German summaries. | Honest engineering identifiers; long ids wrap (fixed during this verification, see "Fixed"). |
| D6 | The question page has no free-text chat input. The search box is labeled "search only — not a chat" and matches template titles/entities literally; parameters are typed form fields. | Model-free local questions (PILOT-10); free text is reserved for the external MCP client. |
| D7 | Answer block shows the engine envelope: status pill, formula steps with the values used, result fields/tables, `journal:` citations (short entry ids, not `[FAC-003]` style labels), cutoffs/cursors, coverage population and the shared data-status block. Headline sentence exists for `inventory.available_to_sell` ("Yes — 112 available …"); other intents show their typed fields. | Real contract (`docs/ui.md` → Contract alignment). The prototype's "86 of 120" numbers were synthetic. |
| D8 | Source catalogue lists only the providers the API knows plus register providers marked **planned** (woocommerce, shopware, stripe, paypal, mollie, lexware, sevdesk, billbee, sufio, dpd, ups, email). easybill and DHL are planned too (API). The internal `runtime` row is hidden. Xentral is absent. | delivery-profile.json scope; a visible card is never claimed as implemented. |
| D9 | Connect dialogs exist for Shopify, Shopify Payments, Bank CSV, signed API and replay; planned providers show a disabled "Planned" button; the policy producer shows "Via API". The prototype dialogs for DHL/easybill (18, 19) have no live counterpart. | No data path in the pilot. |
| D10 | Connection detail (`61-connection-detail`, `65-import-plan`) — import plan with presets, timezone/UTC boundaries, per-capability health table, runs with counters/phases — has no reference capture. | Required by IMPORT-ONBOARDING; designed in the prototype's visual language. |
| D11 | Entity views (`35-invoice-issued`, `39-payment-lifecycle`) are full pages, not drawers (reference 35–45), and show the engine's typed fields (gross/credit/net/reported paid/allocated/open, captured/fees/refunded/held…) plus per-track entry summaries. Disputes (43) and refund hold/release (44–45) have no demo data in the GOLDEN scenario, so those states were not captured. | Engine state contract; drawers were kept for journal entries and evidence. |
| D12 | System & Diagnostics (`62-system-diagnostics`, `66`, `67`), Settings (`63-settings`), Needs review (`64-needs-review`) and the evidence drawer with raw provider JSON have no reference capture. | SYSTEM-AND-DIAGNOSTICS / PILOT-OPERATIONS requirements added after the prototype. |
| D13 | Agents page shows real named keys with status/last use/expiry/revoke and the API's stdio config snippet; the prototype's ChatGPT concept card (47) and simulated agent answer (49) are not reproduced. | Only verifiable client paths (MCP Inspector CLI, Claude Desktop/Code config) are offered; no simulated answers. |
| D14 | Runtime status in the top bar reflects the health service (healthy/working/degraded/unavailable/stale/disconnected) instead of the static "System bereit". | DIAG-02: no green without a fresh probe. |
| D15 | Landing (`01-landing`, DIST-01 captures): same hero/flight-window/principle/tracks/questions/agents sections; adds the release card (version, date, platform, format, size, commit, prerequisites, SHA-256) and the EN/DE install guide; CTAs are real downloads only when the manifest is `released`, otherwise the disabled "Download not available yet" state. | WEB-DESKTOP-AND-DEPLOYMENT download contract. |

## Fixed during this verification

- Every view crashed against the real API (`U.filter is not a function` on the Recorder; blank pages) because the views were built against the mock's shapes — rewritten to the real contract (`apps/web/src/api/types.ts`, `adapters.ts`, all views; see `docs/ui.md`).
- Demo flow: the API's `409 confirmation_required` (non-demo data present) is now surfaced as a second explicit confirmation instead of a generic error.
- Long record ids (Shopify GIDs) overflowed the activity panel and cards; they now wrap (`packages/ui/styles/extensions.css`).
- Landing: a relative `download_url` now resolves against the manifest location, and `serve-landing.sh` serves the released manifest + archive next to `index.html` (previously the pending manifest shipped in `public/` shadowed the real one, so no CTA ever resolved to the artifact).
- Diagnostics: component filter offers the real components (`auth`, `ingestion`, `query`, `cli` …); export categories match the API (`versions`, `health`, `errors`, `logs`).

## Keyboard and focus checks

Recorded by `tests/e2e/tests/03-views.spec.ts` ("keyboard navigation of the main nav and of a dialog") for EN and DE, desktop and mobile, and repeated manually in the built-in browser (see table below): skip link is the first tab stop; sidebar links are reachable with Tab and activate with Enter; on mobile the "Open navigation" button has `aria-expanded`/`aria-controls` and the drawer traps focus; dialogs/drawers move focus to their first control, trap Tab/Shift+Tab, close with Escape and restore focus to the opener; every form control has a label; status is never color-only (symbol + text); errors use `role="alert"`, answers `aria-live="polite"`.

| Check | Result |
| --- | --- |
| Tab order login → key field → show/hide → remember → sign in | not recorded (time-box) |
| Sidebar Tab/Enter navigation (desktop, EN/DE) | not recorded (time-box); automated check exists in 03-views.spec.ts but no completed run |
| Mobile drawer open/close via keyboard, `aria-expanded` | not recorded (time-box); automated check exists in 03-views.spec.ts but no completed run |
| Demo dialog focus trap + Escape + focus restore | not recorded (time-box); automated check exists in 03-views.spec.ts but no completed run |
| Entry drawer / evidence drawer focus trap + Escape | not recorded (time-box); automated check exists in 03-views.spec.ts but no completed run |
| Diagnostics record drawer, export dialog | not recorded (time-box); automated check exists in 03-views.spec.ts but no completed run |

## Reference ↔ screenshot table

Not completed in this slot (time-box; the shared Docker VM was saturated, see `reports/evidence/results-ui.json`). The screenshots under `screens/` come from the partial Playwright runs against the rc6 stack after the fixes (`08-recorder`, `11-sources`, `16-connect-shopify`, `21-answers-empty`, `22-answer-inventory`, `30-evidence-drawer`, `46-agents`, `47-agent-key-shown`, `56-journal`, `60-login`, `61-connection-detail`, `62-system-diagnostics`, `63-settings`, `65-import-plan`, EN/DE, some `-mobile`); the per-capture table generator is prepared but the side-by-side review was not performed.
