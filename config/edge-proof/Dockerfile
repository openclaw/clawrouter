FROM --platform=linux/amd64 docker.io/library/node@sha256:0925478b811e8890f5508ad2a75135933310effd45492696ecf7c111c8339d02

# ONLINE image setup. The context contains only the enumerated harness,
# frozen workspace inputs and verified source Git object closure.
ARG HOST_UID
ARG HOST_GID
ARG CONTEXT_HASH
ARG TASK_NONCE
ENV PNPM_HOME=/usr/local/share/pnpm
RUN edge_seq=0; \
    edge_emit() { printf '\n%s%s {"v":1,"context":"%s","nonce":"%s","seq":%s,"stage":"%s","event":"%s","status":%s}\n' 'EDGE_BUILD_' 'STAGE_V1' "$CONTEXT_HASH" "$TASK_NONCE" "$edge_seq" "$1" "$2" "$3"; }; \
    edge_stage() { edge_name=$1; shift; edge_seq=$((edge_seq+1)); edge_emit "$edge_name" entered null || return 70; if "$@"; then edge_status=0; else edge_status=$?; fi; edge_seq=$((edge_seq+1)); if edge_emit "$edge_name" terminal "$edge_status"; then :; elif [ "$edge_status" -eq 0 ]; then return 70; fi; return "$edge_status"; }; \
    node_version() { test "$(/usr/local/bin/node --version)" = v24.22.1; }; \
    node_abi() { test "$(/usr/local/bin/node -p 'process.versions.modules')" = 137; }; \
    architecture() { test "$(uname -m)" = x86_64; }; \
    git_executable() { test -x /usr/bin/git; }; \
    pnpm_bootstrap() { /usr/local/bin/npm install --global --ignore-scripts pnpm@11.28.4; }; \
    pnpm_version() { test "$(/usr/local/bin/pnpm --version)" = 11.28.4; }; \
    input_directories() { mkdir -p /opt/edge-input /opt/build-home; }; \
    input_ownership() { chown "$HOST_UID:$HOST_GID" /opt/edge-input /opt/build-home; }; \
    edge_stage node_version node_version \
    && edge_stage node_abi node_abi \
    && edge_stage architecture architecture \
    && edge_stage git_executable git_executable \
    && edge_stage pnpm_bootstrap pnpm_bootstrap \
    && edge_stage pnpm_version pnpm_version \
    && edge_stage input_directories input_directories \
    && edge_stage input_ownership input_ownership
COPY --chown=${HOST_UID}:${HOST_GID} input/ /opt/edge-input/
USER ${HOST_UID}:${HOST_GID}
WORKDIR /opt/edge-input
RUN edge_seq=16; \
    edge_emit() { printf '\n%s%s {"v":1,"context":"%s","nonce":"%s","seq":%s,"stage":"%s","event":"%s","status":%s}\n' 'EDGE_BUILD_' 'STAGE_V1' "$CONTEXT_HASH" "$TASK_NONCE" "$edge_seq" "$1" "$2" "$3"; }; \
    edge_stage() { edge_name=$1; shift; edge_seq=$((edge_seq+1)); edge_emit "$edge_name" entered null || return 70; if "$@"; then edge_status=0; else edge_status=$?; fi; edge_seq=$((edge_seq+1)); if edge_emit "$edge_name" terminal "$edge_status"; then :; elif [ "$edge_status" -eq 0 ]; then return 70; fi; return "$edge_status"; }; \
    frozen_install() { HOME=/opt/build-home /usr/local/bin/pnpm install --frozen-lockfile; }; \
    native_prepare() { HOME=/opt/build-home /usr/local/bin/node scripts/edge-proof.mjs container-prepare "$CONTEXT_HASH"; }; \
    edge_stage frozen_install frozen_install \
    && edge_stage native_prepare native_prepare
LABEL org.openclaw.edge.context=${CONTEXT_HASH} org.openclaw.edge.nonce=${TASK_NONCE}
WORKDIR /task
ENTRYPOINT ["/usr/local/bin/node", "/opt/edge-input/scripts/edge-proof.mjs", "container-init"]
CMD []
