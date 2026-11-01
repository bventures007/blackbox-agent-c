# syntax=docker/dockerfile:1.7
# Blackbox worker image: pg-boss jobs (provider polling, outbox dispatch, retention). Non-root, arm64.
# Integration hook (apps/worker agent): `pnpm --filter @blackbox/worker build` emits apps/worker/dist/index.js.
# Build context = repository root; worker.Dockerfile.dockerignore excludes node_modules/target/data.
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
# Runtime = pruned workspace copy (see api.Dockerfile for the rationale).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm run build:worker \
 && pnpm install --prod --frozen-lockfile --offline \
 && rm -rf .git target tests/e2e/node_modules apps/web/node_modules apps/landing/node_modules packages/ui/node_modules \
 && find . -name '*.tsbuildinfo' -delete

FROM ${NODE_IMAGE} AS runtime
ARG BLACKBOX_VERSION=dev
ARG BLACKBOX_COMMIT=unknown
LABEL org.opencontainers.image.title="blackbox-worker" \
      org.opencontainers.image.version="${BLACKBOX_VERSION}" \
      org.opencontainers.image.revision="${BLACKBOX_COMMIT}"
ENV NODE_ENV=production BLACKBOX_VERSION=${BLACKBOX_VERSION} BLACKBOX_COMMIT=${BLACKBOX_COMMIT}
RUN groupadd --gid 10001 blackbox && useradd --uid 10001 --gid 10001 --home /app --shell /usr/sbin/nologin blackbox \
 && mkdir -p /app /data/logs /data/evidence /data/backups /data/state && chown -R 10001:10001 /app /data
WORKDIR /app
COPY --from=build --chown=10001:10001 /src /app
ENV BLACKBOX_REPO_ROOT=/app
USER 10001:10001
ENTRYPOINT ["node", "/app/apps/worker/dist/index.js"]
