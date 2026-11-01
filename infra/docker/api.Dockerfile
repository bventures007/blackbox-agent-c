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
RUN pnpm run build && pnpm run build:web \
 && (pnpm --filter @blackbox/api deploy --prod --legacy /out/api || pnpm --filter @blackbox/api deploy --prod /out/api) \
 && cp -R apps/web/dist /out/web-dist

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
COPY --from=build --chown=10001:10001 /out/api /app/apps/api
COPY --from=build --chown=10001:10001 /out/web-dist /app/apps/web/dist
COPY --chown=10001:10001 packages/database/migrations /app/packages/database/migrations
USER 10001:10001
EXPOSE 19180
ENTRYPOINT ["node", "/app/apps/api/dist/index.js"]
