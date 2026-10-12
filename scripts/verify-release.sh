#!/usr/bin/env bash
set -euo pipefail

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
test -s "$build_dir/index.js"
