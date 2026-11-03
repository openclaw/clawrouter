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
