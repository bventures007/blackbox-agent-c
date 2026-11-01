# ADR-0005 Local release, archive and distribution

Status: accepted (P0)

- Release = `blackbox-<version>-mac-arm64.tar.gz` containing `blackbox` wrapper, `infra/compose/docker-compose.yml` with pinned image tags/digests, `images/*.tar` (prebuilt arm64 images for api, worker, engine; PostgreSQL pulled from Docker Hub `postgres:16.x` pinned by digest), `release.json`, `INSTALL.en.md`/`INSTALL.de.md`. `./blackbox setup` loads bundled images (`docker load`) so no Git clone or toolchain is needed. Publishing images to a public registry is not authorized; the bundled tarballs are the accessible prebuilt images for the private pilot audience.
- Landing page: static build (`apps/landing`, output `dist/landing`) reads `release-manifest.json` at build time; download CTA links the archive URL from the manifest; shows "Download not available yet" when status != released.
- Distribution proof: landing served by an independent static host on 127.0.0.1:19181, archive downloaded through a real browser into a fresh folder, SHA-256 compared with the manifest, installed with the bundled wrapper.
- Compose project `blackbox-agent-c`; host port 127.0.0.1:19180 only; volumes `pgdata`, `evidence`, `logs`, `snapshots`; secrets in `<install>/secrets` (0700).

Alternatives: public GitHub release (not authorized); native DMG (deferred).
