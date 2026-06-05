# Deploy ClawRouter on Cloudflare

ClawRouter’s edge runtime is a Rust/Wasm Worker. Runtime policy lives in
Cloudflare KV so access can be revoked without a redeploy.

## Required Bindings

- `POLICY_KV`: key and policy records.
- `USAGE_QUEUE`: metered usage events.
- provider secrets such as `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `MINIMAX_API_KEY`, and `TAVILY_API_KEY`.
- provider config vars declared by manifests, such as `OPENROUTER_SITE_URL`,
  `AZURE_OPENAI_ENDPOINT`, and `AZURE_OPENAI_API_VERSION`.

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

Inspect a key without making an upstream provider call:

```sh
curl "$CLAWROUTER_BASE_URL/v1/key/inspect" \
  -H "authorization: Bearer $CLAWROUTER_KEY"
```

When `POLICY_KV` is bound, the response verifies syntax, registration, secret
hash, enabled state, tenant, budget, and provider allowlist. The endpoint never
returns the key secret or stored secret hash.

The stored policy shape is:

```json
{
  "enabled": true,
  "secretSha256": "<sha256 of key secret>",
  "providers": ["openai", "tavily"],
  "tenantId": "default",
  "monthlyBudgetMicros": 100000000
}
```

`providers` is an allowlist. An empty list allows every configured provider.
`monthlyBudgetMicros: 0` denies requests immediately; non-zero budget enforcement
is reserved for the Durable Object budget ledger path.

## OAuth Grants

OAuth-backed providers such as GitHub, Linear, Notion, and Slack read access
tokens from `POLICY_KV`. Register a grant for one proxy key:

```sh
printf '%s' "$GITHUB_TOKEN" | pnpm cf:oauth:put -- \
  --kid svc_docs \
  --token-ref oauth.github.access_token \
  --access-token-stdin
```

Tenant-wide grants are also supported:

```sh
pnpm cf:oauth:put -- \
  --tenant default \
  --token-ref oauth.slack.bot_token \
  --access-token-env SLACK_BOT_TOKEN
```

This stores a grant at `oauth/<kid>/<tokenRef>` or
`oauth/tenants/<tenant>/<tokenRef>`. Active grant records contain `enabled`,
`accessToken`, and `tokenType`; the token is never printed by the helper.

Revoke a grant without deleting audit history:

```sh
pnpm cf:oauth:revoke -- --kid svc_docs --token-ref oauth.github.access_token
```

Revocation overwrites the grant with a disabled tombstone and removes the stored
access token.

## Proxy Routes

OpenAI-compatible calls use normal OpenAI paths and route by `model`:

```sh
curl "$CLAWROUTER_BASE_URL/v1/chat/completions" \
  -H "authorization: Bearer $CLAWROUTER_KEY" \
  -H "content-type: application/json" \
  --data '{"model":"openai/gpt-5.5-mini","messages":[{"role":"user","content":"ok"}]}'
```

Manifest REST/tool calls use:

```text
POST /v1/proxy/<provider>/<endpoint>
```

The JSON body can contain:

```json
{
  "method": "GET",
  "pathParams": { "path": "repos/openclaw/clawrouter" },
  "query": { "per_page": 10 },
  "body": { "query": "openclaw" }
}
```

`method` must be allowed by the endpoint’s provider manifest. `pathParams`
replace `${name}` segments from the manifest endpoint path. Params are single
safe path segments by default. Provider manifests may opt a param into
`relative_path` for REST paths such as `repos/openclaw/clawrouter`; absolute
paths, empty segments, `.`, `..`, query strings, and fragments are rejected.
`query` merges with manifest query defaults and injected query values.

The live Worker rejects manifest endpoints that still need unresolved deployment
templates that are not declared in `service.configKeys`. SigV4 providers are
cataloged but return `provider_endpoint_not_supported` until signing is wired.

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
