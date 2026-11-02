#!/usr/bin/env bash
# Build the versioned Blackbox local release archive (ADR-0005, specs/WEB-DESKTOP-AND-DEPLOYMENT.md).
#
#   scripts/release/build.sh <version> [--skip-images] [--download-url <url>] [--guide-url <url>] [--notes <file>]
#
# Produces, under release/dist/ (git-ignored generated output):
#   blackbox-<version>-mac-arm64.tar.gz      the installable archive
#   blackbox-<version>-mac-arm64.tar.gz.sha256
#   release-manifest.json                    landing-page manifest (status/version/date/size/sha256/urls/prereqs)
#   release.json                             copy of the compat manifest inside the archive
# Archive layout (top directory blackbox-<version>/):
#   blackbox, infra/compose/docker-compose.yml, infra/compose/.env.example → examples/.env.example,
#   migrations/*.sql, release.json, INSTALL.en.md, INSTALL.de.md, images/{api,worker,engine,backup}.tar
# Image publication to a registry is NOT authorized; bundled tarballs are the distribution path.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
VERSION="${1:-}"; [ -n "$VERSION" ] || { echo "usage: build.sh <version> [--skip-images] [--download-url u] [--guide-url u] [--notes file]" >&2; exit 2; }
shift
SKIP_IMAGES=0; DOWNLOAD_URL=""; GUIDE_URL=""; GUIDE_URL_DE=""; NOTES_FILE=""; IMAGE_SET="api worker engine backup"
while [ $# -gt 0 ]; do case "$1" in
  --skip-images) SKIP_IMAGES=1; shift;;
  --images) IMAGE_SET="$2"; shift 2;;   # subset for ops-only test archives (e.g. "backup"); not a full release
  --download-url) DOWNLOAD_URL="$2"; shift 2;;
  --guide-url) GUIDE_URL="$2"; shift 2;;
  --guide-url-de) GUIDE_URL_DE="$2"; shift 2;;
  --notes) NOTES_FILE="$2"; shift 2;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
case "$VERSION" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "version must be semver-like (e.g. 0.1.0)" >&2; exit 2;; esac

OUT="$ROOT/release/dist"; STAGE="$OUT/stage/blackbox-$VERSION"; NAME="blackbox-$VERSION-mac-arm64.tar.gz"
PLATFORM="macOS Apple Silicon (arm64)"
COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
DATE="$(date -u +%Y-%m-%d)"; NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PG_IMAGE="$(sed -n -E 's/^BLACKBOX_POSTGRES_IMAGE=(.*)$/\1/p' "$ROOT/infra/compose/.env.example")"
TEMPLATE="$ROOT/scripts/release/release.json.template"
[ -f "$TEMPLATE" ] || { echo "missing $TEMPLATE" >&2; exit 2; }

echo "release build $VERSION ($COMMIT) → $OUT/$NAME"
rm -rf "$OUT/stage"; mkdir -p "$STAGE/infra/compose" "$STAGE/images" "$STAGE/migrations" "$STAGE/examples"
cp "$ROOT/scripts/blackbox" "$STAGE/blackbox"; chmod 0755 "$STAGE/blackbox"
cp "$ROOT/infra/compose/docker-compose.yml" "$STAGE/infra/compose/docker-compose.yml"
cp "$ROOT/infra/compose/.env.example" "$STAGE/examples/.env.example"
cp "$ROOT"/packages/database/migrations/*.sql "$STAGE/migrations/"
cp "$ROOT/INSTALL.en.md" "$ROOT/INSTALL.de.md" "$STAGE/"
# pin image tags in the shipped compose file (no :-dev defaults)
sed -i.bak -E "s/\\$\\{BLACKBOX_VERSION:-dev\\}/${VERSION}/g; s/\\$\\{BLACKBOX_IMAGE_PREFIX:-blackbox\\}/blackbox/g" "$STAGE/infra/compose/docker-compose.yml" && rm -f "$STAGE/infra/compose/docker-compose.yml.bak"
sed -i.bak -E "s/^BLACKBOX_VERSION=.*/BLACKBOX_VERSION=${VERSION}/" "$STAGE/examples/.env.example" && rm -f "$STAGE/examples/.env.example.bak"

DIGEST_api=unbuilt; DIGEST_worker=unbuilt; DIGEST_engine=unbuilt; DIGEST_backup=unbuilt; DIGEST_postgres="${PG_IMAGE##*@}"
if [ $SKIP_IMAGES = 0 ]; then
  for svc in $IMAGE_SET; do
    echo "building blackbox/$svc:$VERSION"
    docker build --platform linux/arm64 -f "$ROOT/infra/docker/$svc.Dockerfile" \
      --build-arg BLACKBOX_VERSION="$VERSION" --build-arg BLACKBOX_COMMIT="$COMMIT" \
      -t "blackbox/$svc:$VERSION" "$ROOT"
    # image hygiene: a release image carries product files only (no runtime test outputs, env files, secrets or data)
    docker run --rm --entrypoint sh "blackbox/$svc:$VERSION" -c 'for p in /app/tests/e2e/test-results /app/tests/e2e/playwright-report /app/tests/e2e/screenshots /app/.env /app/secrets /app/data /app/release /app/.local; do [ ! -e "$p" ] || { echo "image hygiene: $p must not be in the image" >&2; exit 2; }; done' \
      || { echo "image hygiene check failed for blackbox/$svc:$VERSION" >&2; exit 2; }
    docker save "blackbox/$svc:$VERSION" -o "$STAGE/images/$svc.tar"
    eval "DIGEST_$svc=\"$(docker image inspect --format '{{.Id}}' "blackbox/$svc:$VERSION")\""
  done
  echo "pulling pinned PostgreSQL image for the bundle"
  docker pull --platform linux/arm64 "$PG_IMAGE" >/dev/null
  docker save "$PG_IMAGE" -o "$STAGE/images/postgres.tar"
else
  echo "(--skip-images) archive will not bundle images; setup falls back to pull/build"
  rmdir "$STAGE/images"
fi

# compat manifest (release.json) from template
sed -E \
  -e "s|__VERSION__|$VERSION|g" -e "s|__DATE__|$NOW|g" -e "s|__COMMIT__|$COMMIT|g" -e "s|__POSTGRES_IMAGE__|$PG_IMAGE|g" \
  -e "s|__API_DIGEST__|$DIGEST_api|g" -e "s|__WORKER_DIGEST__|$DIGEST_worker|g" \
  -e "s|__ENGINE_DIGEST__|$DIGEST_engine|g" -e "s|__BACKUP_DIGEST__|$DIGEST_backup|g" \
  -e "s|__POSTGRES_DIGEST__|$DIGEST_postgres|g" \
  "$TEMPLATE" > "$STAGE/release.json"

mkdir -p "$OUT"; rm -f "$OUT/$NAME"
# deterministic-ish: sorted names, no macOS resource forks/xattrs
COPYFILE_DISABLE=1 tar -C "$OUT/stage" --no-xattrs -czf "$OUT/$NAME" "blackbox-$VERSION" 2>/dev/null || COPYFILE_DISABLE=1 tar -C "$OUT/stage" -czf "$OUT/$NAME" "blackbox-$VERSION"
SHA="$(shasum -a 256 "$OUT/$NAME" | awk '{print $1}')"; BYTES="$(stat -f %z "$OUT/$NAME" 2>/dev/null || stat -c %s "$OUT/$NAME")"
printf '%s  %s\n' "$SHA" "$NAME" > "$OUT/$NAME.sha256"
cp "$STAGE/release.json" "$OUT/release.json"
NOTES="Local pilot release $VERSION (tested commit $COMMIT). Bundled arm64 images for api, worker, engine, backup and pinned PostgreSQL 16. See INSTALL.en.md / INSTALL.de.md inside the archive."
[ -n "$NOTES_FILE" ] && NOTES="$(tr '\n' ' ' < "$NOTES_FILE" | sed 's/"/\\"/g')"
cat > "$OUT/release-manifest.json" <<EOF
{
  "schema_version": "1",
  "status": "released",
  "version": "$VERSION",
  "date": "$DATE",
  "tested_commit": "$COMMIT",
  "artifact_filename": "$NAME",
  "platform": "$PLATFORM",
  "architecture": "arm64",
  "format": "tar.gz",
  "byte_size": $BYTES,
  "sha256": "$SHA",
  "download_url": "${DOWNLOAD_URL:-./$NAME}",
  "guide_url": "${GUIDE_URL:-./INSTALL.en.md}",
  "guide_url_de": "${GUIDE_URL_DE:-./INSTALL.de.md}",
  "prerequisites": {
    "container_runtime": "Docker Desktop 4.3x+ with Compose v2",
    "min_os": "macOS 14",
    "disk_free_gib": 10,
    "network": "none for installation (images are bundled); outbound provider access for sources"
  },
  "images_bundled": $([ $SKIP_IMAGES = 0 ] && [ "$IMAGE_SET" = "api worker engine backup" ] && echo true || echo false),
  "signing": "none (SHA-256 checksum only; not signed or notarized)",
  "release_notes": "$NOTES"
}
EOF
cp "$STAGE/INSTALL.en.md" "$STAGE/INSTALL.de.md" "$OUT/"
rm -rf "$OUT/stage"
echo "artifact: $OUT/$NAME ($BYTES bytes)"; echo "sha256:   $SHA"; echo "manifest: $OUT/release-manifest.json"
"$ROOT/scripts/release/check-manifest.sh" "$OUT/release-manifest.json"
