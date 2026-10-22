# OpenAI Moderations

ClawRouter supports standalone text/image moderation with the OpenAI-native JSON
request and response contract:

| Route | Request |
| --- | --- |
| `POST /v1/moderations` | Native JSON; canonical or bare OpenAI model ID |
| `POST /v1/native/openai/v1/moderations` | Native JSON |
| `POST /v1/proxy/openai/moderations` | Manifest envelope: `{ "body": { "input": "…", "model": "omni-moderation-latest" } }` |

Supported models: `omni-moderation-latest` and `omni-moderation-2024-09-26`.
An omitted model resolves to `omni-moderation-latest` **before** model-policy
checks. The input may be a string, an array of strings, or text/image input
objects (including image URLs and image data URLs). Upstream response bytes,
status and `Retry-After` remain intact. This does not enable audio moderation,
legacy text-moderation models, generation-time moderation, or arbitrary models.

## Authorization and accounting

The endpoint uses the ordinary authenticated proxy path: current key, owner,
policy and model permissions, provider connection, selected grant eligibility,
quota/cooldown feedback and content-retention settings all remain authoritative.
Only API-key grants (or the configured environment API key) qualify. OAuth and
ChatGPT subscription grants are not a documented Moderations transport.

OpenAI documents moderation as **free**. Both admission and settlement use zero,
even if the policy has a fixed generation price, the upstream returns an
unexpected usage-shaped field, or delivery fails after dispatch. Usage events
still record attribution and outcomes. Configured budget blocks retain existing
semantics; free does not disable policy or quota controls. No model token-context
ceiling is invented to represent the free endpoint: the model has a source-tagged
pricing reference and operation-owned zero pricing, not a token-generation card.
The compiler reserves the `openai.moderations` request format for provider
`openai`; wire-compatible third parties do not inherit this free tariff.

**Operator note:** policies permitting OpenAI with `models: null` (no model
allowlist) also permit these moderation models. Use an explicit model allowlist
to exclude them when needed. Free requests still consume the selected account's
moderation rate limits; a positive monetary budget does not cap their count.
Configured zero-budget blocks and upstream quota/cooldown controls still apply.

## Verified upstream sources (2026-10-21)

- [Model and free pricing](https://developers.openai.com/api/docs/models/omni-moderation-latest)
- [Moderation guide](https://developers.openai.com/api/docs/guides/moderation)
- [Create contract](https://developers.openai.com/api/reference/resources/moderations/methods/create)
- [Official generated Node SDK](https://github.com/openai/openai-node/blob/master/src/resources/moderations.ts)
- [Official OpenAPI](https://github.com/openai/openai-openapi/blob/master/openapi.yaml):
  `CreateModerationRequest.model.default = omni-moderation-latest`.

Verification uses synthetic upstreams only, including actual workerd and durable
SQLite accounting. No paid/live provider calls or deployment are involved.
