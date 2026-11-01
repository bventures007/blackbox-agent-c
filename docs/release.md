# Release archive: build, verify, distribute

Binding contract: `specs/WEB-DESKTOP-AND-DEPLOYMENT.md` ("Installable artifact and release metadata"), ADR-0005. Publishing images to a registry or the archive to a public location is **not authorized**; the bundled archive served from an authorized private/test endpoint is the distribution path for the pilot audience.

## What is bundled

`blackbox-<version>-mac-arm64.tar.gz` (top directory `blackbox-<version>/`):

| Path | Source | Notes |
| --- | --- | --- |
| `blackbox` | `scripts/blackbox` | host wrapper, executable bit set in the tar |
| `infra/compose/docker-compose.yml` | `infra/compose/docker-compose.yml` | image tags rewritten to `blackbox/<svc>:<version>`, PostgreSQL pinned by digest |
| `release.json` | `scripts/release/release.json.template` | compat manifest: version, date, tested commit, api/worker/engine/mcp/journal/event/reducer/projection/snapshot/backup-format/log versions, PostgreSQL major + image, image ids, `compatibility.{upgrade_from, binary_rollback_safe_to, runtime_protocols}` |
| `images/{api,worker,engine,backup,postgres}.tar` | `docker build` + `docker save` | arm64 only; omitted with `--skip-images` (then setup pulls/builds — not the advertised path) |
| `migrations/*.sql` | `packages/database/migrations` | for the SQL migrator fallback and `verify` |
| `INSTALL.en.md`, `INSTALL.de.md` | repo root | user guides |
| `examples/.env.example` | `infra/compose/.env.example` | non-secret config template with the version pinned |

Never included: `.env`, `secrets/`, `data/`, any key, runtime data or a preconfigured owner key. `check-manifest.sh` fails the build if such paths appear.

## Build

```sh
scripts/release/build.sh 0.1.0 [--download-url https://host/path/blackbox-0.1.0-mac-arm64.tar.gz] [--guide-url ...] [--notes notes.txt]
```

Steps: stage files → build the four images (`infra/docker/*.Dockerfile`, multi-stage, base images pinned by digest, non-root uid 10001, `BLACKBOX_VERSION`/`BLACKBOX_COMMIT` labels) → `docker save` → pull and save the pinned PostgreSQL image → render `release.json` → `tar.gz` without macOS xattrs → sha256 + byte size → `release/dist/release-manifest.json` → `check-manifest.sh`.

Outputs under `release/dist/` (generated, keep out of Git): archive, `.sha256`, `release-manifest.json`, `release.json`, guides. The committed `release/release-manifest.template.json` is the pending ("Download not available yet") manifest the landing build uses until a release exists.

## Landing manifest (consumed by apps/landing)

```json
{ "schema_version":"1", "status":"released|pending|preview", "version":"0.1.0", "date":"2026-11-01", "tested_commit":"<sha>",
  "artifact_filename":"blackbox-0.1.0-mac-arm64.tar.gz", "platform":"macOS Apple Silicon (arm64)", "architecture":"arm64",
  "format":"tar.gz", "byte_size":123, "sha256":"<64 hex>", "download_url":"./blackbox-0.1.0-mac-arm64.tar.gz",
  "guide_url":"./INSTALL.en.md", "guide_url_de":"./INSTALL.de.md",
  "prerequisites":{"container_runtime":"Docker Desktop 4.3x+ with Compose v2","min_os":"macOS 14","disk_free_gib":10,"network":"..."},
  "images_bundled":true, "signing":"none (SHA-256 checksum only; not signed or notarized)", "release_notes":"..." }
```

Rules the landing must follow: show download actions only when `status == "released"` and the fields validate; otherwise the localized "Download not available yet" state with demo/guide access; a `preview` status is labeled as preview; never infer other platforms; relative `download_url` resolves against the manifest location; a checksum is not a signing claim.

## Verify

- `scripts/release/check-manifest.sh release/dist/release-manifest.json` — fields, filename/version consistency, byte size and SHA-256 against the artifact, archive content list, `release.json` version/commit, compose pins, loopback bind, no secrets/runtime data (exit 2 on mismatch). Pending manifests pass only the shape check and must not advertise a URL.
- `scripts/release/serve-landing.sh` — serves `apps/landing/dist` + `release/dist` on `http://127.0.0.1:19181/` (python3 http.server, loopback) for DIST-01 testing without any Blackbox backend.
- `scripts/release/verify-download.sh http://127.0.0.1:19181` — DIST-03 helper: fetches the manifest, downloads the advertised artifact, checks size + SHA-256, extracts into a fresh directory and runs the bundled `doctor` (never installs). The real DIST-02/03 evidence additionally requires the browser download on a real Apple Silicon Mac, `./blackbox setup`, login and the first example answer; record OS/Docker/image versions, commands, hash and screenshots in `reports/`.
- `tests/ops/wrapper-unit.sh` covers the checker's negative cases.

## Promotion and immutability

A version is built once from a tested commit; rebuilding under the same version is not allowed (bump the patch version). A "latest" alias (if ever used on the serving host) is pointed at a version only after `check-manifest.sh`, `verify-download.sh` and the DIST-02 install journey passed for that exact artifact. Serve shared downloads over HTTPS; loopback test hosting may use HTTP. A private GitHub release or similar requires authenticated access and must be described as private pilot access, never as an anonymous public download; no token is ever embedded in the landing.

## Source-build fallback (developers only)

`scripts/blackbox setup` in a checkout (no `release.json` at the root) builds the images from source inside Docker (`compose --profile ops build`) and keeps its state under `<repo>/.local`. This is the documented fallback, not the advertised installation path.
