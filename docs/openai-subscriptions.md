# OpenAI API keys and Codex subscriptions

**Use an OpenAI Platform API key to route OpenAI requests through ClawRouter.**
The bundled OpenAI provider does not offer browser subscription Connect on any
deployment, including custom-domain Cloudflare Workers, the hosted service, and
Docker self-hosting. A ChatGPT/Codex subscription is not an OpenAI Platform API
key or a promise of general-purpose gateway access.

## GPT-6.2 Astra and Sol

The bundled catalog declares **openai/gpt-6.2-astra** and
**openai/gpt-6.2-sol** for API-key Responses and text Chat Completions, and
for Responses on the existing stored-subscription transport. This does not add
subscription onboarding, grant entitlement, or permit copying local Codex tokens
into the hosted pool. Keep the original API-key/subscription credential source.

Use Responses for tool calling. Both models require a reasoning effort other
than **none**; start with **medium**. Their catalog advertises text/image input,
1,050,000 context, 922,000 maximum input and 128,000 maximum output tokens.
The [migration guide](https://developers.openai.com/api/docs/guides/latest-model)
explains unsupported sampling parameters and ordered encrypted-reasoning replay.

Budget accounting uses explicitly marked **published upper bounds**, not an
invoice-exact quote: generic cache-write usage cannot distinguish 30-minute from
12-hour retention, so the latter rate is the ceiling. Ultrafast uses the announced
6x ceiling rather than the temporary 3x promotion through February 28, 2027.
Fast/priority uses 2x; requests above 272,000 input tokens double input/cache
rates and use 1.5x output rates for the whole request. Missing write counters
retain the conservative reservation; unknown served tiers remain unpriced rather
than inventing exact settlement.
See the dated [Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra)
and [Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol) source cards.
Catalog declarations and isolated fake-upstream tests are not live inference or
proof that an operator's existing subscription grant is entitled to these models.

## Supported setup

Create a key in [OpenAI Platform](https://platform.openai.com/api-keys), with
API billing configured separately from your ChatGPT plan. Then either provision
`OPENAI_API_KEY` as a Worker secret using the [deployment guide](deploy-cloudflare.md),
or open **Access > Upstream > New grant**, choose **OpenAI**, set **kind** to
**API key**, enter the key, and save the grant for the intended policy or tenant.
Enable the OpenAI connection and grant the policy access to the intended models.
Clients use their policy-scoped ClawRouter credential, not the upstream key.
Verify discovery and inference using the [OpenClaw guide](openclaw.md).

To use your subscription directly in Codex, run `codex login` and sign in with
ChatGPT. For a headless Codex installation, follow OpenAI's
[device-code or localhost-forwarding instructions](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).
Those are Codex login flows, not ClawRouter token-import instructions.

## Why Connect is unavailable

ClawRouter's generic browser flow constructs the callback as
`https://<clawrouter-host>/v1/oauth/callback`. Its previous bundled OpenAI
configuration reused a fixed Codex OAuth client; that does not register the
deployment's callback with OpenAI. An unregistered redirect can be rejected with
`invalid_authorize_request`. The bundled provider now omits `auth.authorization`:
the console offers no Connect/Reconnect button and the authorize endpoint returns
HTTP 400 `oauth_not_supported` before storing OAuth state or contacting OpenAI.
An outstanding callback also cannot exchange its code after this change.

[OpenAI's authentication documentation](https://learn.chatgpt.com/docs/auth)
distinguishes ChatGPT subscription sign-in from usage-based Platform API access.
It also documents Codex custom-provider proxy configurations using OpenAI
authentication. That is not evidence that ClawRouter may onboard subscriptions
with the bundled client, accept arbitrary callbacks, or pool accounts for other
users. No verified provider-approved onboarding contract for that ClawRouter flow
is established here. This is a product support boundary, not a claim that every
Codex proxy violates OpenAI's terms. Operators must verify their intended use
against their applicable [OpenAI terms](https://openai.com/policies/terms-of-use/)
and any separate agreement with OpenAI.

Adding a loopback callback, code-paste UI, or device flow to ClawRouter requires a
provider-approved client and deployment contract first. Changing a redirect
string alone does not give a remote Worker the CLI's localhost callback server.
A custom manifest may declare browser OAuth only after the operator verifies
provider approval, the exact registered callback, and deployed token exchange and
inference. The hosted domain is not automatically eligible either.

## Existing grants and the private facade

The released stored-grant API, subscription transport, refresh configuration,
and quota handling remain available for existing operator-managed integrations.
Saving a manual grant only proves that ClawRouter accepted its fields; it does
not prove subscription entitlement or upstream compatibility. Copying a Codex
CLI token into that grant is not a supported workaround for failed onboarding.
An HTTP 403 alone cannot identify an originator or fingerprint mismatch. Do not
fabricate a Codex client identity or installation ID to evade an upstream denial.

Creation-only transports retain existing `background: true` forwarding and
request-bound accounting. They do not gain router polling, retrieval/cancellation
support or a recovery locator. This preserves the router contract without claiming
that a subscription backend accepts the request. See [Background Responses](api-reference.md#background-responses)
for the separately supported full-lifecycle API path.

The [private Responses facade](private-codex.md) is **not a turnkey subscription
workaround or the only supported OpenAI path**. It requires a separately isolated,
owner-only runtime, trusted upstream provisioning, verified entitlement and
client compatibility, and an external token lifecycle for subscription mode.
It has no browser onboarding or automatic OAuth refresh. Its API transport uses
a separately provisioned Platform API key. Local fake-upstream tests establish
ClawRouter behavior, not live subscription eligibility or acceptance from a
deployed Cloudflare Worker.
