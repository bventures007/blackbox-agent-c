# Browser UI and landing page

Engineering reference for `apps/web` (local browser UI), `apps/landing` (independently servable landing page), `packages/i18n`, `packages/ui` and `tests/e2e`. User-facing copy is English by default with complete German; everything in this document and in code is English.

## Packages

| Path | Purpose | Build output |
| --- | --- | --- |
| `apps/web` | React 18 + Vite 5 + TypeScript single-page app. Calls the same-origin HTTP API from `docs/api-contract.md` (`/api/...`, `credentials: 'include'`, `X-Blackbox-CSRF` header on non-GET). No business calculation in components: every number, status and cutoff comes from an API envelope. | `apps/web/dist` (served by `apps/api` at `/`) |
| `apps/web/mock` | Development-only mock of the API contract on `127.0.0.1:19189` (plain Node, no dependencies). Contract-shaped fixtures for every endpoint the UI calls; never bundled into `dist`. Mock-only extra: `POST /api/_mock/reset`. | — |
| `apps/landing` | Static landing page (Vite, vanilla TypeScript, relative `base`). Fetches `release-manifest.json` from its own directory at runtime; no backend, login or database. | `apps/landing/dist` (any static host) |
| `packages/i18n` | `en.json` / `de.json` (one `translation` namespace, ~1,450 keys each) plus `index.ts` (resources, `Locale`, Intl tags). `pnpm --filter @blackbox/i18n check` verifies key parity and empty values. | — |
| `packages/ui` | `styles/prototype.css` (unchanged copy of `reference/prototype/styles.css`: palette, typography, sidebar, recorder, cards, dialogs, drawers) and `styles/extensions.css` (login, filters, connection detail, review, diagnostics, settings, status badges, accessibility helpers). | — |
| `tests/e2e` | Playwright suite (projects `desktop` 1440×1000, `mobile` 390×844). | screenshots in `tests/e2e/screenshots/<locale>/` |

## Routes and views (`apps/web/src/views`)

| Route | View | API endpoints | Reference |
| --- | --- | --- | --- |
| `/login` | `LoginView` — key input (show/hide), “Stay signed in on this computer”, owner-access warning (never share with agents), localized errors (invalid 401, throttled 429, origin 403), link to the landing/guide. | `POST /api/auth/login`, `GET /api/auth/session` | spec IDENTITY-ACCESS §Login |
| `/app` | `RecorderView` — five tracks with latest entries, stats, question shortcuts with readiness, recent activity, source readiness, “Run the example (demo)”, “Connect a source”. | `GET /api/journal`, `GET /api/sources`, `GET /api/questions`, `POST /api/demo/run` | 08–10 |
| `/app/sources` | `SourcesView` — connected-connections table (degraded first), catalogue grouped shops/payment/billing/shipping/other with state badges `implemented|configured|syncing|degraded|unsupported|planned`, capability schedules/limitations, connect dialogs (`ConnectDialog`: shopify, shopify_payments, generic signed API, bank CSV with preview-before-commit, replay), `ReviewList` (“Needs review”). | `GET /api/sources`, `POST /api/sources/connections`, `POST /api/ingest/bank-csv?preview=1`, `POST /api/ingest/replay`, `GET/POST /api/review/cases` | 11–20 |
| `/app/sources/:id` | `ConnectionView` — health (last successful check vs last new event, next check + reason, cursors, coverage, limitations), import plan (presets last 30 days / this year / last 12 months / custom / from now, IANA timezone, resolved boundaries shown in the plan timezone and UTC), runs with counters/phase/percent only when totals are known, pause/resume/disconnect, “View logs” deep link. | `GET /api/sources/connections/:id`, `POST .../import-plan`, `POST .../runs`, `POST .../pause|resume|disconnect` | IMPORT spec §4–5 |
| `/app/questions` | `QuestionsView` — six groups × four templates from `GET /api/questions`, typed parameter form generated from `params_schema` (`x-entity` fields get explicit disambiguation through `GET /api/search`), result envelope rendering (`AnswerPanel`: status, headline, calculation steps, result table, warnings, missing inputs, conflicts, evidence citations + evidence drawer, cutoffs/cursors, coverage, shared `ReadinessSummary`), search box labeled “search only — not a chat” (`GET /api/questions/search`). | `GET /api/questions`, `POST /api/questions/:intent`, `GET /api/questions/search`, `GET /api/search`, `GET /api/evidence/:id` | 21–28, 46 |
| `/app/journal`, `/app/journal/:entryId` | `JournalView` — filters (track, event type, record id, entity, occurred/recorded ranges, URL-persisted), cursor pagination, JSON export, `EntryDrawer` (payload, evidence excerpt, supersedes/superseded-by/input/derived links, entity links). | `GET /api/journal`, `GET /api/journal/:id` | 56–58, 29–34 |
| `/app/entities/:type/:id` | `EntityView` — lifecycle state, positions (e.g. outstanding / at provider / in transit / bank-matched), fields, semantics note, readiness, complete history. | `GET /api/entities/:type/:id/state`, `.../history` | 35–45 |
| `/app/agents` | `AgentsView` — grant meaning, create named key (shown once), list with status/last use/expiry/revoke, copyable stdio MCP config, client notes, local-only reachability, tool list. | `GET/POST /api/agents`, `POST /api/agents/:id/revoke`, `GET /api/agents/mcp-config` | 46–49 |
| `/app/system` | `SystemView` — seven health cards (observed_at, reason, next action; stale > 30 s and disconnected states; 5 s refresh while open), backups/review/maintenance/debug strip, logs (exact levels + “Warnings & errors” preset, min level, time range default last hour, component, provider, connection, run, trace, literal search; AND across dimensions / OR within), live SSE mode with pause + new-record counter, cursor pagination, record drawer with trace siblings and copy-safe action, debug controls (≤ 15 min, expiry countdown, stop), export dialog with preview (categories, range, size, truncation) and download, storage/retention/dropped counts. Filters live in component state; the URL only carries opaque IDs from deep links. | `GET /api/diagnostics/*`, `GET /api/diagnostics/logs/stream` (SSE) | SYSTEM-AND-DIAGNOSTICS.md |
| `/app/settings` | `SettingsView` — workspace name/locale, Backups & recovery (states not configured/scheduled/running/failed/overdue, last generation/cutoff, recoverable age, next due, same-device warning, last restore test, “request backup” to the enrolled destination), retention per evidence class with bounds, storage thresholds, security audit summary, key rotation (re-enter current key, new key once), lifecycle text. | `GET/PATCH /api/settings/*`, `POST /api/auth/rotate-key`, `PATCH /api/workspace` | PILOT-OPERATIONS §1,4,5 |

Shared pieces: `components/AppShell.tsx` (sidebar, mobile drawer, top bar with runtime status + locale switch, toast), `components/ui.tsx` (status badges with symbol + text, modal/drawer with focus trap and Escape, error note, copy button), `components/ReadinessSummary.tsx`, `components/EntryDrawer.tsx`, `format.ts` (Intl date/number/money/quantity/bytes/relative per locale), `hooks.ts` (`useAsync` with polling).

## Locale handling

- `apps/web/src/i18n.ts` initialises i18next with `@blackbox/i18n` resources. Initial language: `localStorage['blackbox.locale']` → browser language → `en`.
- After login the server-persisted `workspace.locale` applies; changing the language in the shell or Settings calls `PATCH /api/workspace {locale}` and stores the preference locally. localStorage holds only this preference — never keys, sessions or business data.
- `document.documentElement.lang`, `<title>` and the description meta tag follow the active locale.
- Formatting uses `Intl` with `en-GB` / `de-DE`. Timestamps from the API are rendered in the browser timezone; import plans additionally show the plan's IANA timezone and UTC.
- Raw engineering strings (event names, error codes, log messages) stay English; known events get localized explanations (`logEvents`, `healthReasons`, `answerSummaries`, …).

## Accessibility

Keyboard-operable navigation and dialogs (focus trap, Escape, focus restore), `aria-current`/`aria-pressed`/`aria-expanded` where applicable, skip link, labels on every control, status never by color alone (badge symbol + text), `role="alert"`/`aria-live` for errors and answers, mobile nav drawer with `aria-expanded`/`aria-controls`, horizontal scrolling tables on narrow screens.

## Landing page

`apps/landing/src/main.ts` renders hero, release card, flight-window illustration, principle/tracks/questions/agents sections, EN/DE installation guide (download/extract, prerequisites Docker Desktop ≥ 4.3x / Compose v2, `./blackbox doctor`, `./blackbox setup`, `./blackbox up`, save the key, open `http://127.0.0.1:19180`, stop/restart/update without data loss, where logs live), closing CTA and footer. Language toggle persists to localStorage (`?lang=de` also works). No signup, no forms, no embedded credentials.

`release-manifest.json` (fields: `status released|pending`, `version`, `date`, `tested_commit`, `artifact_filename`, `platform`, `format`, `byte_size`, `sha256`, `download_url`, `guide_url`, `app_url`, `prerequisites{container_runtime,min_os}`, `release_notes`) drives all three download CTAs (nav, hero, closing) and the metadata card. Validation: `released` requires every field, a 64-hex SHA-256, a positive size, HTTPS (or localhost) download URL and an arm64/Apple-Silicon platform; otherwise the page shows “Download not available yet / Download noch nicht verfügbar” with the guide and demo still reachable. A fetch failure shows the failed state with a retry. The “Open the demo” action points to `app_url` (default `http://127.0.0.1:19180/`) and is labeled as requiring a local installation. The shipped `public/release-manifest.json` is the honest `pending` state until the P4 release workflow publishes a tested artifact.

Note: ADR-0005 mentioned reading the manifest at build time; the implemented contract (per the UI brief) fetches it at runtime so the same build can be pointed at a new release by replacing one JSON file next to `index.html`.

## Commands

```sh
pnpm install                                  # workspace install
pnpm --filter @blackbox/i18n check            # locale parity
pnpm --filter web typecheck && pnpm --filter web build        # apps/web/dist
pnpm --filter landing typecheck && pnpm --filter landing build  # apps/landing/dist
pnpm --filter web mock                        # mock API on 127.0.0.1:19189 (BLACKBOX_E2E_KEY optional)
pnpm --filter web dev                         # Vite dev server on 127.0.0.1:19180, /api proxied to the mock
pnpm --filter landing dev                     # landing on 127.0.0.1:19181
pnpm e2e                                      # build web + landing, start mock/previews, run Playwright (desktop + mobile)
```

Environment for the e2e suite: `BLACKBOX_E2E_KEY` (owner key; the mock defaults to `bbk_demo_000…`), `BASE_URL` (default `http://127.0.0.1:19180`), `LANDING_URL` (default `http://127.0.0.1:19181/`), `E2E_NO_MOCK=1` to run against an already running real backend/landing host (no servers are started, the mock reset is skipped). `BLACKBOX_API_PROXY` changes the Vite dev/preview proxy target. First run: `pnpm --filter e2e install-browsers`.

## Playwright coverage (`tests/e2e/tests`)

| File | Covers |
| --- | --- |
| `01-auth.spec.ts` | invalid key error, no key in localStorage, login with `BLACKBOX_E2E_KEY`, remembered session across reload (HttpOnly cookie), German login copy, logout. |
| `02-views.spec.ts` | every view in EN and DE: key texts/controls, bounding boxes of essential controls inside the viewport, full-page screenshots (`08-recorder`, `11-sources`, `16-connect-shopify`, `61-connection-detail`, `65-import-plan`, `21-answers-empty`, `29-event-src-001`, `56-journal`, `46-agents`, `47-agent-key-shown`, `62-system-diagnostics`, `63-settings`, `-mobile` suffix for the mobile project), keyboard navigation of the main nav (incl. mobile drawer) and of the demo dialog. |
| `03-demo-question.spec.ts` | run the demo, ask `order-01` (`inventory.available_to_sell`) with entity lookup → `complete` result with calculation, citations, evidence drawer and data status (EN + DE, `22-answer-inventory`, `30-evidence-drawer`); unknown item → `insufficient_data` with missing inputs; invoice/payment lifecycle views (`35`, `39`); revision-safe review action (`64-needs-review`). |
| `04-diagnostics.spec.ts` | warnings preset, component filter, literal search, record drawer with trace siblings, clear filters; live SSE mode, pause with new-record counter, resume; debug minutes clamp to 15 with expiry and stop; export preview; “View logs” deep link applies the connection filter. |
| `05-landing.spec.ts` | landing served from `LANDING_URL` in EN/DE: three CTAs from one manifest (released metadata incl. checksum/arm64, or disabled truthful unavailable state), guide commands, demo action to the local app URL, no signup/forms, no embedded credentials (`01-landing`). |

Results against the mock are recorded in the handover report; they prove the UI contract and interaction behavior, not backend correctness. The same suite runs unchanged against the real `apps/api` once it serves `dist/` on 19180 (`E2E_NO_MOCK=1 BLACKBOX_E2E_KEY=<key> pnpm --filter e2e test`).

## Known limitations

- The mock API returns fixture-shaped answers for the GOLDEN scenario; non-demo questions return `complete` with empty rows or `insufficient_data`. Real values come from the Rust engine through `apps/api`.
- Key rotation in the mock keeps the same key so e2e logins keep working; the real API invalidates the old key and all sessions.
- No native packaging, passkeys, employee management or public hosting exists in the UI (deferred per LOCAL-PILOT.md).
