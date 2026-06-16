# Deploy ClawRouter on Cloudflare

ClawRouter’s edge runtime is a Rust/Wasm Worker. Revocation-critical runtime
policy lives in serialized Durable Object authority so access can be revoked
without a redeploy. Cloudflare KV stores migration seeds, compatibility copies,
OAuth grants, and operational health.

## Required Bindings

- `POLICY_KV`: migration seeds and compatibility copies for access policies,
  issued credential hashes, principal bindings, users, and provider
  connections, plus OAuth grants and provider health records.
- `USAGE_QUEUE`: metered usage events and durable budget-settlement retries,
  with this Worker configured as producer and consumer.
- usage DLQ, named by `CLAWROUTER_USAGE_DLQ`: separate queue for usage or
  settlement messages that exhaust automatic retries.
- `BUDGET_LEDGER`: SQLite-backed Durable Object budget ledger.
- `ACCESS_CONTROL`: SQLite-backed Durable Object authority for policies,
  credential hashes, user state, per-provider kill-switch shards, serialized
  user/group policy-binding mutations, and session entitlement lookup.
- `USAGE_LEDGER`: SQLite-backed Durable Object request audit and reporting
  ledger. It retains bounded metadata for 30 days and never stores prompt or
  completion bodies.
- provider secrets such as `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `MINIMAX_API_KEY`, and `TAVILY_API_KEY`.
- provider config vars declared by manifests, such as `OPENROUTER_SITE_URL`,
  `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION`, and `AWS_REGION`.

## Provision

Authenticate Wrangler first, then create the runtime resources:

```sh
pnpm cf:provision
```

Protect the browser console with Cloudflare Access before treating the custom
domain as ready:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=... # must be able to manage Zero Trust Access apps/policies
export CLAWROUTER_ACCESS_ALLOWED_DOMAINS=openclaw.ai
export CLAWROUTER_ACCESS_ADMIN_EMAILS=you@example.com
pnpm cf:access
```

`pnpm cf:access` creates or updates a self-hosted Access application for the
console and session/admin paths on `clawrouter.openclaw.ai`, installs an allow
policy, and prints the
`CLAWROUTER_ACCESS_TEAM_DOMAIN` and `CLAWROUTER_ACCESS_AUD` values that the
Worker uses to verify Access JWTs. Add `-- --dry-run` to inspect the plan
without calling Cloudflare, or `-- --set-github-vars` to write the non-secret
GitHub Actions variables after provisioning. In GitHub Actions,
`-- --write-github-env` writes those same values into `GITHUB_ENV` so the
current deploy job renders and deploys a Worker that can verify Access JWTs.
`CLAWROUTER_ACCESS_ALLOWED_*` controls who can pass Cloudflare Access;
`CLAWROUTER_ACCESS_ADMIN_*` controls who is an admin inside ClawRouter.
`CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS` creates a separate Service Auth
(`non_identity`) policy for automation. The default path-scoped Access
destinations are `/dashboard/*`, `/v1/session`, `/v1/entitlements`,
`/v1/playground/*`, and `/v1/admin/*`. This stays within Cloudflare's
per-application destination limit while still protecting the console entrypoint
and the Access-backed session, entitlement, playground, and admin APIs. Override
them with `CLAWROUTER_ACCESS_PATHS` only if the API contract changes. Do not add
`/` on the shared API hostname: Cloudflare Access
path inheritance would protect the public `/v1/*` API too. Root reaches Access
by redirecting to `/dashboard`.
Set `CLAWROUTER_ACCESS_IDP_IDS` to one identity provider to enable automatic
redirect to that provider; otherwise Access shows its normal login selector.
When `-- --set-github-vars` is used, managed admin variables are deleted from
GitHub if the corresponding local admin list is empty.

For safety, provisioning refuses to report success when the target Access
application already has extra policies, because a stale broad policy could keep
granting access. Remove the extra policies first, or set
`CLAWROUTER_ACCESS_KEEP_EXTRA_POLICIES=1` when those policies are intentional.

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

Set the queue variables when overriding their defaults. Set the Access
variables when the console is protected by Cloudflare Access:

```text
CLAWROUTER_USAGE_QUEUE                 # optional, defaults to clawrouter-usage
CLAWROUTER_USAGE_DLQ                   # optional, defaults to clawrouter-usage-dead-letter
CLAWROUTER_ACCESS_TEAM_DOMAIN
CLAWROUTER_ACCESS_AUD
CLAWROUTER_ACCESS_ADMIN_EMAILS        # comma-separated admin emails
CLAWROUTER_ACCESS_ADMIN_DOMAINS       # optional comma-separated admin domains
CLAWROUTER_ACCESS_DEFAULT_TENANT      # optional, defaults to default
```

The `Deploy Cloudflare` workflow can provision Access and deploy in one run
when `CLOUDFLARE_API_TOKEN` has Zero Trust Access application/policy
permissions. Dispatch it with `provision_access=true`, set the allowlist inputs
such as `access_allowed_domains=openclaw.ai`, set `access_domain` if the console
host is not `clawrouter.openclaw.ai`, and optionally set `access_admin_emails`
or `access_admin_domains`. The workflow runs
`pnpm cf:access -- --write-github-env` before rendering the Wrangler config, so
the newly created Access audience tag is included in the deployed Worker.

Check the deploy surface without printing secret values:

```sh
pnpm cf:doctor
```

The doctor verifies local deploy env, Wrangler auth, required GitHub Actions
secret names, the provider smoke plan, and provider binding coverage. It reports
provider env names that are missing locally as warnings because provider secrets
normally exist only on the deployed Worker. The mandatory deployed smoke is the
authoritative check that selected live-provider bindings work.
Install the GitHub CLI as `gh`, or set `CLAWROUTER_GITHUB_CLI` when using a
wrapper binary.

Cloudflare moves a message to `CLAWROUTER_USAGE_DLQ` after the usage consumer
exhausts `max_retries`. An unconsumed DLQ retains messages for four days. Treat
any DLQ depth as an operator incident: inspect the failed message, repair the
underlying Durable Object or Worker issue, and replay it to `USAGE_QUEUE`
before that recovery window expires.

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

`CLOUDFLARE_API_TOKEN` must be able to write `POLICY_KV`. This is not just a
preflight nicety: Wrangler rejects deploys for Workers with KV bindings when
the token cannot write the bound namespace.

GitHub deploys render Wrangler config with `CLAWROUTER_OMIT_ROUTES=1` so normal
script updates do not require zone-level Worker route permissions after the
custom domain route has already been provisioned.

Deploy:

```sh
pnpm cf:deploy
```

## Smoke

The deployed smoke checks health, root-to-dashboard redirect behavior, that the
dashboard and session paths are gated before the Worker can return console HTML
or fallback JSON, provider snapshot size, key inspection when a smoke key is
present, and that every provider has an executable smoke target. It must also
run at least one live golden-provider request and writes the timestamped result
to `health/providers/<provider-id>` in `POLICY_KV`:

```sh
export CLAWROUTER_BASE_URL=https://...
export CLAWROUTER_SMOKE_KEY=clawrouter-live-svc_docs-...
export CLAWROUTER_SMOKE_LIVE_PROVIDERS=openai
pnpm cf:smoke
```

Select more golden providers with a comma-separated list:

```sh
export CLAWROUTER_SMOKE_LIVE_PROVIDERS=openai,tavily
pnpm cf:smoke
```

For GitHub Actions deploys, `worker_url`, `live_providers`, and the smoke key
are mandatory. When the current Worker exposes key inspection, preflight blocks
deployment if the smoke credential is invalid or its policy denies a selected
live provider. An unavailable current Worker only warns so first and recovery
deploys remain possible. `all` runs every provider smoke target and requires a
proxy smoke key with access to every selected provider. Readiness reports live
checks as `verified`, `failed`, or `stale`; a configured provider without a live
check is `unverified`.

## Cloudflare Access Console

Protect the Worker route with a Cloudflare Access application. Use
`pnpm cf:access` for the standard `clawrouter.openclaw.ai` route, then set
`CLAWROUTER_ACCESS_TEAM_DOMAIN` to the team domain and `CLAWROUTER_ACCESS_AUD`
to the Access application audience tag before deploying. ClawRouter verifies
the `cf-access-jwt-assertion` signature against the team certs endpoint before
it trusts the email or role.

The browser console is fail-closed in the Worker. `/` redirects to
`/dashboard`, and `/dashboard` redirects to `/dashboard/catalog`; the default
Access app protects `/dashboard/*`.
Old top-level console paths such as `/playground`, `/admin`, `/account`,
`/routes`, and `/console` redirect under `/dashboard`. Public and client-facing surfaces stay under
the API paths such as `/v1`, `/v1/health`, `/v1/providers`, `/v1/routes`, and
proxy endpoints.

After Access is configured, an unauthenticated request to `/` should be handled
by the Worker with a redirect to `/dashboard`, `/dashboard` should redirect to
`/dashboard/catalog`, and `/dashboard/catalog` should be handled by Cloudflare
Access before it reaches the Worker. A raw `401` JSON response with
`access_session_required` on `/dashboard/*` means the Access
application is not protecting the console path or the Worker was deployed
without the Access team/AUD vars.

Access users are materialized automatically on sign-in as enabled `user`
records with no policy bindings. Admins are resolved only from
`CLAWROUTER_ACCESS_ADMIN_EMAILS` or `CLAWROUTER_ACCESS_ADMIN_DOMAINS`;
`access/users/<email>` records do not grant admin rights, and admin rights do
not bypass policy bindings.

```json
{
  "role": "user",
  "tenantId": "default",
  "enabled": true,
  "groups": []
}
```

`GET /v1/session` reports the verified Access session and carries the console
bootstrap entitlements/readiness payload when `POLICY_KV` is available.
`GET /v1/entitlements` remains available for deployments that also protect that
compatibility route. The admin UI can call admin routes through the same-origin
Access session; the admin bearer token is only a fallback for automation or
emergency access.

Admins can inspect materialized Access users, update tenant/status/groups, and
assign explicit user or group policy bindings in the console or API:

```text
GET /v1/admin/access-users
PUT /v1/admin/access-users/<email>
PUT /v1/admin/access-user-grants/<email>
GET /v1/admin/policy-bindings
PUT /v1/admin/policy-bindings
```

`PUT /v1/admin/access-users/<email>` patches identity fields and preserves
omitted fields. `PUT /v1/admin/access-user-grants/<email>` atomically updates
the identity and replaces its complete direct-policy set.

The authoritative record is stored in `ACCESS_CONTROL` and mirrored to
`POLICY_KV` at `access/users/<email>` for compatibility:

```json
{
  "role": "user",
  "tenantId": "default",
  "enabled": true,
  "groups": ["maintainers"]
}
```

Bindings are indexed in `ACCESS_CONTROL` by principal so the request path reads
only the signed-in user and their groups. `POLICY_KV` keeps compatibility
copies:

```json
{
  "policyId": "maintainer_models",
  "principalType": "group",
  "principalId": "maintainers",
  "enabled": true,
  "priority": 10
}
```

Lower priority numbers win when multiple bindings allow the same provider.

The console also exposes a Cloudflare Access-backed playground for
OpenAI-compatible routes and manifest-proxy service routes. Model playground
calls send requests through `/v1/playground/*`; service playground calls send to
the selected `/v1/playground/proxy/<provider>/<endpoint>` route using the same
manifest request wrapper as `/v1/proxy/*`. Upstream calls still obey stored
policy provider allowlists, provider readiness, OAuth grants, and budget limits.

## Admin API

Admin requests use either a verified Cloudflare Access admin session or
`Authorization: Bearer <admin-token>`. For bearer auth, the Worker compares the
SHA-256 hash of that token with `CLAWROUTER_ADMIN_TOKEN_SHA256`; the raw admin
token is never configured in the Worker. Retain the raw token in the operator
secret manager; only its SHA-256 hash belongs in the Worker and GitHub Actions.

```text
GET /v1/admin/overview
GET /v1/admin/tenants
GET /v1/admin/usage
GET /v1/admin/policies
GET /v1/admin/credentials
GET /v1/admin/connections
GET /v1/admin/access-users
GET /v1/admin/policy-bindings
GET /v1/admin/provider-status
GET /v1/admin/provider-health
PUT /v1/admin/access-users/<email>
PUT /v1/admin/access-user-grants/<email>
PUT /v1/admin/policy-bindings
PUT /v1/admin/policies/<policy-id>
PUT /v1/admin/credentials/<credential-id>
PUT /v1/admin/connections/<provider-id>
POST /v1/admin/policies/<policy-id>/revoke
POST /v1/admin/credentials/<credential-id>/revoke
```

Policies, credentials, and provider connections are separate control-plane
records. A policy defines service scope and budgets, a credential contains only
the proxy secret hash plus its `policyId`, and a provider connection can stop a
provider globally. The TypeScript admin UI hashes generated key secrets in the
browser before issuing a credential. Credential ids must use alphanumeric or
underscore characters because the issued live key format is
`clawrouter-live-<credential-id>-<secret>`. Admin policy writes must include
`providers`. Deliberate wildcard policies must send an empty list with
`"allProviders": true`; omitted or implicitly empty scope is rejected. The
console also stores `tokenRole` metadata from policy templates such as
`sandbox`, `user`, `service`, and `ops`; enforcement still comes from the saved
provider allowlist and budget fields.

Legacy `GET|PUT /v1/admin/keys...`, `POST /v1/admin/keys/<kid>/revoke`, and
`GET /v1/admin/users` remain compatibility aliases. The revoke alias treats
`<kid>` as a credential id and never disables a shared policy. The key mutation
API materializes a same-id policy and credential and accepts the same shape as
`pnpm cf:key:put`, but with `secretSha256` instead of a raw key secret.

Access user records are not role-grant records. Cloudflare Access creates the
identity, `access/users/<email>` stores tenant/status/groups, policy bindings
grant service access, and ClawRouter admin rights come from the Access admin
email/domain allowlist configured on the Worker. `ACCESS_CONTROL` makes
policies, credentials, user status, binding mutations, and session grant
resolution strongly consistent. Provider kill switches use one authority object
per provider so proxy traffic does not serialize through a global object.

## Keys and Revocation

Proxy keys use this shape:

```text
clawrouter-live-<kid>-<secret>
```

Register a same-id policy and proxy credential:

```sh
export CLAWROUTER_BASE_URL=https://clawrouter.openclaw.ai
export CLAWROUTER_ADMIN_TOKEN=...
# Required when Cloudflare Access protects /v1/admin/* for automation:
export CF_ACCESS_CLIENT_ID=...
export CF_ACCESS_CLIENT_SECRET=...

printf '%s' "$CLAWROUTER_PROXY_SECRET" | pnpm cf:key:put -- \
  --kid svc_docs \
  --secret-stdin \
  --providers openai,tavily \
  --monthly-budget-micros 100000000 \
  --request-cost-micros 1000
```

Remote key commands call the admin API so serialized authority is updated
before compatibility KV. `--providers` is required unless the operator
deliberately passes `--all-providers`; omitting scope never creates an implicit
wildcard. Policies and credentials carry the same policy generation.
Authorization rejects mixed generations, and replacing an existing id rejects
changing policy scope and secret in the same operation. `--local` writes local
KV only for bootstrap and tests; it is not an authoritative way to mutate a
running Worker.

Revoke access:

```sh
pnpm cf:key:revoke -- --kid svc_docs
```

The edge runtime checks serialized `ACCESS_CONTROL` authority on proxy
requests. Disabling a credential revokes one issued key. Disabling a policy
revokes every credential, Access user, and Access group bound to it. Neither
operation rotates upstream provider credentials. Never use `--local` to revoke
a deployed credential.

Inspect a key without making an upstream provider call:

```sh
curl "$CLAWROUTER_BASE_URL/v1/key/inspect" \
  -H "authorization: Bearer $CLAWROUTER_KEY"
```

When `ACCESS_CONTROL` and `POLICY_KV` are bound, the response verifies syntax,
registration, secret hash, enabled state, tenant, budget, and provider
allowlist. The endpoint never returns the key secret or stored secret hash.

The stored policy and credential shapes are separate:

```json
{
  "enabled": true,
  "generation": "policy_...",
  "providers": ["openai", "tavily"],
  "tenantId": "default",
  "tokenRole": "service",
  "monthlyBudgetMicros": 100000000,
  "requestCostMicros": 1000
}
```

```json
{
  "enabled": true,
  "secretSha256": "<sha256 of key secret>",
  "policyId": "svc_docs",
  "policyGeneration": "policy_..."
}
```

`providers` is an allowlist. The admin API requires at least one provider;
`pnpm cf:key:put` requires `--providers` or the explicit `--all-providers` flag.
A raw stored policy with an empty list allows every configured provider and
should be reserved for deliberate operator use. `monthlyBudgetMicros: 0` denies
requests immediately. A non-zero `monthlyBudgetMicros` uses the `BUDGET_LEDGER`
Durable Object before upstream calls and charges `requestCostMicros` per
accepted request. If `requestCostMicros` is omitted, ClawRouter charges one
micro unit per request so budget enforcement still works for keys with a
monthly budget.

## OAuth Grants

OAuth-backed providers read access tokens from `POLICY_KV`. Register a grant
for one access policy:

```sh
printf '%s' "$PROVIDER_ACCESS_TOKEN" | pnpm cf:oauth:put -- \
  --kid svc_docs \
  --token-ref oauth.provider.access_token \
  --access-token-stdin
```

Tenant-wide grants are also supported:

```sh
pnpm cf:oauth:put -- \
  --tenant default \
  --token-ref oauth.provider.access_token \
  --access-token-env PROVIDER_ACCESS_TOKEN
```

This stores a grant at `oauth/<policy-id>/<tokenRef>` or
`oauth/tenants/<tenant>/<tokenRef>`. Active grant records contain `enabled`,
`accessToken`, and `tokenType`; the token is never printed by the helper.

Revoke a grant without deleting audit history:

```sh
pnpm cf:oauth:revoke -- --kid svc_docs --token-ref oauth.provider.access_token
```

Revocation overwrites the grant with a disabled tombstone and removes the stored
access token.

## Proxy Routes

OpenAI-compatible calls use normal OpenAI paths and route by `model`:

```sh
curl "$CLAWROUTER_BASE_URL/v1/chat/completions" \
  -H "authorization: Bearer $CLAWROUTER_KEY" \
  -H "content-type: application/json" \
  --data '{"model":"openai/gpt-4.1-mini","messages":[{"role":"user","content":"ok"}]}'
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
export CLAWROUTER_SMOKE_KEY=clawrouter-live-svc_docs-...
export CLAWROUTER_SMOKE_LIVE_PROVIDERS=openai
pnpm cf:smoke
```
