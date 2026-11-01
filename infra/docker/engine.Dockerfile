# syntax=docker/dockerfile:1.7
# Blackbox Rust engine: axum service on the internal network (engine:7070). Non-root, arm64.
# Integration hooks (apps/engine agent): Cargo workspace at repo root with package `blackbox-engine`
# producing the binary `blackbox-engine`; `blackbox-engine --healthcheck` exits 0 when healthy.
ARG RUST_IMAGE=rust:1.83-bookworm@sha256:a45bf1f5d9af0a23b26703b3500d70af1abff7f984a7abef5a104b42c02a292b
ARG RUNTIME_IMAGE=debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

FROM ${RUST_IMAGE} AS build
WORKDIR /src
# whole Cargo workspace (members: apps/engine, crates/*, tests/engine); engine.Dockerfile.dockerignore trims it
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p blackbox-engine \
 && install -m 0755 target/release/blackbox-engine /usr/local/bin/blackbox-engine

FROM ${RUNTIME_IMAGE} AS runtime
ARG BLACKBOX_VERSION=dev
ARG BLACKBOX_COMMIT=unknown
LABEL org.opencontainers.image.title="blackbox-engine" \
      org.opencontainers.image.version="${BLACKBOX_VERSION}" \
      org.opencontainers.image.revision="${BLACKBOX_COMMIT}"
ENV BLACKBOX_VERSION=${BLACKBOX_VERSION} BLACKBOX_COMMIT=${BLACKBOX_COMMIT}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 blackbox && useradd --uid 10001 --gid 10001 --home /app --shell /usr/sbin/nologin blackbox \
 && mkdir -p /app /data/snapshots /data/logs && chown -R 10001:10001 /app /data
COPY --from=build /usr/local/bin/blackbox-engine /usr/local/bin/blackbox-engine
USER 10001:10001
WORKDIR /app
EXPOSE 7070
ENTRYPOINT ["/usr/local/bin/blackbox-engine"]
