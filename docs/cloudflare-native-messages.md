# Cloudflare native Anthropic Messages

The frozen OpenClaw gateway provider at
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7` uses an account/gateway-specific
Anthropic base URL and `claude-sonnet-4-6`. ClawRouter's `messages` endpoint
appends `/anthropic/v1/messages` to the existing configured gateway base URL.
The existing Universal endpoint continues to accept its native array envelope.

This manifest slice uses gateway authentication with `cf-aig-authorization`
and Cloudflare's stored BYOK or Unified Billing credential resolution. It does
not forward the caller's Authorization, x-api-key or gateway token, and does not
borrow the independent first-party Anthropic environment key. Account ID,
gateway ID and the configured gateway token remain required.

[Cloudflare's Anthropic contract](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/)
specifies the pinned `anthropic-version: 2023-06-01` header and separate gateway
and provider credentials. Supplying a separate Anthropic key requires a distinct
owned credential binding to `x-api-key`; that mode is not activated by this YAML.
Never put the gateway token in the provider-key header.

[Cloudflare's Sonnet 4.6 model page](https://developers.cloudflare.com/ai/models/anthropic/claude-sonnet-4.6/)
reports a 200,000-token context. Native requests use `claude-sonnet-4-6`, not the
Workers AI name `anthropic/claude-sonnet-4.6`.
[Anthropic's model page](https://platform.claude.com/docs/en/models/sonnet-4-6/overview)
qualifies text/image input, but its first-party context and output limits do not
prove the same limits through every gateway credential mode. No gateway maximum
output is inferred from the frozen client's 64,000-token default.

The model remains unpriced. Gateway billing source, stored keys, cache behavior,
server tools and account settings must be qualified before upstream-dollar
hard-budget certification. An explicit policy-fixed fee remains separate from
that vendor-cost proof. The deterministic manifest tests verify request and
credential preparation; actual scoped Worker/client streaming, usage and
thinking-prefill acceptance are separate integration fixtures.

The native caller route is
`/v1/native/cloudflare-ai-gateway/anthropic/v1/messages`; the manifest route is
`/v1/proxy/cloudflare-ai-gateway/messages`. An Anthropic SDK that appends
`/v1/messages` must retain `/anthropic` in its selected native base. The shorter
`/v1/native/cloudflare-ai-gateway/v1/messages` is not a declared alias. Actual
ClawRouter client prefix handling and composed Worker/client acceptance must
qualify separately before activation.

The declaration uses the compiler's existing POST and empty path-parameter
defaults. Its exact registered model cannot inherit the Universal fallback or
first-party Anthropic price/output limits. Preparation fixtures cover both
native and manifest model selection and selected gateway-key isolation; they
do not establish authoritative owner dispatch, live account entitlement or
actual SDK execution. Snapshot activation remains with the serial integration
owner.

## Registered client acceptance fixture

`test/openclaw-cloudflare-messages.test.mjs` pins OpenClaw
`3ea9ca6e79c1c9a1a7fb1629f9cb88bb6046c291`. Its copied SDK fixture registers the
ClawRouter provider, discovers the selected credential's real catalog, prepares
the configured model, and uses the embedded runner's
`boundary-aware:anthropic-messages` transport. Replay uses the captured provider
registry, including the original thinking signature and paired tool result.

The fixture covers fragmented SSE and a separately released HTTP EOF, provider
errors, actual caller cancellation, unknown-price and hard-budget denials, and
missing, revoked and wrong-provider grants. Invalid catalog-offer/model cases
remove facts from a real Worker catalog response; they are explicitly malformed
fixture inputs, not evidence of a shipping catalog defect. The manifest-envelope
request is checked separately and does not stand in for registered SDK proof.

The local Worker test uses real SQLite and synthetic selected gateway credentials.
Account/gateway settings are Worker bindings so authoritative Durable Object grant
selection sees the same configuration as request handling. Each admitted request
uses a synthetic seven-micro `policy_fixed` fee, including dispatched error and
cancellation; this is not Cloudflare or Anthropic invoice pricing. Authenticated
pre-dispatch denials retain their zero-cost usage events; invalid credentials
cannot create an authenticated request receipt. Catalog-only failures do not
create inference events.

Local checks qualify fixture mechanics only. Registered SDK execution remains
behind the existing CI-only helper and requires its own successful original run.
Worker and upstream retirement join original work independently; a local client
abort, socket close, or another provider's proof does not establish Cloudflare
physical cancellation. Neither synthetic acceptance nor this declaration grants
live account entitlement, deployment authority, or vendor-dollar certification.
