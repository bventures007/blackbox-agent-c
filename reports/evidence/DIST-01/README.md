# DIST-01 — landing page download states (re-run 2026-11-01, archive 0.1.0 sha256 922d6517…)

Landing build `apps/landing/dist` (commit df8cfbb) served by `scripts/release/serve-landing.sh` on separate loopback
ports, each with its own manifest next to `index.html`. Captures by `scripts/verify/landing-capture.mjs` (headless
Chromium 1248; EN/DE; desktop 1440×1000 and mobile 390×844): `<state>-<locale>-<device>-{page,nav,hero,closing,release}.png`
plus `<state>-ctas.json` (the three CTA elements' href/aria-disabled/data-release and the release-card text).

| State | Port | Manifest | What the page shows (both locales, both viewports) | `verify-download.sh` |
| --- | --- | --- | --- | --- |
| released | 19181 | `release/dist/release-manifest.json` (status released, size 529,971,628, sha256 922d6517…) | three `<a>` CTAs "Download for Mac 0.1.0" / "Für Mac herunterladen 0.1.0" with `href` = `http://127.0.0.1:19181/blackbox-0.1.0-mac-arm64.tar.gz` (relative `./…` resolved against the manifest) and `download` attribute; release card with version, date, platform arm64, format, size 505.4 MiB, tested commit, prerequisites, SHA-256, release notes, "checksum is not a signature" note, guide link | PASS (`DIST-03/verify-download-released.txt`: bytes + sha256 match (earlier build f71210e8… of the same tree minus the wrapper guard; re-run against the final archive recorded in verify-download-released-final.txt), extracted, bundled doctor exit 0) |
| pending | 19188 | `release/release-manifest.template.json` | three disabled `<button>`s "Download for Mac · Download not available yet" / "… Download noch nicht verfügbar", `aria-disabled=true`, `data-release=pending`; release card "no released installation package … guide and demo stay available; nothing is substituted" | FAIL exit 2 "manifest status is 'pending'" |
| invalid-sha256 | 19187 | released manifest with a non-hex sha256 | three disabled buttons, `data-release=invalid`; card "The release information is incomplete or invalid; the download is disabled" | FAIL exit 2 (no artifact advertised) |
| wrong-sha256 | 19189 | released manifest with a well-formed but wrong sha256, real archive beside it | page cannot tell (metadata valid): released CTAs | FAIL exit 2 "sha256 mismatch (f71210e8… != 0000…0001)" — the release workflow catches it, the tester's `shasum` step catches it |
| artifact-404 | 19186 | released manifest whose `download_url` names a missing file | page cannot tell client-side: released CTAs; the click is an ordinary link navigation that the host answers with HTTP 404 (no fake download, no substitution) | FAIL exit 2 "artifact download failed" |

Real-browser pass (Claude built-in browser pane, Chromium): EN and DE at 1440 width — nav/hero/closing CTAs read
"Download for Mac 0.1.0" with the archive href; the release card shows version/date/platform/format/size/commit/
prerequisites/SHA-256; clicking the hero CTA (EN, 22:12:58 UTC) and the closing CTA (DE, 22:16:47 UTC) produced
`GET /blackbox-0.1.0-mac-arm64.tar.gz` 200 on the landing host (`/tmp/bb-landing-19181.log`). Limitation: the browser
pane does not persist downloads to disk, so the bytes used for the fresh install were fetched with `curl` from the exact
href read from the DOM (`DIST-02/download-fresh.txt` (archive #2) and `INSTALL-01/fresh-install.txt` (final archive 34139bb6…): bytes and sha256 equal to the manifest). The pending
state was also checked by hand in the pane in EN and DE (disabled buttons, truthful card).
