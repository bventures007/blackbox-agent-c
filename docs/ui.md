# Browser UI and landing page

Engineering reference for `apps/web` (local browser UI), `apps/landing` (independently servable landing page), `packages/i18n`, `packages/ui` and `tests/e2e`. User-facing copy is English by default with complete German; everything in this document and in code is English.

## Packages

| Path | Purpose | Build output |
| --- | --- | --- |
| `apps/web` | React 18 + Vite 5 + TypeScript single-page app. Calls the same-origin HTTP API from `docs/api-contract.md` (`/api/...`, `credentials: 'include'`, `X-Blackbox-CSRF` header on non-GET). No business calculation in components: every number, status and cutoff comes from an API envelope. | `apps/web/dist` (served by `apps/api` at `/`) |
| `apps/web/mock` | Development-only mock on `127.0.0.1:19189` (plain Node, no dependencies). **Stale since P2 verification:** it still answers in the pre-integration shapes (array `GET /api/questions`, `headline`/`rows` answers, `trace_siblings`, …). The UI and the Playwright suite follow the real `apps/api` contract (see "Contract alignment"); use the mock only to work on the shell/login/layout, or update it before relying on it. | — |
| `apps/landing` | Static landing page (Vite, vanilla TypeScript, relative `base`). Fetches `release-manifest.json` from its own directory at runtime; no backend, login or database. | `apps/landing/dist` (any static host) |
| `packages/i18n` | `en.json` / `de.json` (one `translation` namespace, ~1,450 keys each) plus `index.ts` (resources, `Locale`, Intl tags). `pnpm --filter @blackbox/i18n check` verifies key parity and empty values. | — |
| `packages/ui` | `styles/prototype.css` (unchanged copy of `reference/prototype/styles.css`: palette, typography, sidebar, recorder, cards, dialogs, drawers) and `styles/extensions.css` (login, filters, connection detail, review, diagnostics, settings, status badges, accessibility helpers). | — |
| `tests/e2e` | Playwright suite (projects `desktop` 1440×1000, `mobile` 390×844). | screenshots in `tests/e2e/screenshots/<locale>/` |

## Contract alignment (P4 verification against the real API)

The first Playwright run against the installed release stack showed that the views had been built against the mock's shapes. `apps/web/src/api/types.ts` now mirrors the real `apps/api` responses and `apps/web/src/api/adapters.ts` holds the only view-model derivations (pure reorganisation, no business values):

| Endpoint | Real shape the UI consumes | View-model derivation |
| --- | --- | --- |
| `GET /api/questions` | `{questions:[{id,intent,group,question,required_datasets,optional_datasets,params_schema,supported,readiness|null}]}`; `params_schema.properties.<name>.required` + `required[]`; real parameter names (`item_id`, `requested_quantity`, `order_id`, `payout_id`, …) | `readiness: null` → `not_applicable`. Entity parameters are recognised by name (`ENTITY_PARAMS` in `QuestionsView`) and offer the literal `GET /api/search` as disambiguation (distinct `entity_refs[type]` of matching entries). |
| `POST /api/questions/:intent` | engine envelope `{status: complete|partial|unknown|conflict|unsupported, result:{…typed fields…}, calculation:[{step,formula,values}], evidence_refs:["journal:<entry_id>"], entry_ids, missing_inputs, conflicts, coverage:{datasets_present,datasets_missing,population,…}, consistency:{applied_cursor,required_cursor,reducer_version,status,recorded_cutoff,effective_cutoff,mode}, readiness:{status,required,optional,missing,missing_optional,reasons,sources}, page}` | `AnswerPanel` renders scalar result fields as a definition list, array fields as tables, calculation steps as formula + values, `journal:` refs as citations that open the entry drawer. Headline per intent is a field pick (`HEADLINE`), e.g. `available` for `inventory.available_to_sell`. `unknown` is the engine's "insufficient data" status. |
| `GET /api/entities/:type/:id/state` | `{entity, state:{…projection fields, status, links, last_sequence}, tracks:{<track>:{entries,total,truncated}}, evidence_refs, entry_ids, coverage, conflicts, status, missing_inputs, consistency, readiness}` | `EntityView` labels `*_minor` fields as money in `state.currency`, numeric strings as quantities in `state.unit`; `POSITIONS` picks the prominent fields per type (reference 35–45). |
| `GET /api/journal/:id` | `{entry, supersedes, superseded_by[], derived_from[], derivations[]}`; `entry.evidence_refs` are evidence ids | `EvidenceBox` loads `GET /api/evidence/:id` → `{status, evidence:{kind,media_type,byte_size,received_at,evidence_class}, content, content_encoding}`. |
| `GET /api/journal` / `/api/search` | `consistency:{committed_cursor, snapshot_cursor}` (cursors only; no status) | shown as "committed cursor · snapshot cursor". |
| `GET /api/sources` | `{catalogue:[{provider,name,category: connector|producer,state,capabilities:[{id,state,…,coverage_state,connection_id}],connections:[connections row]}], readiness_observed_at}`; connection `status` ∈ configured/validating/backfilling/catching_up/paused/disconnected; capability `state` ∈ healthy/working/degraded/unavailable/unknown/paused | `adaptCatalogue`: presentation category per provider (`PROVIDER_META`), connect dialog kind, `last_*`/`next_check_*` aggregated over the connection's capabilities, `demo` from `account_ref` `demo:*`. Providers from the register that the API does not list are appended as `planned` (`PLANNED_PROVIDERS`); the internal `runtime` row is hidden. |
| `GET /api/sources/connections/:id` | `{connection, health:[capability_health rows], import_plan, import_plan_proposal, runs:[{run_id,kind: backfill|incremental|reconcile|check,phase,state,counters{…,duplicates,conflicts,rejected},totals_known,percent,attempt,poll_group,capability_scope,error_code,next_action}], readiness:[per-question readiness touching this connection]}` | `aggregateHealth` (max/min timestamps, summed counters, union of limitations); the view also shows the per-capability table. |
| `POST /api/sources/connections` | `{connection, producer?:{producer_id,secret,notice}}` | generic producers show the signing secret once in the dialog. |
| `POST /api/demo/run` | `{connections, run_id, accepted, duplicate, conflict, rejected, committed_cursor, checkpoints}`; `409 confirmation_required` when non-demo connections already hold data | Recorder asks for a second confirmation and resends `{confirm:true}`. |
| `GET /api/review/cases` | `{cases:[{case_id,connection_id,run_id,type,state,revision,reason,refs,history,resolution_entry_id,…}]}` | `adaptReviewCase`: available actions follow the case type (link cases → confirm/reject/correct/leave open; others → retry/correct/leave open), affected records from `refs`. |
| `GET /api/diagnostics/health` | `{cards:[{area,state,observed_at,reason,next_action,details}], observed_at, refresh_interval_seconds, stale_after_seconds}` | stale threshold from `stale_after_seconds`; the backups/review strip uses `GET /api/settings/backups` and the workspace. |
| `GET /api/diagnostics/logs/:id` | `{record, siblings}` | — |
| `POST /api/diagnostics/export` | categories `versions`, `health`, `errors`, `logs`; preview adds `records` | — |
| `GET /api/settings/storage`, `/api/diagnostics/storage` | `{thresholds:{warn_percent,warn_min_bytes,critical_percent,critical_min_bytes,log_cap_bytes,log_retention_days}, volumes:{evidence,logs,snapshots:{total_bytes,free_bytes,state}}, evidence:{bytes,available}, logs:{bytes,cap_bytes,retained_from,retained_to,files,dropped_count,state}}`; PATCH takes the flat threshold fields | — |
| `GET /api/settings/retention` | `{default_days, classes:{<class>:{days,source}}}`; PATCH takes `{<class>: days}` | — |
| `GET /api/settings/security` | `{counts:{"owner.login":n,…}, last_events:[{occurred_at,event,actor_kind,channel}]}` | — |
| `GET /api/agents/mcp-config` | `{transport:"stdio", command, args, env, snippet, notes}` | — |

Status vocabularies are rendered as returned (localized labels in `sourceState`, `answerStatus`, `runKind`, `lifecycle`, …; unknown values fall back to the raw string, never to a friendlier claim).

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

Polling (`hooks.ts` `useAsync`): a tick is skipped while the previous request is still in flight and while the tab is hidden, so a slow backend never accumulates overlapping health/journal/source polls (bounded overhead; observed during the P4 run on an overloaded host).

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

`release-manifest.json` is fetched from the same directory as `index.html`; a relative `download_url`/`guide_url` resolves against the manifest URL (so `scripts/release/serve-landing.sh` places the released manifest and archive next to `index.html`, replacing the pending manifest shipped in `public/`). Fields: `status released|pending`, `version`, `date`, `tested_commit`, `artifact_filename`, `platform`, `format`, `byte_size`, `sha256`, `download_url`, `guide_url`, `app_url`, `prerequisites{container_runtime,min_os}`, `release_notes`) drives all three download CTAs (nav, hero, closing) and the metadata card. Validation: `released` requires every field, a 64-hex SHA-256, a positive size, HTTPS (or localhost) download URL and an arm64/Apple-Silicon platform; otherwise the page shows “Download not available yet / Download noch nicht verfügbar” with the guide and demo still reachable. A fetch failure shows the failed state with a retry. The “Open the demo” action points to `app_url` (default `http://127.0.0.1:19180/`) and is labeled as requiring a local installation. The shipped `public/release-manifest.json` is the honest `pending` state until the P4 release workflow publishes a tested artifact.

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
| `02-demo-question.spec.ts` | the tester journey first: run the demo (second confirmation when non-demo data exists), ask `order-01` with the literal entity lookup → `complete` answer equal to the GOLDEN checkpoint (available 112), formula steps, citations, evidence drawer with raw evidence, data status (EN + DE, `22-answer-inventory`, `30-evidence-drawer`); unknown item → status `unknown` with the missing basis (`28-answer-unknown`); invoice/payment entity views (`35`, `39`); needs review: two equal unmatched payouts via the replay dialog + an ambiguous bank CSV credit open a real `ambiguous_bank_match` case, confirmed with a revision-safe decision (`64-needs-review`). |
| `03-views.spec.ts` | every view in EN and DE on the demo data: key texts/controls, bounding boxes of essential controls inside the viewport, full-page screenshots (`08-recorder`, `11-sources`, `16-connect-shopify`, `65-import-plan`, `61-connection-detail` after persisting a real "last 30 days" plan, `21-answers-empty`, `29-event-src-001`, `56-journal`, `46-agents`, `47-agent-key-shown`, `62-system-diagnostics`, `63-settings`, `-mobile` suffix for the mobile project), keyboard navigation of the main nav (incl. mobile drawer) and of the demo dialog. |
| `04-diagnostics.spec.ts` | warnings preset, component filter and literal search derived from the first real warning (AND/OR semantics asserted on the returned rows), record drawer with trace siblings, clear filters; live SSE mode, pause freezes the table with a new-record counter, resume merges; debug minutes clamp to 15 with expiry and stop; export preview; “View logs” deep link applies the connection filter. |
| `05-landing.spec.ts` | landing served from `LANDING_URL` in EN/DE: three CTAs from one manifest (released metadata incl. checksum/arm64, or disabled truthful unavailable state), guide commands, demo action to the local app URL, no signup/forms, no embedded credentials (`01-landing`). |

The suite is specified against the real `apps/api` (`E2E_NO_MOCK=1 BASE_URL=http://127.0.0.1:19180 LANDING_URL=http://127.0.0.1:19181/ BLACKBOX_E2E_KEY=<owner key> pnpm --filter e2e test`, landing served by `scripts/release/serve-landing.sh`). Evidence of the runs against the installed release is under `reports/evidence/E2E/` and `reports/evidence/UI-01/`. The mock no longer satisfies the suite (see Packages).

## Known limitations

- The mock API returns fixture-shaped answers for the GOLDEN scenario; non-demo questions return `complete` with empty rows or `insufficient_data`. Real values come from the Rust engine through `apps/api`.
- Key rotation: the real API revokes the previous verifier and all owner sessions (verified with `curl` in `reports/evidence/results-ui.json`, LOCAL-06); the suite does not rotate because the owner key under test must stay valid.
- The question UI is generic over the engine envelope: every intent renders its typed result fields, calculation steps and citations; only `inventory.available_to_sell` has a dedicated headline sentence. Localized labels exist for the fields of the demo entities; other field names fall back to their raw engineering names.
- No native packaging, passkeys, employee management or public hosting exists in the UI (deferred per LOCAL-PILOT.md).
