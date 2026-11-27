#!/usr/bin/env bash
set -euo pipefail

bash scripts/fetch-test-baselines.sh
pnpm install --frozen-lockfile
pnpm build
pnpm --dir admin check
pnpm --dir admin test
pnpm test:scripts
pnpm worker:e2e
pnpm provider:smoke-plan
# Render and pack locally; neither command sends a deployment.
CLAWROUTER_STRICT_CONFIG=0 pnpm cf:config
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir "$build_dir" --config .wrangler.generated.toml
# With no_bundle, Wrangler copies the configured worker.mjs entrypoint unchanged.
test -s "$build_dir/worker.mjs"
cmp .wrangler/large-http/worker.mjs "$build_dir/worker.mjs"
