# ClawRouter

ClawRouter is a high-throughput API gateway and provider router for OpenClaw services.

It brokers proxy keys, service identities, versioned upstream grants, budgets, and metered usage across model providers, search APIs, tool APIs, and future service providers.

Current implementation target:

- TypeScript data plane on Cloudflare Workers
- Durable Object budget ledgers
- serialized Durable Object access-control authority
- tenant/policy-sharded Durable Object usage ledgers
- TypeScript admin/control UI
- declarative service provider manifests
- OpenClaw-native `clawrouter-` key routing
- Cloudflare KV-backed one-time migration seeds, version 1
  API-key/OAuth/subscription grants, assignment rules, and provider health

## OpenClaw client

OpenClaw includes a bundled `@openclaw/clawrouter` plugin. One policy-scoped
credential discovers allowed models, routes supported OpenAI-compatible and
native provider protocols, and reports managed budget usage without installing
or authenticating every upstream provider plugin on the OpenClaw host.

See [Use ClawRouter with OpenClaw](docs/openclaw.md) for credential setup,
dynamic model discovery, multi-provider smoke tests, and quota verification.

## Provider Registry

Provider support is data-driven. Most integrations are added by creating one file:

```text
providers/<service>.provider.yaml
```

That file declares the service id, auth scheme, OAuth platform mapping when needed,
base URLs, route templates, adapter family, model/capability mapping, and billing
meters. The TypeScript compiler turns those files into a provider snapshot consumed by
the edge runtime and admin UI.

Built-in starter coverage:

- model APIs: OpenAI, Anthropic, Google Gemini, Azure OpenAI, AWS Bedrock,
  MiniMax, Mistral, Cohere, xAI, Groq, Perplexity, DeepSeek, Together, Fireworks,
  Hugging Face, Replicate, and operator-hosted OpenAI-compatible runtimes such as
  Ollama and LM Studio
- gateway APIs: OpenRouter, Cloudflare AI Gateway
- tool/API platforms: Tavily, Firecrawl (keyless starter access; API key
  optional for higher limits)

Amazon Bedrock support signs native `InvokeModel` and
`InvokeModelWithResponseStream` calls from the Cloudflare Worker. It uses
model-specific JSON rather than OpenAI or Converse normalization. See
[Amazon Bedrock](docs/aws-bedrock.md) for IAM, credentials, Region, policy,
headers, invocation, smoke-test, and limitation details.

Validate the catalog with:

```sh
pnpm provider:compile
```

Before a real Cloudflare deploy, run:

```sh
pnpm cf:doctor
```

It checks Wrangler auth, required GitHub Actions secret names, local deploy env,
provider binding coverage, and the all-provider smoke plan without printing
secret values. Real deploys require at least one live golden-provider smoke;
the result is persisted in `POLICY_KV` so readiness distinguishes verified,
failed, stale, unverified, and disabled providers.

The browser console is meant to sit behind Cloudflare Access. Provision that
edge gate with:

```sh
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
CLAWROUTER_ACCESS_GITHUB_ORGS=openclaw \
CLAWROUTER_ACCESS_ADMIN_EMAILS=you@example.com \
pnpm cf:access
```

Then redeploy with the printed `CLAWROUTER_ACCESS_TEAM_DOMAIN` and
`CLAWROUTER_ACCESS_AUD` values. `/` redirects to the Access-protected
`/dashboard` path, `/dashboard` redirects to the role-aware `/dashboard/home`, and canonical console views live under `/dashboard/*`, while
public `/v1` catalog and proxy routes stay normal. The Access app must also
protect `/v1/session*`, `/v1/playground/*`, `/v1/admin/*`, and
`/v1/oauth/callback` so the browser console can bootstrap identity,
entitlements, session quota usage, playground calls, admin mutations, and OAuth callbacks from a
verified Access session. A ClawRouter `access_session_required` JSON body on
`/dashboard/*`, `/v1/session`, `/v1/session/usage`, `/v1/playground/*`, or `/v1/oauth/callback` means the Access app is not
in front of that console path yet, and `pnpm cf:smoke` treats that as a failed
deployment smoke.

The `Deploy Cloudflare` workflow can do the Access step too: dispatch it with
`provision_access=true` after adding a `CLOUDFLARE_API_TOKEN` that can manage
Zero Trust Access apps and policies. The production default admits verified
members of the `openclaw` GitHub organization through the configured GitHub
identity provider. GitHub organization and team assignment rules use that
same-origin, verified Access identity to bind or revoke the user's managed
policy; no browser-supplied organization claim is trusted. Real deploys also require KV write
permission because Wrangler validates the Worker `POLICY_KV` binding while
publishing. Keep `access_domain` set to the console hostname; `worker_url` is
only the post-deploy smoke-test target.

## Edge Proxy

The Worker currently exposes:

- `GET /v1/health`
- `GET /v1/providers`
- `GET /v1/routes`
- `GET /v1/session`
- `GET /v1/entitlements`
- `GET /v1/me`
- `GET /v1/usage`
- `GET /v1/models`
- `GET /v1/catalog`
- `GET /v1/oauth/callback`
- `GET /v1/key/inspect`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/proxy/<provider>/<endpoint>`
- `<METHOD> /v1/native/<provider>/<provider-native-path>`
- `GET /v1/admin/overview`
- `GET /v1/admin/bootstrap`
- `GET /v1/admin/tenants`
- `GET /v1/admin/usage`
- `GET /v1/admin/policies`
- `GET /v1/admin/credentials`
- `GET /v1/admin/connections`
- `GET /v1/admin/access-users`
- `GET /v1/admin/policy-bindings`
- `GET /v1/admin/provider-status`
- `GET /v1/admin/provider-health`
- `GET /v1/admin/upstream-grants`
- `GET /v1/admin/assignment-rules`
- `GET /v1/admin/fusion`
- `PUT /v1/admin/access-users/<email>`
- `PUT /v1/admin/access-user-grants/<email>`
- `PUT /v1/admin/policy-bindings`
- `PUT /v1/admin/policies/<policy-id>`
- `PUT /v1/admin/credentials/<credential-id>`
- `PUT /v1/admin/connections/<provider-id>`
- `PUT /v1/admin/upstream-grants/<policies|tenants>/<scope-id>/<token-ref>`
- `PUT /v1/admin/assignment-rules/<rule-id>`
- `PUT /v1/admin/fusion`
- `POST /v1/admin/policies/<policy-id>/revoke`
- `POST /v1/admin/credentials/<credential-id>/revoke`
- `POST /v1/admin/upstream-grants/<policies|tenants>/<scope-id>/<token-ref>/revoke`
- `POST /v1/admin/upstream-grants/<policies|tenants>/<scope-id>/<token-ref>/refresh`
- `POST /v1/admin/upstream-grants/<policies|tenants>/<scope-id>/<token-ref>/authorize`
- `POST /v1/admin/assignment-rules/reconcile`

Legacy `GET|PUT /v1/admin/keys...`, `POST /v1/admin/keys/<kid>/revoke`, and
`GET /v1/admin/users` remain compatibility aliases during migration. New
control-plane clients should use policies, credentials, and tenants directly.
The legacy revoke alias treats `<kid>` as a credential id and never disables a
shared policy.

OpenAI-compatible proxy requests route by the request body `model` field, for
example `openai/gpt-4.1-mini`. Before an upstream provider secret is used, the
Worker verifies the issued credential and its policy from serialized
`ACCESS_CONTROL` Durable Object authority. `credentials/<credential-id>` and
`policies/<policy-id>` in `POLICY_KV` are one-time migration seeds:

```json
{"enabled":true,"secretSha256":"<sha256 of key secret>","policyId":"team_docs","policyGeneration":"policy_..."}
```

```json
{
  "enabled": true,
  "generation": "policy_...",
  "providers": ["openai"],
  "allProviders": false,
  "tenantId": "team_docs",
  "tokenRole": "service",
  "monthlyBudgetMicros": 100000000
}
```

Policy and credential generations must match. Strongly consistent authority
writes make revocation and scope reductions immediate; generation mismatches
still fail closed during migration or incomplete rotations. Canonical policy
edits preserve their generation. The legacy key mutation alias rejects changing
policy scope and secret together.

`clawrouter/fusion` is an optional virtual chat model. Selecting it fans a
bounded text-only prompt out to as many as four configured adviser models,
then asks one configured synthesizer model for the final response. Every
subrequest uses normal ClawRouter policy, budget, retention, readiness, and
usage-accounting paths. Configure it under **Access → Fusion**; see
[Fusion routing](docs/fusion-router.md) for architecture, local-runtime setup,
security boundaries, and cost behavior.

`GET /v1/catalog` is the credential-scoped client integration contract. It
returns only allowed providers and executable models. Each provider row reports
whether the unified OpenAI-compatible `/v1` route is available, its native proxy
base URL, and the request/response formats for its executable native routes.
Clients can use those fields to choose the real provider transport without
guessing from provider ids.

Disable a credential to revoke one issued key, disable a policy to revoke every
user and credential bound to it, or disable a provider connection to stop that
provider globally. Legacy `keys/<kid>` records remain readable during
migration only when they are genuine pre-migration records. Generation-bearing
compatibility records stay disabled and are never authorization fallback. See
`docs/deploy-cloudflare.md` for Cloudflare provisioning, deployment, key
registration, and smoke commands.

The legacy-named `pnpm cf:oauth:put` and `pnpm cf:oauth:revoke` helpers write
canonical version 1 upstream-grant records for `api_key`, `oauth`, and
`subscription` connections. They accept access tokens, refresh tokens, and
single- or multi-field credentials only through stdin, environment variables,
or files, never argv.
Revocation retains grant metadata in a disabled tombstone while removing
secrets. See `docs/deploy-cloudflare.md` for the complete operator flow.

The admin API and console can register multiple token references for the same
scope and provider. ClawRouter maintains a bounded pool index outside the
secret-bearing grant records, prefers the lowest numeric `priority`, and uses
the canonical grant key as the deterministic tie-breaker. Existing grants
whose token reference is the provider id remain compatible without an index.

Admin endpoints accept a verified Cloudflare Access admin session or
`Authorization: Bearer <admin-token>` against `CLAWROUTER_ADMIN_TOKEN_SHA256`.
Provider-approved browser OAuth starts only from a verified Access admin
session, uses a one-time PKCE state, and stores the resulting grant without
returning provider tokens to the browser.
The browser console hashes generated proxy key secrets in-browser before
issuing a credential, manages policies separately from credentials and provider
connections, assigns explicit user/group policy bindings, shows provider
readiness and request audit, and includes a Cloudflare Access-backed playground
for model and manifest-proxy service routes. Admin rights come from the Access
admin allowlist, not editable user rows, and do not imply provider access.

Generic REST/tool proxy requests are manifest-driven:

```sh
curl "$CLAWROUTER_BASE_URL/v1/proxy/tavily/search" \
  -H "authorization: Bearer $CLAWROUTER_KEY" \
  -H "content-type: application/json" \
  --data '{"body":{"query":"openclaw"},"query":{"topic":"news"}}'
```

The Worker resolves `provider` and `endpoint` from the compiled provider
snapshot, applies manifest path/query/header/auth mapping, forwards the request,
and emits a usage event to `USAGE_QUEUE`. The same Worker consumes that queue
into tenant/policy-sharded, bounded `USAGE_LEDGER` reporting Durable Objects and
replays unsettled budget updates. Audit events retain
identity, policy, credential, provider, route capability, model, timing,
outcome, tokens when safely available, and cost for 30 days. Prompt and
completion bodies are never stored in the usage ledger. LLM request bodies are stored separately for
30 days when the access policy enables request-content retention (the default)
and the credential owner is not exempt; see [Content retention](docs/content-retention.md).
`/v1/usage` returns the caller policy's
budget plus usage summary; `/v1/admin/usage` returns budget rows plus the
all-tenant usage summary and recent request audit.

Budgeted requests reserve an upper-bound token cost before the upstream call
when the selected model has versioned pricing in its provider manifest. An
explicit policy `requestCostMicros` remains a fixed-cost override; unpriced
routes retain the one-micro fallback only outside monthly budgets. Budgeted
calls without versioned pricing fail closed. Successful responses settle
their actual token cost, including cached input when reported. SSE responses are metered
inline without buffering the client stream. Missing or interrupted usage stays
charged at the conservative reservation; non-2xx and transport failures refund
the reservation. Failed settlement calls are persisted to `USAGE_QUEUE` for
durable retry while the reservation remains charged fail-closed. Settlement and
audit delivery are independent: failure of either cannot suppress the provider
response or the other accounting operation. Messages that exhaust automatic retries move to the
separate usage DLQ for operator inspection and replay before Cloudflare's
four-day unconsumed-DLQ retention expires. Internal reservation ids are
generated independently from caller-supplied request ids.

Codex and Claude Code integration, pricing fields, reservation semantics, and
agent attribution headers are documented in
[`docs/agent-spend-control.md`](docs/agent-spend-control.md).
OAuth, SigV4, and deployment-templated providers execute through the same
policy-enforced proxy when their manifest-declared grant and remaining runtime
configuration are present. Provider secrets can come from scoped upstream
grants instead of Worker-global bindings.

Control-plane boundaries, migration rules, refresh behavior, and failure
semantics are summarized in [Architecture](docs/architecture.md).
