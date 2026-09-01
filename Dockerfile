# syntax=docker/dockerfile:1.7

# This digest is the Node base used by the captured live image. Override the
# argument deliberately when rebuilding against a newer base.
ARG NODE_IMAGE=node@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
ARG DOCKER_CLI_IMAGE=docker@sha256:d14410ab6f87a2b6c14b7150de787cd7b8bb012a8e900966d6d893e9f7fc49b6

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${NODE_IMAGE} AS harness

ARG DSH_VERSION=0.1.1-rc.2
ARG PNPM_VERSION=11.7.0

LABEL org.opencontainers.image.source="https://github.com/astigmatism/dsh-container" \
      org.opencontainers.image.description="Portable DeepSeek Harness maintenance agent"

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      bubblewrap \
      ca-certificates \
      curl \
      git \
      jq \
      less \
      openssh-client \
      procps \
      python3 \
      ripgrep \
      util-linux \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global "pnpm@${PNPM_VERSION}" "@deepseek-ai/dsh@${DSH_VERSION}"

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

COPY plugin/dsh-local-speech /opt/dsh-local-speech
COPY entrypoint.sh /usr/local/bin/dsh-entrypoint
COPY scripts/nvidia-smi-proxy.sh /usr/local/bin/nvidia-smi
COPY scripts/host-exec.sh /usr/local/bin/host-exec
COPY scripts/host-enter.sh /usr/local/bin/host-enter
COPY scripts/sync-runtime-profile.sh /usr/local/bin/dsh-sync-runtime-profile
COPY scripts/initialize-persisted-settings.sh /usr/local/bin/dsh-initialize-persisted-settings
COPY config/settings.yaml /opt/dsh-defaults/settings.yaml

# Generate DSH's base web profile, then overlay the exact live plugin manifest,
# lockfile, local search provider, and loop-detector patch captured on 2026-08-31.
ENV DSH_HOME=/opt/dsh-seed

RUN mkdir -p /opt/dsh-seed \
    && dsh --profile web --dump-config >/dev/null

COPY seed/profile/ /opt/dsh-seed/profiles/web/
COPY seed/plugins/ /opt/dsh-seed/.dsh-plugins/

# Compose runs this image with the host's numeric UID, which may not match the
# base image's `node` user. pnpm opens its store index even for read operations.
RUN cd /opt/dsh-seed/profiles/web \
    && pnpm install --frozen-lockfile --store-dir /opt/dsh-pnpm-store \
    && dsh --profile web --dump-config >/dev/null \
    && dsh plugin --profile web list >/opt/dsh-seed/plugin-inventory.txt \
    && grep -Fq '@zoytown/dsh-token@0.1.3' /opt/dsh-seed/plugin-inventory.txt \
    && grep -Fq 'dsh-context@0.37.0' /opt/dsh-seed/plugin-inventory.txt \
    && grep -Fq 'dsh-loop-detector@1.0.0' /opt/dsh-seed/plugin-inventory.txt \
    && grep -Fq 'dsh-plugin-task-notification@0.2.1' /opt/dsh-seed/plugin-inventory.txt \
    && grep -Fq 'dsh-session-pin@0.6.1' /opt/dsh-seed/plugin-inventory.txt \
    && grep -Fq 'dsh-ui-appearance@0.1.6' /opt/dsh-seed/plugin-inventory.txt \
    && mkdir -p /data \
    && ln -s /opt/dsh-local-speech /data/dsh-local-speech \
    && chmod 0755 /usr/local/bin/dsh-entrypoint /usr/local/bin/nvidia-smi /usr/local/bin/host-exec /usr/local/bin/host-enter /usr/local/bin/dsh-sync-runtime-profile /usr/local/bin/dsh-initialize-persisted-settings \
    && chown -R node:node /opt/dsh-seed /opt/dsh-defaults /opt/dsh-pnpm-store \
    && chmod -R a+rwX /opt/dsh-pnpm-store

ENV DSH_HOME=/data/dsh \
    DSH_TELEMETRY_DISABLED=1 \
    OLLAMA_DSH_API_KEY=local-only \
    NODE_ENV=production

USER node
ENTRYPOINT ["/usr/local/bin/dsh-entrypoint"]

FROM ${NODE_IMAGE} AS gateway

LABEL org.opencontainers.image.source="https://github.com/astigmatism/dsh-container" \
      org.opencontainers.image.description="Authenticated HTTPS gateway for DeepSeek Harness"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY gateway/server.mjs gateway/request-trust.mjs gateway/session-auth.mjs /opt/dsh-gateway/

USER node
ENTRYPOINT ["node", "/opt/dsh-gateway/server.mjs"]
