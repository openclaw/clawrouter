# Deploy ClawRouter on Cloudflare

ClawRouter’s edge runtime is a Rust/Wasm Worker. Runtime policy lives in
Cloudflare KV so access can be revoked without a redeploy.

## Required Bindings

- `POLICY_KV`: key and policy records.
- `USAGE_QUEUE`: metered usage events.
- provider secrets such as `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `MINIMAX_API_KEY`, and `TAVILY_API_KEY`.

## Provision

Authenticate Wrangler first, then create the runtime resources:

```sh
pnpm cf:provision
```

Set these GitHub Actions secrets for workflow deploys:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLAWROUTER_POLICY_KV_ID
CLAWROUTER_POLICY_KV_PREVIEW_ID
CLAWROUTER_SMOKE_KEY
```

Provider API keys are Cloudflare Worker secrets, not GitHub repository files:

```sh
pnpm exec wrangler secret put OPENAI_API_KEY --config .wrangler.generated.toml
```

## Render and Deploy

Render a deployable Wrangler config:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLAWROUTER_POLICY_KV_ID=...
pnpm cf:config
```

Deploy:

```sh
pnpm cf:deploy
```

## Keys and Revocation

Proxy keys use this shape:

```text
clawrouter-live-<kid>-<secret>
```

Register a key policy:

```sh
pnpm cf:key:put -- --kid svc_docs --secret '<secret>' --providers openai,tavily
```

This stores only `secretSha256`, enabled state, and provider allowlist in
`POLICY_KV` at `keys/<kid>`.

Revoke access:

```sh
pnpm cf:key:revoke -- --kid svc_docs
```

The edge runtime checks `POLICY_KV` on proxy requests. Setting `enabled: false`
revokes access without rotating upstream provider credentials.

## Smoke

Validate a deployed Worker:

```sh
export CLAWROUTER_BASE_URL=https://<worker>.<subdomain>.workers.dev
pnpm cf:smoke
```

Optional provider-path smoke:

```sh
export CLAWROUTER_SMOKE_KEY=clawrouter-live-svc_docs-...
export CLAWROUTER_SMOKE_OPENAI=1
pnpm cf:smoke
```
