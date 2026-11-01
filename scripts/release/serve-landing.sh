#!/usr/bin/env bash
# Serve the static landing build plus the release output on 127.0.0.1:19181 for independent landing /
# download testing (DIST-01..03). No Blackbox backend, database or login is involved.
#   serve-landing.sh [--port 19181] [--landing apps/landing/dist] [--release release/dist]
# Layout served:  /            → landing build (index.html, assets) plus, when release/dist exists, the
#                                release-manifest.json, archive, .sha256 and guides next to index.html
#                                (the landing fetches ./release-manifest.json and resolves the relative
#                                download_url against it, so the real manifest replaces the pending one)
#                 /release/    → the same release files under a fixed sub-path
#                 /INSTALL.en.md, /INSTALL.de.md → guides from the repository root
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PORT=19181; LANDING="$ROOT/apps/landing/dist"; RELEASE="$ROOT/release/dist"
while [ $# -gt 0 ]; do case "$1" in --port) PORT="$2"; shift 2;; --landing) LANDING="$2"; shift 2;; --release) RELEASE="$2"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
command -v python3 >/dev/null 2>&1 || { echo "python3 required for the static test host" >&2; exit 2; }
SITE="$(mktemp -d "${TMPDIR:-/tmp}/blackbox-landing.XXXXXX")"; trap 'rm -rf "$SITE"' EXIT
if [ -d "$LANDING" ]; then cp -R "$LANDING"/. "$SITE/"; else
  echo "warning: landing build not found at $LANDING — serving a placeholder index (build apps/landing first)" >&2
  printf '<!doctype html><meta charset="utf-8"><title>Blackbox landing placeholder</title><p>Landing build missing. Release manifest: <a href="release/release-manifest.json">release/release-manifest.json</a></p>\n' > "$SITE/index.html"
fi
mkdir -p "$SITE/release"
if [ -d "$RELEASE" ] && [ -f "$RELEASE/release-manifest.json" ]; then
  cp -R "$RELEASE"/. "$SITE/release/"
  # the released manifest + artifact next to index.html (relative download_url resolves against the manifest)
  for f in "$RELEASE"/*; do case "$(basename "$f")" in stage) ;; *) cp -R "$f" "$SITE/";; esac; done
else
  cp "$ROOT/release/release-manifest.template.json" "$SITE/release/release-manifest.json"
  cp "$ROOT/release/release-manifest.template.json" "$SITE/release-manifest.json"
  echo "no release/dist: serving the pending manifest (Download not available yet)" >&2
fi
cp "$ROOT/INSTALL.en.md" "$ROOT/INSTALL.de.md" "$SITE/" 2>/dev/null || true
echo "serving $SITE on http://127.0.0.1:$PORT/ (Ctrl-C stops; nothing else runs)"
cd "$SITE" && exec python3 -I -m http.server "$PORT" --bind 127.0.0.1
