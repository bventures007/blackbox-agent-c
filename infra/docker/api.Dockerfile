# syntax=docker/dockerfile:1.7
# Blackbox api image: Fastify API + built web UI + host CLI (apps/api/dist/cli.js).
# Multi-stage, non-root, arm64. Build context = repository root.
# Integration hooks (owned by the apps/api + apps/web agents):
#   - pnpm workspace (packageManager pinned in package.json); root `pnpm run build` builds packages + apps/api,
#     `pnpm run build:web` emits apps/web/dist; apps/api/dist/{index.js,cli.js} are the server/CLI entries
#   - the server reads WEB_DIST_DIR, MIGRATIONS_DIR and the *_FILE secrets documented in docs/operations.md
# Build context = repository root; api.Dockerfile.dockerignore excludes node_modules/target/data.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
# builder-only toolchain for native modules (argon2 ships arm64 prebuilds; the toolchain is the fallback)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN corepack enable && corepack prepare --activate
# pnpm >=10 runs dependency build scripts (argon2, esbuild) only when pnpm-workspace.yaml allows them
# (allowBuilds / onlyBuiltDependencies). Integration point: that allowlist must be valid in the repo.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
# Backend first (must succeed); the web/landing builds are owned by another component and may lag —
# an image without them still serves the API (the UI routes then 404 until the next build).
# The runtime image carries the workspace re-linked with production dependencies only: pnpm deploy does not
# bundle workspace packages reliably across pnpm majors, and relative workspace symlinks stay valid
# when /src is copied to /app.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm run build:backend \
 && (pnpm run build:web || (echo "WARN: web build failed; API-only image" && mkdir -p apps/web/dist)) \
 && (pnpm run build:landing || (echo "WARN: landing build failed" && mkdir -p apps/landing/dist)) \
 && pnpm install --prod --frozen-lockfile --offline \
 && rm -rf .git target tests/e2e/node_modules apps/web/node_modules apps/landing/node_modules packages/ui/node_modules \
 && find . -name '*.tsbuildinfo' -delete

FROM ${NODE_IMAGE} AS runtime
ARG BLACKBOX_VERSION=dev
ARG BLACKBOX_COMMIT=unknown
LABEL org.opencontainers.image.title="blackbox-api" \
      org.opencontainers.image.version="${BLACKBOX_VERSION}" \
      org.opencontainers.image.revision="${BLACKBOX_COMMIT}" \
      org.opencontainers.image.description="Blackbox local pilot API/web (loopback only)"
ENV NODE_ENV=production BLACKBOX_VERSION=${BLACKBOX_VERSION} BLACKBOX_COMMIT=${BLACKBOX_COMMIT}
RUN groupadd --gid 10001 blackbox && useradd --uid 10001 --gid 10001 --home /app --shell /usr/sbin/nologin blackbox \
 && mkdir -p /app /data/logs /data/evidence /data/snapshots /data/backups /data/state \
 && chown -R 10001:10001 /app /data
WORKDIR /app
# Whole pruned workspace: apps/api/dist (server + CLI), apps/web/dist, apps/landing/dist, packages/*/dist,
# packages/database/migrations, and the binding contracts read at runtime (BLACKBOX_REPO_ROOT=/app:
# packages/contracts, specs/question-data-contracts.json, GOLDEN-ORDER-TO-CASH.json).
COPY --from=build --chown=10001:10001 /src /app
COPY --chmod=0755 infra/docker/api-entrypoint.sh /usr/local/bin/blackbox-api-entrypoint
ENV BLACKBOX_REPO_ROOT=/app
USER 10001:10001
EXPOSE 19180
ENTRYPOINT ["/usr/local/bin/blackbox-api-entrypoint"]
