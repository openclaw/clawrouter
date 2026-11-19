# Featherless frozen native Chat card

This source slice adds only `featherless/Qwen/Qwen3-32B`, keeping its exact native
`Qwen/Qwen3-32B` identity and the existing `GalrionSoftworks/Margnum-12B-v1` seed.
Both use the original `FEATHERLESS_API_KEY` grant and canonical
`https://api.featherless.ai/v1/chat/completions`. A HuggingFace token is not that
API key. No newer model, alias, alternate endpoint or plan entitlement is added.

## Frozen and primary evidence

OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`:

- `extensions/featherless/openclaw.plugin.json`: one Qwen3-32B Chat card,
  text input, Qwen chat-template thinking and `max_tokens` compatibility.
- `extensions/featherless/index.ts`: strict refreshable Chat discovery,
  preserved reasoning history and OpenAI tool replay.
- `extensions/featherless/models.ts`: synthetic dynamic 4096/1024 limits, which
  are not copied to unknown models or the provider declaration.

Primary sources checked 2026-11-03:

- [Tool calling](https://featherless.ai/docs/tool-calling) qualifies native
  Qwen3 function calls and tool-result conversation replay.
- [Thinking controls](https://featherless.ai/docs/chat-template-kwargs) qualifies
  `chat_template_kwargs.enable_thinking` and retained `reasoning_content` for
  original Qwen3. No effort alias or Qwen3.5-only preservation field is injected.
- [Model compatibility](https://featherless.ai/docs/models-model-compatibility)
  and one bounded anonymous [exact model observation](https://api.featherless.ai/v1/models/Qwen/Qwen3-32B)
  independently qualify text input, tools and context 32768. The response omitted
  `max_completion_tokens`; frozen 4096 is not asserted as a served output limit.
- [Plan limits](https://featherless.ai/docs/api-reference-plan) can lower effective
  context below the model's declared support. Catalog metadata is not entitlement.
- [Completion API](https://featherless.ai/docs/completions) distinguishes
  `max_tokens` rejection from `max_completion_tokens` clamping and precedence;
  the router preserves both fields. Native JSON and terminal SSE expose usage,
  including cached tokens and optional settled USD `usage.cost`.
- [Billing](https://featherless.ai/docs/billing) and
  [Developer prices](https://featherless.ai/docs/request-pricing-and-credits)
  distinguish token credit charges from subscription/dedicated capacity.

A public model response establishes inventory observations, not access for a
selected account, a paid-plan reservation, cold-host readiness or inference proof.
Current source prices remain absent. No frozen zero cache price or account-neutral
rate card is manufactured. Context metadata describes support and cannot replace
pricing/admission reservations. The existing seed remains unpriced without new
capability claims; unknown passthrough identities gain no copied facts.

## Actual Worker fixtures

The focused test imports the real Worker, compiler, private authority, original
grant store and SQLite budget fixture. It replaces only Featherless in an isolated
snapshot. Native and manifest routes cover JSON and fragmented SSE, exact original
credentials, private catalog offers, reasoning/tool replay, explicit observed usage,
usage omission, interrupted streams, embedded errors and HTTP errors. Unknown-cost
budget admission and revoked/missing credentials stop before egress. Synthetic
policy-fixed seven-micro charges are not vendor charges.

The primary stream matrix includes documented terminal usage without injecting
`stream_options`. Separate cases retain unknown counts when usage is absent.
Subscription fixtures omit `usage.cost` without converting the omission to a zero
price. Complete USD receipts remain byte-preserved and distinct from the policy
charge; this slice does not wire a new upstream-dollar settlement extractor.

Frozen client flags for store/developer roles, strict tools and streaming usage
remain source2's actual SDK compatibility responsibility. These deterministic
Worker fixtures do not prove provider-side execution, cancellation or billing.
Source6 must qualify the final integrated snapshot and actual consumer.

## Concrete handoffs

- Source1: qualify optional `usage.cost` as the documented USD request receipt
  only after complete successful JSON or terminal SSE delivery. Preserve missing,
  malformed or interrupted observations and the independently selected policy
  charge; no receipt can invent an advance budget bound or account entitlement.
- Source2: use the exact Featherless grant/model, preserve Qwen3 reasoning/tool
  history and native kwargs, and do not synthesize output limits or zero prices.
  Qualify actual stream usage despite the frozen unsupported-usage client flag.
- Sources1/3: consume landed catalog codec
  [PR658](https://github.com/openclaw/clawrouter/pull/658), squash
  `68e272ea9293399316eec9f3bbca1f8cb94efd22`, before discovery activation. The
  published `featherless.models` page contract and original-key/scan guards are in
  [the catalog handoff](featherless-model-catalog.md). This declaration adds no
  discovery endpoint or public-auth override.
- Source6: a later explicit serialized snapshot slot and final actual-client
  acceptance are required. Source4 has no snapshot lease. The committed snapshot
  is intentionally unchanged; early CI may therefore skip prepared Worker tests.

No common runtime/compiler/client changes, host provisioning, account access,
credentials, inference calls, manual deployment or production proof are included.
