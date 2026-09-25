# Deploy ClawRouter on Cloudflare

ClawRouter’s edge runtime is a TypeScript Worker. Revocation-critical runtime
policy lives in serialized Durable Object authority so access can be revoked
without a redeploy. Per-grant Durable Objects own upstream credential material
and serialize OAuth rotation. Cloudflare KV stores one-time migration seeds,
assignment rules, redacted grant metadata, and operational health.

For the isolated non-production profile used by AWS FakeCo clients, follow
[FakeCo staging](fakeco.md). Its locked resource names and dedicated workflow
must be used instead of overriding the production deployment ad hoc.

## Required Bindings

- `POLICY_KV`: one-time migration seeds for access policies, issued credential
  hashes, principal bindings, users, and provider connections, plus assignment
  rules, OAuth grants, and provider health records. After each resource family
  is marked migrated, request paths do not fall back to its KV records.
- `USAGE_QUEUE`: metered usage events and durable budget-settlement retries,
  with this Worker configured as producer and consumer.
- usage DLQ, named by `CLAWROUTER_USAGE_DLQ`: separate queue for usage or
  settlement messages that exhaust automatic retries.
- `BUDGET_LEDGER`: SQLite-backed Durable Object budget ledger.
- `ACCESS_CONTROL`: SQLite-backed Durable Object authority for policies,
  credential hashes, user state, provider kill switches, serialized user/group
  policy-binding mutations, and session entitlement lookup.
- `GRANT_CREDENTIALS`: one Durable Object per upstream grant. It owns raw API
  keys and OAuth tokens, serializes refresh, and commits rotating access and
  refresh tokens as one generation.
- `USAGE_LEDGER`: tenant/policy-sharded SQLite-backed Durable Object request
  audit and reporting ledgers. They retain bounded metadata for 30 days and never store prompt or
  completion bodies. Request content retention uses the separate `CONTENT_ARCHIVE`
  R2 binding and never writes bodies to this ledger.
- `CONTENT_ARCHIVE`: encrypted R2 storage for policy-retained LLM request bodies.
  `pnpm cf:deploy` creates the bucket and installs a 30-day lifecycle rule before
  every deploy. Run `pnpm cf:content:provision` directly when provisioning only.
- provider secrets such as `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `MINIMAX_API_KEY`, and `TAVILY_API_KEY`.
- provider config vars required by the selected routes, such as
  `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION`, and `AWS_REGION`.

`OPENROUTER_SITE_URL` is optional attribution. OpenRouter requests require an
API key; set the site URL only when you want the `HTTP-Referer` attribution header.

`FIRECRAWL_API_KEY` is optional: Firecrawl's scrape route is usable without it
at the provider's free rate limit. Configure it when higher Firecrawl limits
are required.

## Provision

Set the account and API token before creating the runtime resources. The token
needs queue creation and Workers KV Storage Write permissions:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
pnpm cf:provision
```

Both production and FakeCo create KV through the Cloudflare API using the exact
deployment namespace title. Missing credentials stop provisioning before any
resource changes. An existing namespace title is an error; inspect its ID with
`pnpm exec wrangler kv namespace list` before configuring an existing deployment.

Protect the browser console with Cloudflare Access before treating the custom
domain as ready:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=... # must be able to manage Zero Trust Access apps/policies
export CLAWROUTER_ACCESS_GITHUB_ORGS=openclaw
export CLAWROUTER_ACCESS_ADMIN_EMAILS=you@example.com
export CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS=... # Cloudflare service-token UUIDs, not client IDs
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
`CLAWROUTER_ACCESS_GITHUB_ORGS` accepts `org` or `org/team` selectors and
resolves the account's sole GitHub identity provider. Set
`CLAWROUTER_ACCESS_GITHUB_IDP_ID` when multiple GitHub identity providers
exist, or set one `CLAWROUTER_ACCESS_IDP_IDS` value when the deployment token
cannot list identity providers. `CLAWROUTER_ACCESS_ALLOWED_*` remains available for explicit email or
email-domain exceptions; multiple include rules are ORed by Cloudflare Access.
These settings control who can pass Cloudflare Access;
`CLAWROUTER_ACCESS_ADMIN_*` controls who is an admin inside ClawRouter.
`CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS` is required for managed Access provisioning
and creates a separate Service Auth (`non_identity`) policy for automation.
Missing, duplicate, or malformed UUIDs fail before any Cloudflare request, so
omitting the variable cannot delete the recovery service policy. Use the matching
client ID and secret as the request headers; the UUID belongs in the policy.
See [Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).
The default path-scoped Access
destinations are `/dashboard/*`, `/v1/session*`, `/v1/playground/*`,
`/v1/admin/*`, and `/v1/oauth/callback`. This stays within Cloudflare's
five-destination per-application limit while still protecting the console
entrypoint and the Access-backed session and quota usage, playground, admin, and OAuth callback
APIs. `/v1/entitlements` still verifies the Access JWT inside the Worker, but is
not a separate Access application destination. Override
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
CLAWROUTER_ADMIN_TOKEN                  # raw token matching the digest, for authenticated recovery
CLAWROUTER_POLICY_KV_ID
CLAWROUTER_POLICY_KV_PREVIEW_ID
CLAWROUTER_SMOKE_KEY
CLAWROUTER_ACCESS_CLIENT_ID             # required when Access protects the admin route
CLAWROUTER_ACCESS_CLIENT_SECRET         # configure together with the client ID
CLAWROUTER_CLOUDFLARE_AI_GATEWAY_OPENAI_API_KEY # optional smoke-only upstream key
```

Set the queue variables when overriding their defaults. Set the Access
variables when the console is protected by Cloudflare Access. Bedrock also
uses one non-secret Region variable:

```text
CLAWROUTER_USAGE_QUEUE                 # optional, defaults to clawrouter-usage
CLAWROUTER_USAGE_DLQ                   # optional, defaults to clawrouter-usage-dead-letter
CLAWROUTER_CONTENT_BUCKET              # optional, defaults to clawrouter-content
CLAWROUTER_ACCESS_TEAM_DOMAIN
CLAWROUTER_ACCESS_AUD
CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS   # comma-separated service-token UUIDs; required for cf:access
CLAWROUTER_ACCESS_ADMIN_EMAILS        # comma-separated admin emails
CLAWROUTER_ACCESS_ADMIN_DOMAINS       # optional comma-separated admin domains
CLAWROUTER_ACCESS_DEFAULT_TENANT      # optional, defaults to default
CLAWROUTER_PROVIDER_AWS_REGION        # non-secret Bedrock Region, for example us-east-1
```

The `Deploy Cloudflare` workflow can provision Access and deploy in one run
when `CLOUDFLARE_API_TOKEN` has Zero Trust Access application/policy
permissions. Both deployment workflows require `expected_sha`, the reviewed
full 40-character commit SHA. Existing UI, CLI, and API dispatch callers must
supply this new field. Select the branch or tag pointing to that exact commit;
the first step refuses a different event SHA before checkout, setup, install,
or preflight. A second check verifies actual checkout `HEAD` before dependency
execution. The input does not select a custom checkout ref or fall back to the
latest commit. If the selected ref advances, review the new source before
dispatching again with its SHA.

Only refs containing the revised workflows carry these checks; older workflow
refs retain their earlier behavior. Controlled deployments use guarded `main`
with a frozen, reviewed `expected_sha`.

Dispatch production with `provision_access=true` to provision Access; the repository default
uses `access_github_orgs=openclaw` and no email-domain exception. Set
`access_domain` if the console
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

For a controlled bulk rotation, the deploy workflow can stream temporary
repository secrets to `wrangler secret bulk` without writing values to disk.
Store each temporary transport secret as
`CLAWROUTER_PROVIDER_<WORKER_BINDING>`, dispatch with
`configure_provider_secrets=true`, verify the live provider smoke, then delete
the temporary GitHub secrets. `pnpm cf:secrets -- --dry-run` prints binding
names only; the live command sends a JSON object to Wrangler over stdin.

Provider configuration values are not included in that secret bulk operation.
In particular, `AWS_REGION` is a non-secret Worker variable rendered under
`[vars]`, not a Wrangler secret.

AWS Bedrock uses SigV4. Bind these values before enabling the Bedrock provider:

```sh
export AWS_REGION=us-east-1
pnpm cf:config
pnpm exec wrangler secret put AWS_ACCESS_KEY_ID --config .wrangler.generated.toml
pnpm exec wrangler secret put AWS_SECRET_ACCESS_KEY --config .wrangler.generated.toml
pnpm exec wrangler secret put AWS_SESSION_TOKEN --config .wrangler.generated.toml # optional
```

For GitHub Actions, set `CLAWROUTER_PROVIDER_AWS_REGION` as a repository
variable. The deploy workflow maps it to `AWS_REGION` while rendering the
Worker; provider secret bulk uploads only the access key, secret key, and
optional session token. See [Amazon Bedrock](aws-bedrock.md) for IAM,
credential grants, raw request formats, fixed-cost policy requirements, and
live smoke configuration.

Cloudflare AI Gateway needs the gateway coordinates plus the API token used for
gateway authentication. The manifest binds account and gateway IDs from Worker
config, not caller-supplied path parameters.

The existing universal route accepts Cloudflare's ordered array of provider
requests through `/v1/proxy/cloudflare-ai-gateway/universal` (in `body`) or
`/v1/native/cloudflare-ai-gateway/` (as the request body). Cloudflare
[continues to support this deprecated endpoint](https://developers.cloudflare.com/ai-gateway/usage/universal/)
for existing integrations. An enforced budget requires a fixed policy request
price because the fallback array has no single model price. Request retention
omits per-entry credential headers; see [the retention contract](content-retention.md).

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

Before deploying, select at least one golden provider and supply a proxy key
that can use it. Deployment runs that smoke after account recovery:

```sh
export CLAWROUTER_SMOKE_KEY=clawrouter-live-svc_docs-...
export CLAWROUTER_SMOKE_LIVE_PROVIDERS=openai
```

Also set the raw `CLAWROUTER_ADMIN_TOKEN` matching the deployed SHA256 and the
`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` pair when Access requires it.
Preflight requires both Access values when an Access team domain or audience is
configured, or `CLAWROUTER_PREFLIGHT_REQUIRE_ACCESS=1`. A deployment without
Access does not need the pair. For hosted `provision_access=true`, the first
preflight validates recovery credentials without requiring the new app's
audience. After provisioning, a second preflight requires the generated Access
configuration before rendering and deploying the Worker.
The manual runner resolves the deployment URL once: an explicit
`CLAWROUTER_BASE_URL`, otherwise the configured route hostname, otherwise the
production default. It passes that URL to preflight, recovery, and smoke.
FakeCo retains its locked target and confirmation requirements.

Deploy:

```sh
pnpm cf:deploy
```

Missing smoke inputs or invalid recovery credentials stop before deployment
permission probes and resource mutations. A failed account recovery after
deployment stops smoke and leaves the running admin recovery surface available;
it does not accept a baseline or roll back the Worker automatically.

## Smoke

The deployed smoke checks health, root-to-dashboard redirect behavior, that the
dashboard and session paths are gated before the Worker can return console HTML
or fallback JSON, provider snapshot size, key inspection when a smoke key is
present, and that every provider has an executable smoke target. It must also
run at least one live golden-provider request and writes the timestamped result
to `health/providers/<provider-id>` in `POLICY_KV`:

```sh
export CLAWROUTER_BASE_URL=https://...
pnpm cf:smoke
```

Each provider POST has a unique request ID. After recording its health result,
the smoke uses the same key to poll `GET /v1/usage` for that request's successful
event, matching provider and HTTP status. It reports the independent event ID
only after observing the event in the caller's durable usage snapshot.
Polling lasts at most 60 seconds **per successful provider**, with a two-second
interval and a ten-second limit covering each fetch, body read, and disposal.
This does not bound the existing provider POST or the entire smoke run.
Authentication, redirects, unsupported endpoints, and malformed snapshots fail
visibly; transient reads and missing events retry within that bound. A failed
usage check preserves the provider health result and does not repeat the POST.
All selected providers still run before failures are reported.

The snapshot exposes only the latest 100 caller-visible events. A busy caller
can evict a smoke event before inspection, so timeout means visibility is
unconfirmed, not proof of data loss. Inspect usage and queue delivery before
deciding on another paid request. This check proves event visibility, not budget
settlement or the contents of the ingestion acknowledgment.

Select more golden providers with a comma-separated list:

```sh
export CLAWROUTER_SMOKE_LIVE_PROVIDERS=openai,tavily
pnpm cf:smoke
```

Bedrock live smokes require a model and matching model-native body. The default
targets Amazon Nova; override both together when the Region, IAM policy, or
model differs:

```sh
export CLAWROUTER_SMOKE_LIVE_PROVIDERS=aws-bedrock
export CLAWROUTER_SMOKE_MODEL_AWS_BEDROCK=bedrock/amazon.nova-lite-v1:0
export CLAWROUTER_SMOKE_BODY_AWS_BEDROCK='{"schemaVersion":"messages-v1","messages":[{"role":"user","content":[{"text":"Reply with exactly: ok"}]}],"inferenceConfig":{"maxTokens":16}}'
pnpm cf:smoke
```

See [Amazon Bedrock](aws-bedrock.md) before selecting another model: request
bodies are model-specific and the smoke operation is raw `InvokeModel`.

For GitHub Actions deploys, `worker_url`, `live_providers`, and the smoke key
are mandatory. When the current Worker exposes key inspection, preflight blocks
deployment if the smoke credential is invalid or its policy denies a selected
live provider. An unavailable current Worker only warns so first and recovery
deploys remain possible. `all` runs every provider smoke target and requires a
proxy smoke key with access to every selected provider. Readiness reports live
checks as `verified`, `failed`, or `stale`; a configured provider without a live
check is `unverified`.

The deploy workflow's optional `openai_smoke_model` input selects the OpenAI
smoke model. Leave it empty to use the first eligible catalog model, currently
`openai/gpt-5.6`. Set `live_providers=openai` and
`openai_smoke_model=openai/gpt-6-astra` to use Astra for that same single provider
request. This does not reorder models or change keys or budgets. For a local
smoke, the equivalent existing override is
`CLAWROUTER_SMOKE_MODEL_OPENAI=openai/gpt-6-astra`.

The Chat smoke keeps its small 16-token cap. The router maps it to
`max_completion_tokens` for Astra, which includes reasoning tokens, so the
request may produce no visible answer. A successful smoke proves the HTTP
request and its durable usage-event visibility; it does not validate generated
text, WebSockets, or native Codex behavior.

## Cloudflare Access Console

Protect the Worker route with a Cloudflare Access application. Use
`pnpm cf:access` for the standard `clawrouter.openclaw.ai` route, then set
`CLAWROUTER_ACCESS_TEAM_DOMAIN` to the team domain and `CLAWROUTER_ACCESS_AUD`
to the Access application audience tag before deploying. ClawRouter verifies
the `cf-access-jwt-assertion` signature against the team certs endpoint before
it trusts the email or role.

`pnpm cf:access` reads every page of the account's Access applications before
making changes. It updates the unique self-hosted app whose primary domain or
public destination exactly matches a configured protected path or the bare
`CLAWROUTER_ACCESS_DOMAIN` hostname. An existing app's display name can differ;
the update keeps its ID and audience tag. Display names alone never select an
app for update.

If multiple apps match, resolve their overlapping destinations in Cloudflare
before rerunning. If only the display name matches another destination, verify
`CLAWROUTER_ACCESS_DOMAIN` or choose a distinct `CLAWROUTER_ACCESS_APP_NAME` for
the new deployment. Both cases stop before app or policy writes. A new app is
created only when neither destination nor name matches. Policy checks also read
every page before applying the existing unmanaged-policy guard.

The browser console is fail-closed in the Worker. `/` redirects to
`/dashboard`, and `/dashboard` redirects to `/dashboard/home`; the default
Access app protects `/dashboard/*`.
Old top-level console paths such as `/playground`, `/admin`, `/account`,
`/routes`, and `/console` redirect under `/dashboard`. Public and client-facing surfaces stay under
the API paths such as `/v1`, `/v1/health`, `/v1/providers`, `/v1/routes`, and
proxy endpoints.

After Access is configured, an unauthenticated request to `/` should be handled
by the Worker with a redirect to `/dashboard`, `/dashboard` should redirect to
`/dashboard/home`, and `/dashboard/home` should be handled by Cloudflare
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

`GET /v1/session` reports the verified Access session and carries its
policy-scoped entitlements/readiness payload.
`GET /v1/entitlements` remains available for deployments that also protect that
compatibility route. The admin UI can call admin routes through the same-origin
Access session; the admin bearer token is only a fallback for automation or
emergency access. Browser OAuth providers return to `/v1/oauth/callback`, which
must also require the same verified Access admin session that started the flow.

Admins can inspect materialized Access users, update tenant/status/groups, and
assign explicit user or group policy bindings in the console or API:

```text
GET /v1/admin/access-users
PUT /v1/admin/access-users/<email>
PUT /v1/admin/access-user-grants/<email>
GET /v1/admin/policy-bindings
PUT /v1/admin/policy-bindings
GET /v1/admin/assignment-rules
PUT /v1/admin/assignment-rules/<rule-id>
POST /v1/admin/assignment-rules/reconcile
```

`PUT /v1/admin/access-users/<email>` patches identity fields and preserves
omitted fields. `PUT /v1/admin/access-user-grants/<email>` atomically updates
the identity and replaces its complete direct-policy set.

The authoritative record is stored in `ACCESS_CONTROL`. A pre-existing
`POLICY_KV` record at `access/users/<email>` is imported once during migration:

```json
{
  "role": "user",
  "tenantId": "default",
  "enabled": true,
  "groups": ["maintainers"]
}
```

Bindings are indexed in `ACCESS_CONTROL` by principal so the request path reads
only the signed-in user and their groups. Pre-existing `POLICY_KV` records are
one-time migration input:

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

Automatic assignment rules are stored separately from users and manual
bindings. Authentication performs at most one assignment-state migration;
unchanged sessions are read-only. Saving a rule reconciles known users, and the
admin endpoint supports explicit reconciliation with verified external
evidence. Policy grants
use a rule-owned `assignment.<rule-id>` group, so reconciliation never replaces
manual direct user bindings. On a GitHub Access sign-in, the Worker reads
Cloudflare Access's same-origin identity endpoint, requires the identity email
to match the verified Access JWT, and uses its organization/team records as
verified evidence for enabled GitHub rules. This refresh also enforces
`revokeOnLoss` when organization or team membership changes; unchanged evidence
does not write authority state. The cookie and raw identity response are never stored. Explicit admin reconciliation remains
available; a reconcile without GitHub evidence retains existing GitHub-derived
assignments instead of treating unknown membership as loss.

```json
{
  "enabled": true,
  "kind": "email_domain",
  "subject": "example.com",
  "groups": ["maintainers"],
  "policyIds": ["maintainer_models"],
  "priority": 10,
  "revokeOnLoss": true,
  "provenance": "cloudflare_access"
}
```

Use `POST /v1/admin/assignment-rules/reconcile` with `{"all":true}` to
reconcile all known users against email rules. For a verified GitHub
reconciliation, send one `email` plus an evidence object with `source:
"github"`, `verified: true`, and normalized `githubOrgs`/`githubTeams`.

The console also exposes a Cloudflare Access-backed playground for
OpenAI-compatible routes and manifest-proxy service routes. Model playground
calls send requests through `/v1/playground/*`; service playground calls send to
the selected `/v1/playground/proxy/<provider>/<endpoint>` route using the same
manifest request wrapper as `/v1/proxy/*`. Upstream calls still obey stored
policy provider allowlists, provider readiness, OAuth grants, and budget limits.

## Session credential API

A verified Cloudflare Access session can manage proxy credentials owned by its
normalized email. These routes do not require the admin role:

```text
GET /v1/session/credentials
PUT /v1/session/credentials/<credential-id>
POST /v1/session/credentials/<credential-id>/revoke
```

`GET` returns only the caller's credentials as `credentialId`, `policyId`,
`enabled`, and `active`. `PUT` accepts `policyId` and `secretSha256`; the Worker
forces `principalId` to the signed-in email, binds the current policy generation,
and rejects policies outside the session's effective user and group bindings.
Credential ids use 4-128 alphanumeric or underscore characters. A principal may
have at most ten enabled credentials, while rotating an existing owned id remains
allowed. To bound control-plane storage, old disabled self-service records are
pruned once a principal reaches 100 retained ids. Existing ids owned by another principal cannot be claimed. Mutation
requests require a same-origin browser request. The console generates 24 random
secret bytes, sends only their SHA-256 digest, and reveals the complete
`clawrouter-live-<credential-id>-<secret>` key once.

## Admin API

Admin requests use either a verified Cloudflare Access admin session or
`Authorization: Bearer <admin-token>`. For bearer auth, the Worker compares the
SHA-256 hash of that token with `CLAWROUTER_ADMIN_TOKEN_SHA256`; the raw admin
token is never configured in the Worker. Retain the raw token in the operator
secret manager; only its SHA-256 hash belongs in the Worker and GitHub Actions.

```text
GET /v1/admin/overview
GET /v1/admin/bootstrap
GET /v1/admin/tenants
GET /v1/admin/usage
GET /v1/admin/policies
GET /v1/admin/credentials
GET /v1/admin/connections
GET /v1/admin/access-users
GET /v1/admin/policy-bindings
GET /v1/admin/provider-status
GET /v1/admin/provider-health
GET /v1/admin/upstream-grants
GET /v1/admin/assignment-rules
PUT /v1/admin/access-users/<email>
PUT /v1/admin/access-user-grants/<email>
PUT /v1/admin/policy-bindings
PUT /v1/admin/policies/<policy-id>
PUT /v1/admin/credentials/<credential-id>
PUT /v1/admin/connections/<provider-id>
PATCH /v1/admin/connections/<provider-id>
PUT /v1/admin/upstream-grants/<policies|tenants>/<scope-id>/<token-ref>
PUT /v1/admin/assignment-rules/<rule-id>
POST /v1/admin/policies/<policy-id>/revoke
POST /v1/admin/credentials/<credential-id>/revoke
POST /v1/admin/upstream-grants/<policies|tenants>/<scope-id>/<token-ref>/revoke
POST /v1/admin/upstream-grants/<policies|tenants>/<scope-id>/<token-ref>/refresh
POST /v1/admin/upstream-grants/<policies|tenants>/<scope-id>/<token-ref>/authorize
POST /v1/admin/assignment-rules/reconcile
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
identity, `ACCESS_CONTROL` stores tenant/status/groups, policy bindings
grant service access, and ClawRouter admin rights come from the Access admin
email/domain allowlist configured on the Worker. `ACCESS_CONTROL` makes
policies, credentials, user status, binding mutations, and session grant
resolution strongly consistent. Provider kill switches use the same serialized
authority; provider requests only resolve the selected connection.

For independent connection edits, use `PATCH` with only the changed fields:
`{"enabled": false}` disables a provider without changing its label or budget;
`{"monthlyBudgetMicros": 50000000}` changes its cap without enabling it.
Omitted fields stay unchanged. Set `label` or `monthlyBudgetMicros` to `null` to
clear them; an empty label also clears it, while a zero budget blocks spending.
The response contains the committed connection. Concurrent edits to different
fields are merged in the authority; edits to the same field use the last
accepted value. Unknown fields and read-only spend observations are ignored.
Existing `PUT` clients retain their defaults: omitted `enabled` becomes `true`,
omitted `label` becomes `null`, and omitted `monthlyBudgetMicros` stays unchanged.

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

Disabling an Access user also denies proxy keys whose `principalId` identifies
that user, including subsequent turns on an existing Responses WebSocket.
Re-enabling the user restores those keys if their credential and policy remain
enabled. Unowned service keys and keys without a materialized owner record are
unaffected. Removing a policy binding alone does not revoke already-issued keys;
disable the owner, credential, or policy when offboarding requires that result.

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
  "requestCostMicros": 1000,
  "budgetScope": "policy"
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
Durable Object before upstream calls. `requestCostMicros`, when present, is a
fixed per-request override. When it is omitted, models with versioned manifest
pricing reserve a conservative token cost and settle against provider-reported
usage. Any budgeted route without manifest pricing fails closed with
`pricing_required`; unbudgeted routes retain the one-micro fallback.

`budgetScope` may be `policy` or `principal` and defaults to `policy`, which
keeps one shared monthly pool for service-token policies. Use `principal` for
maintainer policies: proxy credentials use their `principalId` (or credential
id when unowned), while Access sessions use the signed-in email, so each
maintainer receives an independent monthly window.

When upgrading an existing policy, either add versioned pricing for every
route it can reach or set `requestCostMicros` before deploying this behavior.
Then remove the fixed override only after the priced model catalog covers all
client-selected model IDs.

## Upstream Grants

The `cf:oauth:*` helpers use the authenticated admin API to update the grant's
credential owner and pool index. Set `CLAWROUTER_BASE_URL` and
`CLAWROUTER_ADMIN_TOKEN`; also set `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` together when Access protects the admin route.
Despite their legacy names, these helpers support `api_key`, `oauth`, and
`subscription` grants. Register an OAuth grant for one access policy:

```sh
printf '%s' "$PROVIDER_ACCESS_TOKEN" | pnpm cf:oauth:put -- \
  --kid svc_docs \
  --token-ref openai \
  --kind oauth \
  --provider openai \
  --label "maintainer OAuth" \
  --access-token-stdin
```

Register a tenant-wide API-key grant:

```sh
pnpm cf:oauth:put -- \
  --tenant default \
  --token-ref anthropic \
  --kind api_key \
  --provider anthropic \
  --label "primary API key" \
  --credential-env ANTHROPIC_API_KEY
```

The grant key is `oauth/<policy-id>/<tokenRef>` or
`oauth/tenants/<tenant>/<tokenRef>`. Secrets live in `GRANT_CREDENTIALS`;
`POLICY_KV` contains routing metadata and credential-presence flags.
`api_key` grants require `credential` or a
non-empty `credentials` string map, `oauth` grants require `accessToken`, and
`subscription` grants accept either a credential or access token.
Use the provider id as `tokenRef` for the provider's default connection.
Provider manifests may declare a different explicit token reference when a
provider needs multiple named connection contracts.

To create a same-provider pool, save multiple admin grants with distinct token
references, the same `provider`, an integer `priority` from 0 through 1000000,
and an optional positive `weight` up to 1000000. Lower priorities form the first
active tier; routing never spills into a higher tier while a lower tier has an
eligible grant. CLI imports, admin writes, and browser OAuth maintain the
bounded pool index automatically.

Each scope/provider permits 32 active grants or pending active reservations.
A replacement reserves capacity before storing active credentials; a paused
replacement records a pending proposal without consuming an active slot. Neither
proposal can receive requests, and the previous provider remains attached until
the store commits.
Paused and reauthorization-required accounts remain attached while freeing an
active slot. Revocation removes the attachment after deleting its secrets.
After the account-inventory activation below, these attachment facts prevent
environment-credential fallback from paused or reauthorization-required pools.
Before activation, would-be environment fallback returns `503 grant_pool_not_ready`.

The attachment storage upgrade is forward-only. Recovery must use the current
Worker or a forward fix so the owner can reconcile unfinished publication.
Do not roll back to a Worker that predates attachment statuses: its pool query
ignores those statuses and does not safely handle retained inactive accounts.
Do not delete the index fences or restore an older index over current owners.

### Account routing activation and recovery

After upgrading, sign in as an administrator and open **Access → Upstream →
Account routing readiness**. This panel reads its own status endpoint, so a
failed account-listing refresh does not prevent recovery. Existing scoped
accounts keep their checks; admin login and recovery stay available. Health
means the process is running, not that environment fallback is activated.

1. Stop old Worker deployments and CLI tools that write grants directly to KV.
   Check the complete account inventory, including paused named accounts that
   were omitted from the old active index. Wait for old writes to become visible
   before scanning; [KV listings can lag](https://developers.cloudflare.com/kv/api/list-keys/).
2. Accept **Existing or unknown storage** and its inventory confirmation. Choose
   **Newly provisioned storage** only when the matched storage set was actually
   created for this deployment. Empty KV, a new readiness row, matching namespace
   titles, and an existing namespace ID do not establish freshness.
3. Start the scan and reconcile each bounded page. Existing credential owners
   backfill their own attachments; scans never adopt raw KV secrets or metadata.
   A failed first admission may report `pending_cancelled`; ambiguous legacy
   membership and unavailable owners remain unresolved.
4. Resolve reported keys. To retain a raw-only account, use the existing
   authenticated replacement command with a fresh primary secret, for example
   `pnpm cf:oauth:put -- --kid POLICY --token-ref REF --provider PROVIDER --kind oauth --access-token-stdin`.
   Use `--tenant` instead of `--kid` for tenant scope; API keys use
   `--credential-stdin` or `--credentials-json-stdin`. To remove an account, use
   `pnpm cf:oauth:revoke -- --kid POLICY --token-ref REF --provider PROVIDER`.
   These commands require `CLAWROUTER_BASE_URL`, `CLAWROUTER_ADMIN_TOKEN`, and the
   Access service-token pair when the admin route is protected. They never need
   direct KV edits. Owner/index failures remain unresolved until repaired.
   An `identity_unresolved` key with neither its credential owner nor KV metadata
   is a partial-storage recovery case. Restore the matched storage set or complete
   a reviewed storage migration; replacement and revocation cannot establish the
   missing identity. The retained index evidence stays intact until that recovery.
5. Start a new verification scan after repairs or concurrent account changes.
   Activate only when the complete scan is unchanged and has no unresolved
   outcomes. A page limit or more than 64 unresolved keys blocks activation;
   resolve the displayed set, then rescan. A stale revision returns 409 and the
   panel rereads the canonical status.

The CLI uses the same actions: `pnpm cf:accounts -- --status`, one-time explicit
`--accept-existing` (or `--accept-fresh` after actual provisioning), then
`pnpm cf:accounts`. The driver saves bounded progress and performs at most one
additional verification scan after backfill changes. It does not accept a
baseline automatically or retry an unresolved owner. Routine later deployments
reuse accepted activation and inspect every indexed key, including active
accounts and detached tombstones whose KV projection may be missing. Repair
keeps the owner's publication obligation until both the index and canonical KV
projection are acknowledged. Matching projections are not rewritten. A failure
remains visible; the driver does not retry writes or switch to environment
credentials to hide it.

Activated repair uses pages of 32 keys. If the CLI reaches its page limit, use
the exact `--repair-cursor KEY` command it prints to continue after that page;
restarting without the cursor starts at the first indexed key. This cursor is
only for activated repair and cannot skip the initial migration scan. The
console's **Repair next indexed page** action uses the same cursor.

Manual `cf:deploy` and both hosted deploy workflows run this driver before
golden provider smoke. Production now needs the raw `CLAWROUTER_ADMIN_TOKEN`
secret in addition to its SHA256; recovery and smoke receive it only in their
steps, with `CLAWROUTER_ACCESS_CLIENT_ID` and `CLAWROUTER_ACCESS_CLIENT_SECRET`
when needed. FakeCo installs and proves its existing admin access before
recovery. Its workflow reuses a configured namespace, so first deployment needs
explicit baseline acceptance. A failed activation fails deploy qualification,
but leaves the running admin recovery surface accessible. `cf:doctor` reports
activation independently of provider configuration and always queries the
resolved deployment URL, even when `CLAWROUTER_BASE_URL` is omitted. Missing or
invalid local admin credentials and missing required or incomplete Access
credential pairs fail preflight before any remote permission probe.

Treat POLICY_KV, ACCESS_CONTROL and GRANT_CREDENTIALS as one matched storage set.
Partial binding swaps or partial restores are not routine deployments and
require a reviewed storage migration; the runtime cannot infer namespace lineage
from a KV read. Keep forward recovery available. Never downgrade to a build that
ignores attachment statuses or deletes retained generation fences.

`cf:oauth:put` replaces the entire grant at that key, including its credentials
and account metadata. Omitted refresh tokens, credential bundles, and refresh
configuration are cleared. Supply a fresh primary credential for each import.
For a metadata edit that preserves credentials, use the console or the admin
API's default PUT mode instead of the CLI replacement mode.

The console enables account writes after the first account list loads; you can
prepare a draft while it loads. That first list supplies untouched policy and
provider defaults; later refreshes do not retarget the draft. Empty or unavailable
selections remain visible. The console applies confirmed saves, revocations,
credential refreshes, and quota results before refreshing the rest of the dashboard. You can edit or
save again while that refresh runs; later drafts and selections stay intact.
Provider sign-in keeps account writes blocked while its redirect is pending.
A reporting failure does not undo a confirmed change. If a write cannot be
confirmed, refresh and inspect the account before retrying; the console does
not retry the write automatically.

`--local` now calls a running local Worker through the same authenticated API.
It defaults to `http://127.0.0.1:8787` when `CLAWROUTER_BASE_URL` is unset, and
rejects a configured non-loopback URL. Configure that Worker's admin token;
the flag does not write offline Wrangler KV. `--binding` and `--config` are
rejected before reading secrets. Replace those storage selectors with the
target's `CLAWROUTER_BASE_URL` and `CLAWROUTER_ADMIN_TOKEN`. Do not use old CLI
versions or raw KV writes to change a grant after it has a credential owner.

Each access policy has a `grantRouting` object. Existing policies default to
quota-aware `most_remaining` selection, failover enabled, stale state allowed
for five minutes, and no explicit grant restriction:

```json
{
  "strategy": "most_remaining",
  "stickiness": "none",
  "failover": true,
  "staleState": "allow",
  "staleAfterSeconds": 300,
  "switchAtUsedPercent": 90,
  "hysteresisPercent": 10,
  "eligibleGrants": {
    "openai": ["openai-primary", "openai-backup"]
  }
}
```

`strategy` may be `priority`, `round_robin`, `least_used`, `most_remaining`,
`threshold`, or `weighted_random`. `threshold` keeps the pool's current grant
until its most constrained fresh quota window reaches `switchAtUsedPercent`,
then selects the healthiest candidate below that cutoff only when it improves
remaining capacity by at least `hysteresisPercent`. It requires
`stickiness: "none"`; the pool cursor supplies affinity. `stickiness` may otherwise be
`none`, `identity`, or `session`;
identity and session values are hashed before selection and are not persisted as
raw identifiers. `eligibleGrants` is a per-provider token-reference allowlist;
an explicit empty list denies every grant for that provider and never falls back
to a provider-wide environment credential.
Set `staleState` to `deny` to fail closed when all eligible grants lack fresh
quota evidence. Set `failover` to `false` when a policy must never retry a
request with another credential. The console exposes these controls and each
grant's selection count and last-selected time.

Provider manifests declare the response headers used to collect request, token,
input-token, output-token, subscription-window, or credit quota. ClawRouter
stores only bounded numeric windows, reset times, and sanitized status metadata
in the access authority; response bodies and credential values are never
included. Active cooldowns are skipped, and expired windows stop influencing
selection automatically. A manifest can also declare a bounded quota probe for
providers that expose per-grant usage outside normal responses. An administrator
can run an immediate probe with **Refresh quota**. Subscription transports may
also declare adaptive per-grant polling: the credential Durable Object schedules
those probes independently of proxy traffic, polls more often near exhaustion,
and backs off after failures. Probes have a ten-second timeout and never run in
the request hot path.

For an upstream 401, 403, or 429, ClawRouter records a five-minute
authentication cooldown or the provider's bounded rate-limit reset and can try
one other grant when policy failover is enabled. The retry is limited to LLM
capabilities and GET/HEAD service routes, never applies to 5xx or network
failures, and consumes the original budget reservation and usage record.
`x-clawrouter-grant-failover: 1` marks a response served by the alternate without
disclosing either grant key.

Secrets are never accepted in argv. Supply `accessToken`, `credential`,
`credentials-json`, and an optional `refreshToken` only through the matching
`--*-stdin`, `--*-env`, or `--*-file` option. Only one secret can use stdin in
a single invocation. Other optional metadata flags are:

- `--token-type`, `--expires-at`, `--scopes`, and `--account-id`
- `--subscription-plan` and `--subscription-subject`
- `--refresh-token-url`, `--refresh-client-id` or `--refresh-client-id-config`,
  `--refresh-client-secret-config`, and `--refresh-extra-params-json`

When a provider manifest declares standard refresh configuration, ClawRouter
uses that manifest-approved configuration automatically. Explicit refresh flags
are only for matching custom provider manifests. Refresh extra parameters must
be non-secret string metadata. Store client secrets in Worker configuration and
pass only the configuration binding name with
`--refresh-client-secret-config`.

For SigV4 providers, store the canonical signing fields as a write-only
credential bundle. Region remains a non-secret runtime binding:

```sh
export AWS_BEDROCK_CREDENTIALS='{"accessKeyId":"...","secretAccessKey":"...","sessionToken":"..."}'
pnpm cf:oauth:put -- \
  --kid svc_models \
  --token-ref aws-bedrock \
  --kind api_key \
  --provider aws-bedrock \
  --label "maintainer Bedrock" \
  --credentials-json-env AWS_BEDROCK_CREDENTIALS
```

Bedrock grants require `accessKeyId`, `secretAccessKey`, and optional
`sessionToken`. They share the deployment's rendered `AWS_REGION`; grant-local
Region values are not supported. See [Amazon Bedrock](aws-bedrock.md).

For OpenAI, provision a Platform API key without exposing it in argv:

```sh
pnpm cf:oauth:put -- \
  --kid svc_docs \
  --token-ref openai \
  --kind api_key \
  --provider openai \
  --label "maintainer OpenAI API" \
  --credential-env OPENAI_API_KEY
```

OpenAI API-key grants use the OpenAI Platform transport and API billing.
Subscription browser Connect is unavailable in the bundled provider on all
deployments, including hosted and custom-domain Cloudflare Workers. Existing
stored subscription grants retain their transport and refresh contract, but
manual token import does not establish provider approval or compatibility.
See [OpenAI setup and subscription limits](openai-subscriptions.md) for direct
Codex login and the private facade's separate requirements.

The bundled Anthropic manifest supports Claude subscription OAuth credentials,
including one-year inference-only tokens generated by `claude setup-token` and
refreshable access/refresh pairs. It uses Bearer authentication, merges
the Claude Code OAuth beta identifiers with caller-required beta features,
prepends Anthropic's required Claude Code billing system blocks, and refreshes
refreshable grants with Anthropic's JSON token contract. Refreshable grants poll
the OAuth usage endpoint for the five-hour, seven-day, Sonnet, and Opus windows.
Inference-only setup tokens collect five-hour and seven-day utilization from
successful inference and keep-warm response headers instead. Anthropic API-key grants remain
on `x-api-key` and do not receive subscription-only request transforms.

Anthropic's OAuth client uses a loopback callback, so the Worker does not
advertise browser OAuth for Claude. Import tokens through the protected
contributor flow or the write-only upstream-grant form. A typical
1Password-backed submission is:

```sh
pnpm pool:contribute -- \
  --ticket-file ./maintainer-claude.ticket.json \
  --access-token-ref 'op://Private/ClawRouter Claude/access_token' \
  --refresh-token-ref 'op://Private/ClawRouter Claude/refresh_token' \
  --expires-at 2026-09-03T02:00:00Z
```

For an access-only setup token, omit the refresh token:

```sh
claude setup-token
# Store the printed value in 1Password, then submit its reference:
pnpm pool:contribute -- \
  --ticket-file ./maintainer-claude.ticket.json \
  --access-token-ref 'op://Private/ClawRouter Claude/setup_token' \
  --expires-at 2027-09-03T02:00:00Z
```

The setup-token command does not save its output. Never place the token in shell
history, process arguments, chat, or source control. Anthropic documents setup
tokens for inference-only CI and scripts. Shared subscription routing requires
separate authorization from Anthropic; do not treat an individual setup token as
a transferable team credential.

Quota collection is automatic for these grants. Claude keep-warm inference is
separate and enabled by default for new subscription grants. Disable it for an
exact grant in the console or add `--no-keep-warm` when issuing that grant's
ticket.
The manifest-owned job runs every 4 hours 55 minutes, skips grants in cooldown
or at 10% remaining capacity, sends one fixed one-token Claude request with no
user content, and discards the response. Neither contributors nor submitted
payloads can alter its endpoint, model, headers, prompt, or interval.

### Operator account inventory

Run the inventory command from a reviewed, pinned checkout to make one
authenticated `GET /v1/admin/upstream-grants` against
`https://clawrouter.openclaw.ai`. It works without an account-readiness endpoint.
Before running, obtain a working administrator credential reference from its
owner. Use the operator secret manager to inject `CLAWROUTER_ADMIN_TOKEN` into
the command's environment. When Cloudflare Access requires service credentials,
inject both `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` through the same
operator route. Keep raw credentials out of GitHub Actions, command arguments,
and logs. The command does not provision credentials; without that prerequisite,
authenticated inventory remains unverified.

```sh
git rev-parse HEAD
CLAWROUTER_BASE_URL=https://clawrouter.openclaw.ai node scripts/grant-pool-operations.mjs
```

Record the pinned commit and invoking operator alongside the receipt. The
receipt labels execution as `operator`; it does not attest source or caller
identity. Exclude overlapping deployments and account mutations before running.
The command does not install packages, deploy a Worker, or run provider smoke.

Receipts contain only the fixed target, API-visible counts and digests, or fixed
diagnostics. Raw account identities, labels, URLs, credential data and server
errors stay out of logs. Redirects, failed authentication, malformed or oversized
responses fail without retrying the request.

The `clawrouter.api-visible-grants.v1` digest hashes JSON containing that `schema`
and `grants` sorted by key. Each projected grant contains only `key`, `provider`,
`kind`, `enabled`, `updatedAt`, `revokedAt`, `credentialStatus` in that order;
missing optional values become `null`, and legacy strings retain their exact
bytes without timestamp or enum normalization. The separate `keyNamesSha256` hashes
`{schema: "clawrouter.api-visible-grant-keys.v1", keys}` with the same sorted key
names. Labels and mutable quota observations do not affect these digests.
Compare an earlier private key-name inventory only after recomputing it with
this exact versioned algorithm; a digest from another format is not comparable.

This receipt covers the API-visible projection only. Null KV values and
index-only owners are outside it; an empty projection never proves empty storage,
stopped writers, or matched storage lineage. Review the full inventory privately.
The command changes no account state and provides no baseline acceptance or
routing activation action.

### Contributor intake

An administrator can authorize one credential contribution without sharing an
admin token or accepting a normal ClawRouter key. Create a short-lived ticket
for one exact pool slot and save its one-time secret to a new protected file:

```sh
export CLAWROUTER_ADMIN_TOKEN=...
# Also required when Cloudflare Access protects the admin route for automation:
export CF_ACCESS_CLIENT_ID=...
export CF_ACCESS_CLIENT_SECRET=...
pnpm pool:ticket -- \
  --url https://clawrouter.openclaw.ai \
  --out ./maintainer-openai.ticket.json \
  --scope policies \
  --scope-id svc_models \
  --token-ref openai-maintainer-a \
  --provider openai \
  --kind subscription \
  --contributor maintainer@example.com \
  --admin-token-env CLAWROUTER_ADMIN_TOKEN
```

The command creates the ticket file with mode `0600` and refuses to overwrite
an existing path. Transfer it to the named contributor over an approved secret
channel. The ticket defaults to 15 minutes and is bound to the scope, provider,
grant kind, priority, and weight chosen by the administrator.
The Access service token must be allowed by the application's Service Auth
policy; it supplements the admin bearer token. Configure both Access variables
or neither for an unprotected self-hosted endpoint. Ticket creation shares the
key commands' admin transport: it refuses redirects with an Access setup hint
and does not print raw response bodies in errors. Admin responses consumed as
JSON, including tickets and all error responses, are limited to 128 KiB;
rejected responses do not create a ticket file. Key and grant mutation commands
acknowledge successful JSON response headers and discard the unused body, so
large accepted grant metadata does not turn a committed mutation into a CLI
failure. A bodyless 204 also acknowledges success; redirects and non-JSON
responses remain errors. No automatic mutation retry is performed.
The provider manifest supplies the default. Claude tickets enable keep-warm when
neither flag is present. Use `--no-keep-warm` to disable it for one grant;
`--keep-warm` remains available as an explicit override for providers whose
manifest default is off.

The contributor keeps provider credentials in their own 1Password vault and
passes only secret references on the command line:

```sh
pnpm pool:contribute -- \
  --ticket-file ./maintainer-openai.ticket.json \
  --access-token-ref 'op://Private/ClawRouter OpenAI/access_token' \
  --refresh-token-ref 'op://Private/ClawRouter OpenAI/refresh_token' \
  --account-id ACCOUNT_ID \
  --expires-at 2026-09-02T22:00:00Z
```

`pool:contribute` invokes `op read` directly and holds its output only in
memory. For controlled testing it also accepts matching `--*-env` or
`--*-file` sources. Literal `--access-token`, `--refresh-token`, `--credential`,
and `--credentials-json` arguments are rejected because process arguments are
observable. Ticket files must remain mode `0600` on Unix-like systems.

The ticket secret is stored only as a SHA-256 digest. Claiming it is atomic and
bound to a canonical hash of the submitted payload. An interrupted identical
retry is safe; a different replay, expired ticket, normal proxy credential, or
attempt to inject a refresh URL is rejected. Provider refresh configuration
always comes from the trusted manifest. After acceptance, delete the local
ticket file through the contributor's normal secure-file workflow.

For unattended 1Password intake, do not place contributors in one shared
writable vault: 1Password item write permission also requires item read
permission. Use a separate intake vault and service-account scope for each
contributor, or keep the user-initiated push above. ClawRouter remains the
canonical owner after import; do not copy rotated refresh tokens back into
1Password.

### Browser OAuth

When a provider manifest declares `auth.authorization`, a verified Cloudflare
Access admin can start its browser flow from the upstream-grants console or:

```text
POST /v1/admin/upstream-grants/<policies|tenants>/<scope-id>/<token-ref>/authorize
{"provider":"example"}
```

ClawRouter creates a one-time, ten-minute PKCE state bound to the Access admin,
grant key, provider, and callback URI. The provider returns to
`https://<clawrouter-host>/v1/oauth/callback`; ClawRouter consumes the state
before exchanging the code and persists the canonical grant without exposing
tokens to the browser. Admin bearer tokens cannot start or finish this browser
flow.

The example requires a custom provider manifest with a provider-approved OAuth
client that allows that exact callback URI. Treat a provider as browser-OAuth-ready
only after approval and its redirect allowlist have been verified in the deployed
environment. The bundled OpenAI provider does not declare browser OAuth;
its authorize endpoint returns `oauth_not_supported`. See
[OpenAI setup and subscription limits](openai-subscriptions.md).

Revoke a grant without deleting audit history:

```sh
pnpm cf:oauth:revoke -- --kid svc_docs --token-ref openai
```

Revocation writes a disabled tombstone in the credential owner, cancels its
maintenance alarm, and updates its pool and KV metadata. It retains the grant's
non-secret metadata and creation timestamp, adds `revokedAt`, and removes
stored access tokens, refresh tokens, single credentials, credential bundles,
and other recognized secret fields. When revoking a raw legacy token, pass
`--kind`, `--provider`, and `--label` to attach identifying metadata to its
tombstone. These hints apply only when the grant has no credential owner;
they cannot change an existing owner's identity. Unknown grants return an error.
Upgrades import existing KV revocation or disablement into pre-existing owners
before provider requests or maintenance. Reconnecting requires a fresh credential.

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
