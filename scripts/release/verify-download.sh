#!/usr/bin/env bash
# DIST-03 helper: from an independently served landing page, fetch the release manifest, download the
# exact advertised artifact, verify size + SHA-256, extract into a fresh directory and run the bundled doctor.
#   verify-download.sh <landing-base-url> [--manifest-path release/release-manifest.json] [--out <fresh-dir>]
# Nothing is installed or started; `doctor` never installs anything. Exit 0 pass, 2 fail.
set -euo pipefail
BASE="${1:-}"; [ -n "$BASE" ] || { echo "usage: verify-download.sh <landing-base-url> [--manifest-path p] [--out dir]" >&2; exit 2; }
shift; MPATH="release/release-manifest.json"; OUT=""
while [ $# -gt 0 ]; do case "$1" in --manifest-path) MPATH="$2"; shift 2;; --out) OUT="$2"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
BASE="${BASE%/}"
OUT="${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/blackbox-download.XXXXXX")}"; mkdir -p "$OUT"; [ -z "$(ls -A "$OUT")" ] || { echo "out dir not empty: $OUT" >&2; exit 2; }
fail() { echo "verify-download: FAIL $*" >&2; exit 2; }
get() { grep -o -E "\"$1\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|[^,}[:space:]]+)" "$OUT/release-manifest.json" | head -n1 | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*//; s/^"//; s/"$//'; }

echo "landing: $BASE  manifest: $MPATH  out: $OUT"
curl -fsSL --max-time 30 "$BASE/$MPATH" -o "$OUT/release-manifest.json" || fail "manifest not downloadable from $BASE/$MPATH"
STATUS="$(get status)"; [ "$STATUS" = "released" ] || fail "manifest status is '$STATUS' (no released artifact advertised; the landing must show 'Download not available yet')"
NAME="$(get artifact_filename)"; URL="$(get download_url)"; SHA="$(get sha256)"; BYTES="$(get byte_size)"; VERSION="$(get version)"
case "$URL" in http://*|https://*) ;; ./*) URL="$BASE/$(dirname "$MPATH")/${URL#./}";; /*) URL="${BASE%%/[^/]*}$URL";; *) URL="$BASE/$(dirname "$MPATH")/$URL";; esac
echo "artifact: $NAME ($BYTES bytes) from $URL"
curl -fsSL --max-time 1800 "$URL" -o "$OUT/$NAME" || fail "artifact download failed"
ACT_BYTES="$(stat -f %z "$OUT/$NAME" 2>/dev/null || stat -c %s "$OUT/$NAME")"; [ "$ACT_BYTES" = "$BYTES" ] || fail "byte size mismatch ($ACT_BYTES != $BYTES)"
ACT_SHA="$(shasum -a 256 "$OUT/$NAME" | awk '{print $1}')"; [ "$ACT_SHA" = "$SHA" ] || fail "sha256 mismatch ($ACT_SHA != $SHA)"
echo "checksum ok: $ACT_SHA"
mkdir -p "$OUT/extract"; tar -xzf "$OUT/$NAME" -C "$OUT/extract"
DIR="$OUT/extract/blackbox-$VERSION"; [ -x "$DIR/blackbox" ] || fail "extracted archive lacks an executable blackbox wrapper"
[ -f "$DIR/release.json" ] && [ -f "$DIR/INSTALL.en.md" ] && [ -f "$DIR/INSTALL.de.md" ] || fail "archive incomplete"
# macOS quarantine attribute is informational for a shell script + Docker images (no Gatekeeper prompt for scripts)
xattr -p com.apple.quarantine "$OUT/$NAME" >/dev/null 2>&1 && echo "note: quarantine attribute present on the archive (expected for browser downloads)" || true
echo "running bundled doctor in the fresh directory (never installs anything)"
set +e; "$DIR/blackbox" doctor; RC=$?; set -e
echo "doctor exit code: $RC (0 ok / 1 degraded / 2 failure)"
[ $RC -le 1 ] || fail "doctor reported failure"
echo "verify-download: PASS $NAME → $DIR"
echo "next: cd $DIR && ./blackbox setup"
