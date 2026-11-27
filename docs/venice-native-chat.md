# Venice frozen native Chat inventory

Scope is the nineteen identities in `extensions/venice/openclaw.plugin.json`
at OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`. The existing
`zai-org-glm-5-2` seed stays first. No newer model generation, trait alias,
Responses, media, wallet or decision route is added.

## Primary evidence and exact identities

Checked 2026-11-03:

- [Native text inventory](https://api.venice.ai/api/v1/models?type=text) and
  [catalog contract](https://docs.venice.ai/api-reference/endpoint/models/list).
- [Chat contract](https://docs.venice.ai/api-reference/endpoint/chat/completions).
- [Reasoning controls](https://docs.venice.ai/guides/features/reasoning-models).
- [Function calling](https://docs.venice.ai/guides/features/function-calling).
- [Lifecycle contract](https://docs.venice.ai/overview/deprecations).

The bounded anonymous text catalog lists all nineteen exact IDs, with
`offline: false`, independent `availableContextTokens`/`maxCompletionTokens`,
and `supportsFunctionCalling: true`. This is model metadata, not proof of
account access, inference, enforcement or privacy attestation. Modalities below
are the intersection of the frozen input list and current native vision facts.
No name-based inference or fallback limits are used.

| Exact upstream ID (router prefix `venice/`) | Input | Context / output | Observed effort options; default |
| --- | --- | --- | --- |
| zai-org-glm-5-2 | text | 1000000 / 131072 | none, high, max; max |
| zai-org-glm-4.7 | text | 198000 / 16384 | low, medium, high; low |
| venice-uncensored-1-2 | text, image | 128000 / 8192 | absent |
| google-gemma-4-31b-it | text, image | 256000 / 16384 | none, low, medium, high; low |
| kimi-k2-6 | text, image | 256000 / 65536 | none, low, medium, high; high |
| deepseek-v3.2 | text | 160000 / 32768 | none, low, medium, high; low |
| qwen3-235b-a22b-thinking-2507 | text | 128000 / 16384 | low, medium, high; low |
| qwen3-coder-480b-a35b-instruct-turbo | text | 256000 / 65536 | absent |
| qwen3-vl-235b-a22b | text, image | 128000 / 16384 | absent |
| grok-4-5 | text, image | 500000 / 32000 | low, medium, high; high |
| qwen-3-7-max | text, image | 1000000 / 65536 | absent |
| qwen-3-7-plus | text, image | 1000000 / 65536 | absent |
| claude-fable-5 | text, image | 1000000 / 128000 | low, medium, high, xhigh, max; high |
| claude-opus-5 | text, image | 1000000 / 128000 | low, medium, high, xhigh, max; medium |
| claude-sonnet-4-6 | text, image | 1000000 / 64000 | low, medium, high, max; high |
| openai-gpt-56-sol | text, image | 1000000 / 128000 | none, low, medium, high, xhigh, max; high |
| zai-org-glm-4.6 | text | 198000 / 16384 | low, medium, high; low |
| google-gemma-3-27b-it | text, image | 198000 / 16384 | absent |
| kimi-k2-5 | text, image | 256000 / 65536 | none, low, medium, high; high |

Gemma 4's current native output observation is 16384; the frozen 8192 fallback
is not copied. Six rows lack effort support, including two Qwen 3.7 models
that do support reasoning. Reasoning does not imply an effort menu. The native
catalog leaf now preserves a bounded unique `reasoningEffortOptions` list only
with explicit `supportsReasoningEffort: true`, and a default only when it is an
observed member. Missing or malformed fields stay unknown. Neither metadata
projection nor fixtures rewrite the caller's reasoning control.

Frozen GLM 4.6, Gemma 3 and Kimi 2.5 have deprecated/replacedBy hints. The current
primary catalog has no deprecation object for those exact IDs. There is no
qualified dated shutdown or serving alias in this slice: all selected IDs stay
literal, and `availability` remains absent. The lifecycle page's general
replacement/410 policy cannot identify a particular serving model. A future
qualified cutoff must use the existing availability contract and runtime guards.

## Transport and fixture contract

Original `VENICE_API_KEY`, Bearer, `https://api.venice.ai/api/v1`, and
`/chat/completions` remain fixed. OpenAI, Anthropic and OpenRouter credentials
are not substitutes. Actual Worker tests compile this manifest and use the
existing authority, grant and SQLite budget fixtures on both native and manifest
routes. They cover all nineteen JSON/SSE identities, tool replay, separate
reasoning content, fragmented tool deltas, thirteen vision inputs, grant and
revocation failures, unknown upstream cost, HTTP errors including 410, streamed
errors, missing usage and reader cancellation. Native token counts are counted
only when observed; `policy_fixed` seven-micro settlement is fixture policy,
not a Venice tariff. No `stream_options` is injected into frozen client traffic.

Each observed effort menu is exercised with flat `reasoning_effort` and nested
`reasoning.effort`; native `reasoning.enabled: false` remains a separate field.
Opaque encrypted-reasoning placeholders survive replay. `max_tokens` and
`max_completion_tokens` remain distinct on the wire. Root `cost.usd` and
`cost.diem` survive the response independently; no currency conversion, advance
price ceiling, zero cache price or native settlement claim is made.

## Qualified profile and remaining integrations

- The qualified [Chat runtime](venice-chat-runtime.md) rejects every caller
  `fallbacks` field before egress, including an empty array. Complete JSON and
  each SSE data payload must explicitly name the selected model before delivery.
  Non-200 replies and embedded errors are withheld with conservative dispatched
  settlement. No alternate-model, vendor-default, beta or Responses fallback is
  qualified. The frozen native SDK does not send fallbacks.
- Optional USD/DIEM observations remain separate from policy settlement. Do not
  alias currencies or infer a complete upstream-dollar price.
- Public native discovery is separate from these nineteen Chat cards. Its
  `venice.models` request/filter/reader uses credential-free
  `veniceCatalogRequest(base, signal)`; original private caller authorization
  and grant filtering remain local. Canonical paired GET `/models` has no
  endpoint auth override, and the helper fixes `type=text`. This PR adds no
  discovery endpoint or discovery-consumer acceptance.
- The configured-native consumer fixture imports the actual public client,
  registered model/stream hooks and host replay sanitizer, including Grok
  tool-schema/HTML-entity argument compatibility. Its exact-head hosted run is
  the execution gate. Fable/Opus codeMode hints establish no separate coding
  runtime, and configured-native proof is not catalog-driven client selection.
- Serialized generated-snapshot and composed consumer qualification belong to
  integration. Unknown pricing still blocks upstream-USD hard budgets; model
  facts alone are not live availability or account entitlement.

The original source checkout was code-only. Serialized integration uses its
qualified own-install checkout, generated snapshot and exact-head hosted checks.
A snapshot gate before Worker tests remains unrun proof. No live inference,
login, provisioning or manual deployment was performed.
