FROM --platform=linux/amd64 docker.io/library/node@sha256:0925478b811e8890f5508ad2a75135933310effd45492696ecf7c111c8339d02

# ONLINE image setup. The context contains only the enumerated harness,
# frozen workspace inputs and verified source Git object closure.
ARG HOST_UID
ARG HOST_GID
ARG CONTEXT_HASH
ARG TASK_NONCE
ENV PNPM_HOME=/usr/local/share/pnpm
RUN test "$(/usr/local/bin/node --version)" = v24.22.1 \
    && test "$(/usr/local/bin/node -p 'process.versions.modules')" = 137 \
    && test "$(uname -m)" = x86_64 \
    && test -x /usr/bin/git \
    && /usr/local/bin/npm install --global --ignore-scripts pnpm@11.28.4 \
    && test "$(/usr/local/bin/pnpm --version)" = 11.28.4 \
    && mkdir -p /opt/edge-input /opt/build-home \
    && chown "$HOST_UID:$HOST_GID" /opt/edge-input /opt/build-home
COPY --chown=${HOST_UID}:${HOST_GID} input/ /opt/edge-input/
USER ${HOST_UID}:${HOST_GID}
WORKDIR /opt/edge-input
RUN HOME=/opt/build-home /usr/local/bin/pnpm install --frozen-lockfile \
    && HOME=/opt/build-home /usr/local/bin/node scripts/edge-proof.mjs container-prepare "$CONTEXT_HASH"
LABEL org.openclaw.edge.context=${CONTEXT_HASH} org.openclaw.edge.nonce=${TASK_NONCE}
WORKDIR /task
ENTRYPOINT ["/usr/local/bin/node", "/opt/edge-input/scripts/edge-proof.mjs", "container-init"]
CMD []
