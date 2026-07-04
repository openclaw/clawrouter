# Use ClawRouter with OpenClaw

OpenClaw can use one ClawRouter credential to discover and run every model
allowed by its policy. Upstream provider keys stay in ClawRouter. The OpenClaw
host does not need separate OpenAI, Anthropic, Google, or other provider
credentials, and it does not need those companies' OpenClaw plugins.

The bundled `@openclaw/clawrouter` plugin owns catalog discovery, request
transport, model-id rewriting, tool compatibility, and quota reporting.

## Prerequisites

- a deployed ClawRouter origin, normally `https://clawrouter.openclaw.ai`;
- enabled, ready upstream provider connections;
- a policy granting the intended model services and budget; and
- an active proxy credential bound to that policy.

In the ClawRouter console, create the policy under **Access > Policies**, then
issue its credential under **Access > Credentials**. The secret is revealed
once. Store it in an approved secret manager before leaving the page.

## Configure OpenClaw

The plugin is bundled with OpenClaw. Enable it explicitly:

```sh
export CLAWROUTER_API_KEY="<issued credential>"
openclaw onboard --auth-choice clawrouter-api-key
openclaw plugins enable clawrouter
```

If your OpenClaw configuration sets `plugins.allow`, add `clawrouter` before
enabling the plugin. OpenClaw can store the proxy credential in its auth
profile; it does not need to remain in the shell environment after setup.

For a self-hosted ClawRouter origin, configure the provider base URL:

```json5
{
  models: {
    providers: {
      clawrouter: {
        baseUrl: "https://router.example.com",
      },
    },
  },
}
```

The base URL may include `/v1`; the plugin normalizes it to the correct catalog,
usage, and inference endpoints.

## Discover and select models

```sh
openclaw models list --all --provider clawrouter
openclaw models set clawrouter/<provider>/<model>
```

Use model refs exactly as returned. The first segment is always `clawrouter`;
the remaining path preserves the upstream provider and model namespace.
If your OpenClaw configuration uses `agents.defaults.models` as an allowlist,
add each selected ClawRouter ref to that map.

ClawRouter's credential-scoped `GET /v1/catalog` response is authoritative.
OpenClaw advertises a model only when the policy grants its provider, the
provider is ready, the model has an LLM capability, and its route maps to a
supported transport:

| Catalog contract | OpenClaw transport |
| --- | --- |
| OpenAI-compatible chat | `openai-completions` |
| OpenAI-compatible Responses | `openai-responses` |
| Native Anthropic Messages | `anthropic-messages` |
| Native Google streaming content | `google-generative-ai` |

Adding a model to a provider that already exposes one of these contracts needs
no OpenClaw release. It appears on the next catalog refresh. A provider using a
different request or stream envelope needs a new ClawRouter plugin transport;
until then, OpenClaw fails closed and omits it.

## Verify inference

Choose refs from the live catalog rather than copying model names from this
page. Exercise more than one transport family when the policy allows it:

```sh
openclaw agent \
  --model clawrouter/<provider>/<model> \
  --message "Reply exactly: CLAWROUTER_OK"
```

For a multi-provider smoke, run one OpenAI-compatible model, one native
Anthropic model, and one native Google model. A successful catalog lookup alone
does not prove upstream inference.

## Verify budget and usage

```sh
openclaw status --usage
openclaw models status
```

The plugin reads `GET /v1/usage` with the same credential. Budgeted policies
show a monthly percentage window plus request, token, and spend totals.
Unmetered policies show totals without a percentage. OpenClaw also exposes this
snapshot through `/status` in chat and its usage UI.

## Security boundaries

- The proxy credential reaches only ClawRouter, never an upstream provider.
- Upstream credentials remain server-side in Worker secrets or scoped grants.
- Catalog and usage responses are policy-scoped.
- OpenClaw attaches the proxy credential only when dispatching catalog, usage,
  or inference requests; it is not model metadata.
- Revoking the credential blocks that client. Disabling the policy blocks every
  credential and principal bound to it.

See the [OpenClaw ClawRouter provider page](https://docs.openclaw.ai/providers/clawrouter)
for the client-facing reference and [Cloudflare deployment](deploy-cloudflare.md)
for operator provisioning.
