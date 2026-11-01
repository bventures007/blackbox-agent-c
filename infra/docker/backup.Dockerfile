# syntax=docker/dockerfile:1.7
# Blackbox operations helper image: pg_dump/pg_restore/psql 16 + age (X25519 recipient encryption)
# + GNU tar + jq. Used only by ./blackbox backup|restore|upgrade and the backup scheduler. Non-root.
ARG POSTGRES_IMAGE=postgres:16.6-alpine@sha256:1d04b9ba1d4996401f2552b51beda8187f175c0645c091e4781134fc9c9a3eef
FROM ${POSTGRES_IMAGE}
ARG BLACKBOX_VERSION=dev
ARG BLACKBOX_COMMIT=unknown
LABEL org.opencontainers.image.title="blackbox-backup" \
      org.opencontainers.image.version="${BLACKBOX_VERSION}" \
      org.opencontainers.image.revision="${BLACKBOX_COMMIT}"
ENV BLACKBOX_VERSION=${BLACKBOX_VERSION} BLACKBOX_COMMIT=${BLACKBOX_COMMIT}
RUN apk add --no-cache age tar jq coreutils bash \
 && addgroup -g 10001 blackbox && adduser -D -u 10001 -G blackbox -h /home/blackbox -s /sbin/nologin blackbox \
 && mkdir -p /scripts /data /backup-dest /secrets /release && chown -R 10001:10001 /data /home/blackbox
COPY --chmod=0755 scripts/backup/*.sh /scripts/
USER 10001:10001
WORKDIR /home/blackbox
ENTRYPOINT ["/bin/bash"]
CMD ["/scripts/usage.sh"]
