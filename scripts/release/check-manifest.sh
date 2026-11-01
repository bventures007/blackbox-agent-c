#!/usr/bin/env bash
# Validate a landing release manifest against the artifact it describes (DIST-01/02 preparation).
#   check-manifest.sh <release-manifest.json> [--artifact <path>]
# Checks: required fields, status, filename pattern/version consistency, platform/format, byte size and
# SHA-256 of the artifact (looked up next to the manifest or via --artifact), archive content list,
# release.json inside the archive matches version/commit, compose image tags pinned to the version.
# Exit 0 ok, 2 on any mismatch. Pending manifests (status != released) pass only the shape check.
set -euo pipefail
MANIFEST="${1:-}"; [ -f "$MANIFEST" ] || { echo "usage: check-manifest.sh <release-manifest.json> [--artifact path]" >&2; exit 2; }
shift; ARTIFACT=""
while [ $# -gt 0 ]; do case "$1" in --artifact) ARTIFACT="$2"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
DIR="$(cd "$(dirname "$MANIFEST")" && pwd -P)"
get() { grep -o -E "\"$1\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|[^,}[:space:]]+)" "$MANIFEST" | head -n1 | sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*//; s/^"//; s/"$//'; }
fail() { echo "check-manifest: FAIL $*" >&2; exit 2; }
ok() { echo "check-manifest: ok  $*"; }

for k in schema_version status platform format prerequisites guide_url; do [ -n "$(get $k)" ] || fail "missing field $k"; done
STATUS="$(get status)"
case "$STATUS" in released|pending|preview) ok "status=$STATUS";; *) fail "status must be released|pending|preview";; esac
if [ "$STATUS" != "released" ]; then
  [ "$(get download_url)" = "null" ] || [ -z "$(get download_url)" ] || fail "non-released manifest must not advertise a download_url"
  ok "non-released manifest: shape valid, no download advertised"; exit 0
fi
VERSION="$(get version)"; NAME="$(get artifact_filename)"; SHA="$(get sha256)"; BYTES="$(get byte_size)"; COMMIT="$(get tested_commit)"
[ "$(get platform)" = "macOS Apple Silicon (arm64)" ] || fail "platform mismatch"
[ "$(get format)" = "tar.gz" ] || fail "format mismatch"
[ "$NAME" = "blackbox-$VERSION-mac-arm64.tar.gz" ] || fail "artifact_filename '$NAME' does not match version $VERSION"
[ -n "$(get date)" ] && [ -n "$COMMIT" ] || fail "date/tested_commit missing"
echo "$SHA" | grep -q -E '^[0-9a-f]{64}$' || fail "sha256 malformed"
[ "${ARTIFACT:-}" ] || ARTIFACT="$DIR/$NAME"
[ -f "$ARTIFACT" ] || fail "artifact not found at $ARTIFACT"
ACT_SHA="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"; ACT_BYTES="$(stat -f %z "$ARTIFACT" 2>/dev/null || stat -c %s "$ARTIFACT")"
[ "$ACT_SHA" = "$SHA" ] || fail "sha256 mismatch: manifest $SHA, artifact $ACT_SHA"
[ "$ACT_BYTES" = "$BYTES" ] || fail "byte_size mismatch: manifest $BYTES, artifact $ACT_BYTES"
ok "artifact bytes/sha256 match ($BYTES bytes)"
LIST="$(tar -tzf "$ARTIFACT")"
for p in "blackbox-$VERSION/blackbox" "blackbox-$VERSION/infra/compose/docker-compose.yml" "blackbox-$VERSION/release.json" \
         "blackbox-$VERSION/INSTALL.en.md" "blackbox-$VERSION/INSTALL.de.md" "blackbox-$VERSION/examples/.env.example" "blackbox-$VERSION/migrations/0001_journal.sql"; do
  echo "$LIST" | grep -q -x "$p" || fail "archive lacks $p"
done
if [ "$(get images_bundled)" = "true" ]; then
  for i in api worker engine backup postgres; do echo "$LIST" | grep -q -x "blackbox-$VERSION/images/$i.tar" || fail "archive lacks images/$i.tar"; done
  ok "bundled images present"
fi
echo "$LIST" | grep -q -E "blackbox-$VERSION/(secrets|\\.env$|data/)" && fail "archive contains runtime data or secrets"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARTIFACT" -C "$TMP" "blackbox-$VERSION/release.json" "blackbox-$VERSION/infra/compose/docker-compose.yml"
RV="$(grep -o -E '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$TMP/blackbox-$VERSION/release.json" | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')"
[ "$RV" = "$VERSION" ] || fail "release.json version $RV != $VERSION"
RC="$(grep -o -E '"tested_commit"[[:space:]]*:[[:space:]]*"[^"]*"' "$TMP/blackbox-$VERSION/release.json" | sed -E 's/.*"([^"]*)"$/\1/')"
[ "$RC" = "$COMMIT" ] || fail "release.json tested_commit $RC != manifest $COMMIT"
grep -q "blackbox/api:$VERSION" "$TMP/blackbox-$VERSION/infra/compose/docker-compose.yml" || fail "compose api image not pinned to $VERSION"
grep -q -E 'postgres:16\.[0-9]+-alpine@sha256:[0-9a-f]{64}' "$TMP/blackbox-$VERSION/infra/compose/docker-compose.yml" || fail "compose postgres image not pinned by digest"
grep -q -E '"(\$\{BLACKBOX_BIND:-)?127\.0\.0\.1(\})?:' "$TMP/blackbox-$VERSION/infra/compose/docker-compose.yml" || fail "compose does not bind 127.0.0.1"
ok "release.json and compose pins consistent with $VERSION @ $COMMIT"
echo "check-manifest: PASS $NAME"
