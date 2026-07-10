# FakeCo staging environment

FakeCo is a locked, non-production Cloudflare deployment consumed by OpenClaw
gateways and Crabhelm running in the dedicated AWS FakeCo account. Phase 1
keeps the supported Cloudflare Worker runtime; the AWS workloads are clients,
not an alternate ClawRouter runtime.

The committed profile is `config/deployments/fakeco.json`:

| Resource | FakeCo target |
| --- | --- |
| Worker | `clawrouter-edge-fakeco` |
| Public origin and custom-domain route | `https://clawrouter-fakeco.openclaw.ai` |
| KV namespace title | `clawrouter-policy-fakeco` |
| Usage queue | `clawrouter-usage-fakeco` |
| Usage DLQ | `clawrouter-usage-fakeco-dead-letter` |
| Content archive | `clawrouter-content-fakeco` |
| Access app | `ClawRouter FakeCo Console` |
| Default tenant | `fakeco` |

The distinct Worker name gives FakeCo its own `BUDGET_LEDGER`, `USAGE_LEDGER`,
and `ACCESS_CONTROL` Durable Object namespaces. The profile refuses environment
overrides that point any named resource, route, Access app, or base URL at the
production target.

## Provisioning and deployment

Inspect the target before any mutation:

```sh
export CLAWROUTER_DEPLOY_ENV=fakeco
pnpm cf:target
```

After verifying the printed Worker, origin, queue, DLQ, R2 bucket, and retention
default, enable the explicit mutation guard for the current shell:

```sh
export CLAWROUTER_DEPLOY_CONFIRM=fakeco
pnpm cf:provision
pnpm cf:content:provision
```

`pnpm cf:provision` creates the profile's queues and KV namespace. Use the
returned KV id only as `CLAWROUTER_FAKECO_POLICY_KV_ID`; do not reuse the
production namespace id. Preflight resolves that id through the Cloudflare API
and requires the namespace title `clawrouter-policy-fakeco` before any KV write
probe or Worker deploy. FakeCo reuses this verified primary id as Wrangler's
preview id. Do not configure a preview-id secret for the standard workflow. A
manually configured, distinct `CLAWROUTER_POLICY_KV_PREVIEW_ID` is accepted only
after an independent Cloudflare API lookup returns the exact same locked FakeCo
namespace title.

Preview Access without Cloudflare writes:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLAWROUTER_ACCESS_GITHUB_ORGS=openclaw
pnpm cf:access -- --dry-run
```

The dedicated **Deploy Cloudflare FakeCo** workflow is bound to the GitHub
Environment named `fakeco`. It uses only `CLAWROUTER_FAKECO_*` secrets and
variables, renders the fixed profile, retains the FakeCo custom-domain route,
converges the separate Access app/audience on every run, requires a live
provider smoke, and refuses a missing mutation confirmation. Before the first
Access write, a read-only preflight validates every bootstrap input, the
admin-token hash pair, smoke-key syntax and provider scope, a nonempty list of
service-token resource UUIDs, and the exact primary/optional-preview KV title.
Configure these environment secrets before dispatching it:

```text
CLAWROUTER_FAKECO_CLOUDFLARE_API_TOKEN
CLAWROUTER_FAKECO_CLOUDFLARE_ACCOUNT_ID
CLAWROUTER_FAKECO_ADMIN_TOKEN
CLAWROUTER_FAKECO_ADMIN_TOKEN_SHA256
CLAWROUTER_FAKECO_POLICY_KV_ID
CLAWROUTER_FAKECO_SMOKE_KEY
CLAWROUTER_FAKECO_ACCESS_CLIENT_ID
CLAWROUTER_FAKECO_ACCESS_CLIENT_SECRET
```

`CLAWROUTER_FAKECO_ADMIN_TOKEN` is the runner-only plaintext credential used
for the authenticated deployment probe. Its SHA-256 digest must equal
`CLAWROUTER_FAKECO_ADMIN_TOKEN_SHA256`. The workflow streams only the digest to
`wrangler secret put` over stdin; the plaintext is never installed on the
Worker. The smoke key must use
`clawrouter-live-<credential-id>-<secret>`. Bootstrap streams only its secret
suffix to the canonical remote key registration command. Neither secret is
placed in process arguments or printed.

The Cloudflare token needs Workers, KV, Queues, R2, custom-domain route, and
Zero Trust Access application/policy permissions for the FakeCo account.
Both the dedicated workflow preflight and `pnpm cf:deploy` resolve the configured
KV id and refuse to deploy unless its title is the locked FakeCo namespace.
The token also needs Workers Scripts Read so established deployments can list
binding names without reading or printing their values.

Access provisioning writes or consumes environment-scoped variables named
`CLAWROUTER_FAKECO_ACCESS_TEAM_DOMAIN`, `CLAWROUTER_FAKECO_ACCESS_AUD`,
`CLAWROUTER_FAKECO_ACCESS_DEFAULT_TENANT`, and the corresponding admin lists.
For Crabhelm admin automation, set
`CLAWROUTER_FAKECO_ACCESS_SERVICE_TOKEN_IDS` to the comma-separated Cloudflare
Access service-token resource UUIDs. This variable is mandatory for FakeCo;
missing, malformed, or duplicate IDs stop the read-only preflight before Access
can be changed. The workflow passes those IDs to Access
provisioning, which creates the locked
`ClawRouter FakeCo Console Service Tokens` `non_identity` policy covering
`/v1/admin/*`. The environment-scoped
`CLAWROUTER_FAKECO_ACCESS_CLIENT_ID` and
`CLAWROUTER_FAKECO_ACCESS_CLIENT_SECRET` must be the matching service-token
client credential. Crabhelm stores that client ID and secret in
`CLAWROUTER_ACCESS_CLIENT_ID` and
`CLAWROUTER_ACCESS_CLIENT_SECRET`, then sends the
`cf-access-client-id` and `cf-access-client-secret` headers. Do not put the
client secret in a GitHub variable.
Provider credentials use `CLAWROUTER_FAKECO_PROVIDER_<WORKER_BINDING>` names.
No production secret name is referenced by the FakeCo workflow.

The required `provider_credentials` dispatch choice removes first-deploy
ambiguity:

- `upload` is the safe default. Before any Access or Cloudflare write, preflight
  requires runner values for every required secret binding of every selected
  live provider. With the default `live_providers=openai`, this requires
  `CLAWROUTER_FAKECO_PROVIDER_OPENAI_API_KEY`. The values remain step-scoped and
  are later streamed to Wrangler as JSON over stdin.
- `existing` is only for an established locked Worker. Before any Access write,
  preflight performs an authenticated GET of that Worker's secret-binding names
  and requires all bindings selected by `live_providers`. A missing Worker or
  binding fails with instructions to use `upload`; secret values are never
  returned, logged, or placed in process arguments.

The workflow's fail-closed order is:

1. Run the non-mutating required-input and locked-KV preflight.
2. Converge the FakeCo Access app and its required service-token policy.
3. Run the normal Worker/KV permission preflight, provision content storage,
   render the locked config, and perform the initial Worker deploy.
4. Upload every selected provider secret in `upload` mode, or preserve the
   read-only-proven bindings in explicit `existing` mode; then install the admin
   digest from stdin.
5. Wait up to 180 seconds with bounded backoff for the custom-domain health
   endpoint to report `environment=fakeco` and, within the same retry loop,
   prove the same admin path first receives an unauthenticated Access challenge
   and then succeeds with the service-token headers and admin bearer token.
6. Idempotently register the policy-scoped smoke credential through the remote
   admin API, then run readiness, catalog, credential-inspection, and live
   inference smoke.

ClawRouter owns this deployment gate because it installs the Worker secret and
authoritative proxy credential. Crabhelm may run a later integration check, but
it does not replace the workflow's service-token/admin-path proof.

## Guarded teardown

Never use raw Wrangler delete commands for FakeCo. The repository-owned command
prints a plan and performs no Cloudflare request by default:

```sh
export CLAWROUTER_DEPLOY_ENV=fakeco
pnpm cf:teardown
```

After reviewing that plan, execution requires the FakeCo target lock, both exact
destructive confirmations, and the same account/KV inputs used for deployment:

```sh
export CLAWROUTER_DEPLOY_CONFIRM=fakeco
export CLAWROUTER_TEARDOWN_CONFIRM=delete-clawrouter-edge-fakeco-and-durable-object-storage
export CLAWROUTER_TEARDOWN_DATA_CONFIRM=durable-object-storage-loss-is-irreversible
pnpm cf:teardown -- --execute
```

Execution re-resolves the KV id to `clawrouter-policy-fakeco`, requires the
Access app name and complete destination set to match the locked FakeCo profile,
then deletes only that Worker and its associated resources (including Durable
Object storage), usage queue, DLQ, and finally the Access app. The confirmation
text names the Durable Object deletion explicitly. The Access gate stays in
place if a Worker or queue deletion fails. The command never uses Wrangler
deletion commands. Worker deletion uses the Cloudflare API explicitly with
`force=true` only after both teardown confirmations name the irreversible Durable
Object storage loss. Queue deletion uses exact API-listed ids, so ambiguous
resources cause refusal. Repeated execution tolerates only exactly absent managed
targets.

The KV namespace and its policies/credentials, R2 bucket and archived content,
Cloudflare Access service-token resources, GitHub Environment secrets/variables,
and Cloudflare zone are retained intentionally. Durable Object storage, the
Worker custom-domain binding, and Worker-bound secrets disappear with the
Worker; any unrelated DNS records or zone configuration are not touched.

## OpenAI-compatible client contract

Use these values in OpenClaw and Crabhelm:

```text
ClawRouter origin: https://clawrouter-fakeco.openclaw.ai
OpenAI base URL:   https://clawrouter-fakeco.openclaw.ai/v1
Authorization:     Bearer clawrouter-live-<credential-id>-<secret>
```

OpenClaw accepts either the origin or the `/v1` form as its provider `baseUrl`.
Generic OpenAI clients should use the `/v1` form. A credential is a revocable,
FakeCo policy-scoped ClawRouter credential, not an upstream provider key. Never
reuse a production credential in this environment.

The integration contract is:

| Check | Authentication | Meaning |
| --- | --- | --- |
| `GET /v1/health` | none | Process liveness, environment identity, and observability mode. It is not upstream readiness. |
| `GET /v1/catalog` | FakeCo credential | Authoritative allowed provider/model catalog. Require `provider.executable=true`; inspect `provider.readiness.status`, `verified`, and `reasons`. |
| `GET /v1/models` | FakeCo credential | OpenAI model-list view containing currently executable models. |
| `POST /v1/chat/completions`, `/v1/responses`, `/v1/embeddings` | FakeCo credential | OpenAI-compatible inference. Model ids retain the provider namespace, such as `openai/gpt-4.1-mini`. |
| `GET /v1/usage` | FakeCo credential | Policy budget status plus request, error, token, spend, provider, daily, and recent-event metadata. |

Expected FakeCo health fields include:

```json
{
  "ok": true,
  "environment": "fakeco",
  "observability": {
    "mode": "metadata_only",
    "requestContentRetentionDefault": false
  }
}
```

Send bounded attribution on inference requests when available:

```text
x-request-id
traceparent
x-clawrouter-session-id
x-clawrouter-agent-id
x-clawrouter-parent-agent-id
x-clawrouter-project-id
x-clawrouter-client
```

`x-request-id` is the per-model-call correlation ID; it remains separate from
Client, Agent, Session, and Project attribution. ClawRouter echoes its canonical
value on every owned response and records it with validated W3C trace/span IDs,
provider, model, capability, timing, status, token counts, and cost. Explicit
ClawRouter attribution headers retain precedence over documented client-native
fallbacks. It does not copy request or response bodies into usage events.
FakeCo also defaults new policies and migrated records without an
explicit setting to `retainRequestContent=false`; completions are never
retained. `x-clawrouter-content-retention: off` confirms the effective setting
on an inference response. Enabling the separate R2 request archive requires an
explicit policy opt-in.

## Local proof

No Cloudflare credentials are needed for the isolation checks:

```sh
pnpm test:scripts
CLAWROUTER_DEPLOY_ENV=fakeco \
  CLAWROUTER_POLICY_KV_ID=fakeco-placeholder \
  pnpm cf:config
pnpm worker:check
```

Deployment is complete only after the workflow's exact Worker deploy, bounded
health readiness, unauthenticated Access challenge, authenticated
service-token/admin-path probe, remote credential registration, catalog check,
and live provider smoke pass.
