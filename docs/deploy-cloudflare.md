# Deploy ClawRouter on Cloudflare

ClawRouter’s edge runtime is a Rust/Wasm Worker. Runtime policy lives in
Cloudflare KV so access can be revoked without a redeploy.

## Required Bindings

- `POLICY_KV`: key and policy records.
- `USAGE_QUEUE`: metered usage events.
- `BUDGET_LEDGER`: SQLite-backed Durable Object budget ledger.
- provider secrets such as `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `MINIMAX_API_KEY`, and `TAVILY_API_KEY`.
- provider config vars declared by manifests, such as `OPENROUTER_SITE_URL`,
  `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION`, and `AWS_REGION`.

## Provision

Authenticate Wrangler first, then create the runtime resources:

```sh
pnpm cf:provision
```

Set these GitHub Actions secrets for workflow deploys:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLAWROUTER_ADMIN_TOKEN_SHA256
CLAWROUTER_POLICY_KV_ID
CLAWROUTER_POLICY_KV_PREVIEW_ID
CLAWROUTER_SMOKE_KEY
CLAWROUTER_CLOUDFLARE_AI_GATEWAY_OPENAI_API_KEY # optional smoke-only upstream key
```

Set these GitHub Actions variables when the console is protected by Cloudflare
Access:

```text
CLAWROUTER_ACCESS_TEAM_DOMAIN
CLAWROUTER_ACCESS_AUD
CLAWROUTER_ACCESS_ADMIN_EMAILS        # comma-separated admin emails
CLAWROUTER_ACCESS_ADMIN_DOMAINS       # optional comma-separated admin domains
CLAWROUTER_ACCESS_DEFAULT_TENANT      # optional, defaults to default
```

Check the deploy surface without printing secret values:

```sh
pnpm cf:doctor
```

The doctor verifies local deploy env, Wrangler auth, required GitHub Actions
secret names, the provider smoke plan, and provider binding coverage. It reports
provider env names that are missing locally; those same provider bindings must be
configured as Worker secrets or vars before enabling every provider live.
Install the GitHub CLI as `gh`, or set `CLAWROUTER_GITHUB_CLI` when using a
wrapper binary.

Provider API keys are Cloudflare Worker secrets, not GitHub repository files:

```sh
export CLAWROUTER_ADMIN_TOKEN=...
export CLAWROUTER_ADMIN_TOKEN_SHA256=$(printf '%s' "$CLAWROUTER_ADMIN_TOKEN" | shasum -a 256 | awk '{print $1}')
printf '%s' "$CLAWROUTER_ADMIN_TOKEN_SHA256" | pnpm exec wrangler secret put CLAWROUTER_ADMIN_TOKEN_SHA256 --config .wrangler.generated.toml
pnpm exec wrangler secret put OPENAI_API_KEY --config .wrangler.generated.toml
```

AWS Bedrock uses SigV4. Bind these values before enabling the Bedrock provider:

```sh
pnpm exec wrangler secret put AWS_ACCESS_KEY_ID --config .wrangler.generated.toml
pnpm exec wrangler secret put AWS_SECRET_ACCESS_KEY --config .wrangler.generated.toml
pnpm exec wrangler secret put AWS_SESSION_TOKEN --config .wrangler.generated.toml # optional
pnpm exec wrangler secret put AWS_REGION --config .wrangler.generated.toml
```

Cloudflare AI Gateway needs the gateway coordinates plus the API token used for
gateway authentication. The manifest binds account and gateway IDs from Worker
config, not caller-supplied path parameters.

```sh
pnpm exec wrangler secret put CLOUDFLARE_ACCOUNT_ID --config .wrangler.generated.toml
pnpm exec wrangler secret put CLOUDFLARE_AI_GATEWAY_ID --config .wrangler.generated.toml
pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN --config .wrangler.generated.toml
```

For a Cloudflare AI Gateway live smoke, configure the gateway with provider
defaults or pass an upstream OpenAI key only to the smoke runner:

```sh
export CLAWROUTER_CLOUDFLARE_AI_GATEWAY_OPENAI_API_KEY=...
```

## Render and Deploy

Render a deployable Wrangler config:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
export CLAWROUTER_POLICY_KV_ID=...
pnpm cf:preflight
pnpm cf:config
```

Deploy:

```sh
pnpm cf:deploy
```

## Smoke

The deployed smoke checks health, provider snapshot size, key inspection when a
smoke key is present, and that every provider has an executable smoke target:

```sh
export CLAWROUTER_BASE_URL=https://...
export CLAWROUTER_SMOKE_KEY=clawrouter-live-svc_docs-...
pnpm cf:smoke
```

Live upstream provider calls are opt-in:

```sh
export CLAWROUTER_SMOKE_LIVE_PROVIDERS=openai,tavily
pnpm cf:smoke
```

For GitHub Actions deploys, set the same value in the `live_providers`
workflow-dispatch input. `all` runs every provider smoke target and requires a
proxy smoke key with access to every selected provider.

`CLAWROUTER_SMOKE_OPENAI=1` remains supported as a shortcut for
`CLAWROUTER_SMOKE_LIVE_PROVIDERS=openai`.

## Cloudflare Access Console

Protect the Worker route with a Cloudflare Access application, then set
`CLAWROUTER_ACCESS_TEAM_DOMAIN` to the team domain and `CLAWROUTER_ACCESS_AUD`
to the Access application audience tag. ClawRouter verifies the
`cf-access-jwt-assertion` signature against the team certs endpoint before it
trusts the email or role.

The browser console is fail-closed in the Worker. `/`, `/dashboard`, `/admin`,
`/account`, `/routes`, and `/console` only render after a verified Cloudflare
Access session. Public and client-facing surfaces stay under the API paths such
as `/v1`, `/v1/health`, `/v1/providers`, `/v1/routes`, and proxy endpoints.

Access users are `user` by default. Admins are resolved from
`access/users/<email>` in `POLICY_KV`, then from `CLAWROUTER_ACCESS_ADMIN_EMAILS`
or `CLAWROUTER_ACCESS_ADMIN_DOMAINS`.

```json
{
  "role": "admin",
  "tenantId": "openclaw",
  "enabled": true
}
```

`GET /v1/session` reports the verified Access session. The admin UI can call
admin routes through the same-origin Access session; the admin bearer token is
only a fallback for automation or emergency access.

## Admin API

Admin requests use either a verified Cloudflare Access admin session or
`Authorization: Bearer <admin-token>`. For bearer auth, the Worker compares the
SHA-256 hash of that token with `CLAWROUTER_ADMIN_TOKEN_SHA256`; the raw admin
token is never configured in the Worker.

```text
GET /v1/admin/keys
PUT /v1/admin/keys/<kid>
POST /v1/admin/keys/<kid>/revoke
```

`PUT /v1/admin/keys/<kid>` accepts the same policy shape as `pnpm cf:key:put`,
but with `secretSha256` instead of a raw key secret. The TypeScript admin UI
hashes generated key secrets in the browser before calling the API.
Admin-created key ids must use alphanumeric or underscore characters because the
issued live key format is `clawrouter-live-<kid>-<secret>`. Admin policies must
select at least one provider; use the CLI path for deliberate all-provider keys.

## Keys and Revocation

Proxy keys use this shape:

```text
clawrouter-live-<kid>-<secret>
```

Register a key policy:

```sh
pnpm cf:key:put -- \
  --kid svc_docs \
  --secret '<secret>' \
  --providers openai,tavily \
  --monthly-budget-micros 100000000 \
  --request-cost-micros 1000
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
  "monthlyBudgetMicros": 100000000,
  "requestCostMicros": 1000
}
```

`providers` is an allowlist. An empty list allows every configured provider.
`monthlyBudgetMicros: 0` denies requests immediately. A non-zero
`monthlyBudgetMicros` uses the `BUDGET_LEDGER` Durable Object before upstream
calls and charges `requestCostMicros` per accepted request. If
`requestCostMicros` is omitted, ClawRouter charges one micro unit per request so
budget enforcement still works for keys with a monthly budget.

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
templates that are not declared in `service.configKeys`.

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
