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
probe or Worker deploy. Preview Access without Cloudflare writes:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLAWROUTER_ACCESS_GITHUB_ORGS=openclaw
pnpm cf:access -- --dry-run
```

The dedicated **Deploy Cloudflare FakeCo** workflow is bound to the GitHub
Environment named `fakeco`. It uses only `CLAWROUTER_FAKECO_*` secrets and
variables, renders the fixed profile, retains the FakeCo custom-domain route,
converges the separate Access app/audience on every run, requires a live
provider smoke, and refuses a missing mutation confirmation.
Configure these environment secrets before dispatching it:

```text
CLAWROUTER_FAKECO_CLOUDFLARE_API_TOKEN
CLAWROUTER_FAKECO_CLOUDFLARE_ACCOUNT_ID
CLAWROUTER_FAKECO_ADMIN_TOKEN_SHA256
CLAWROUTER_FAKECO_POLICY_KV_ID
CLAWROUTER_FAKECO_POLICY_KV_PREVIEW_ID   # optional; defaults to the primary id
CLAWROUTER_FAKECO_SMOKE_KEY
```

The Cloudflare token needs Workers, KV, Queues, R2, custom-domain route, and
Zero Trust Access application/policy permissions for the FakeCo account.
Both the dedicated workflow preflight and `pnpm cf:deploy` resolve the configured
KV id and refuse to deploy unless its title is the locked FakeCo namespace.

Access provisioning writes or consumes environment-scoped variables named
`CLAWROUTER_FAKECO_ACCESS_TEAM_DOMAIN`, `CLAWROUTER_FAKECO_ACCESS_AUD`,
`CLAWROUTER_FAKECO_ACCESS_DEFAULT_TENANT`, and the corresponding admin lists.
For Crabhelm admin automation, set
`CLAWROUTER_FAKECO_ACCESS_SERVICE_TOKEN_IDS` to the comma-separated Cloudflare
Access service-token resource IDs. The workflow passes those IDs to Access
provisioning, which creates the locked
`ClawRouter FakeCo Console Service Tokens` `non_identity` policy covering
`/v1/admin/*`. Crabhelm keeps the matching client
ID and secret in `CLAWROUTER_ACCESS_CLIENT_ID` and
`CLAWROUTER_ACCESS_CLIENT_SECRET`, then sends the
`cf-access-client-id` and `cf-access-client-secret` headers. Do not put the
client secret in the GitHub variable.
Provider credentials use `CLAWROUTER_FAKECO_PROVIDER_<WORKER_BINDING>` names.
No production secret name is referenced by the FakeCo workflow.

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
x-clawrouter-session-id
x-clawrouter-agent-id
x-clawrouter-parent-agent-id
x-clawrouter-project-id
x-clawrouter-client
```

ClawRouter records those values with provider, model, capability, timing,
status, token counts, and cost. It does not copy request or response bodies into
usage events. FakeCo also defaults new policies and migrated records without an
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

Deployment is complete only after the workflow's exact Worker deploy, Access
gate check, credential inspection, catalog check, and live provider smoke pass.
