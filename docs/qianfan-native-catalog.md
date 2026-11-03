# Qianfan frozen native Chat catalog

Scope: the five Chat cards in OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/qianfan/openclaw.plugin.json`, `provider-catalog.ts` and `index.ts`.
The existing `ernie-4.5-0.3b` seed remains unchanged. No newer model generation,
Responses/Anthropic endpoint, regional product or subscription is added.

## Identity and native facts

Primary sources checked 2026-11-03:

- [Qianfan model table](https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j)
  and [developer model table](https://cloud.baidu.com/doc/qianfan-docs/s/7m95lyy43).
- [Function calling](https://cloud.baidu.com/doc/qianfan-docs/s/xm95lyys5).
- [Deep thinking](https://cloud.baidu.com/doc/qianfan-docs/s/Wm95lyynv).
- [Qianfan product model cards](https://cloud.baidu.com/product-s/qianfan_home).

| Exact upstream ID | Qualified input | Tools | Output ceiling |
| --- | --- | --- | --- |
| `deepseek-v4-pro` | text | unrecorded | conflicting primary tables; unrecorded |
| `ernie-5.1` | text | supported | 65,536 |
| `ernie-5.0` | text, image | supported | unrecorded |
| `deepseek-v3.2` | text | supported | unrecorded |
| `ernie-5.0-thinking-preview` | text, image | supported | unrecorded |

Router IDs are `qianfan/<exact upstream ID>`. No replacement alias is installed.
The frozen legacy/deprecated hints for DeepSeek V3.2 and ERNIE 5.0 Thinking
Preview do not contain a dated shutdown contract. Current primary function,
thinking and product pages still name them. Absence from another public table
proves neither retirement nor account eligibility; no availability status or
success guarantee is inferred.

The primary tables give different exact V4 output limits (393,216 versus
131,072). Other limits are rounded `k`/`M` values, and the models API's example
V3.2 row differs from the model table. Do not turn those examples into caps or
copy frozen numeric defaults. Context limits remain absent for all five cards.
The function-calling page explicitly lists four of the frozen IDs; it does not
list V4 Pro, so this source does not advertise V4 tool support by analogy.

## Transport, thinking and usage

[Native Chat](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb) uses
`POST https://qianfan.baidubce.com/v2/chat/completions` and the selected
[API-key Bearer contract](https://cloud.baidu.com/doc/qianfan-api/s/ym9chdsy5).
`QIANFAN_API_KEY` is the existing server configuration key. Access tokens,
AK/SK credentials, other providers' keys and an alternative region are not
substitutes. Native and manifest routes retain the original grant and model.

DeepSeek V4 Pro and V3.2 accept `thinking.type: enabled|disabled`. V4's canonical
reasoning efforts are `high|max`; documented compatibility remapping of
`low|medium|xhigh` is upstream behavior, not three additional advertised levels.
The service can select `max` for complex agent requests, so this declaration
injects no default effort. ERNIE 5.0 Thinking Preview uses `enable_thinking`
(default true upstream); ERNIE 5.1 and that preview support `thinking_budget`.
These are model-specific native fields, not interchangeable controls.

Keep native tool IDs, tool results, `reasoning_content` and caller-supplied
controls unchanged. Native completion usage includes thinking and final answer
tokens. Do not add a reasoning subset again. `stream_options.include_usage`
requests terminal usage; `chunk_include_usage` requests cumulative chunk usage,
which must not be summed across chunks. Absent usage or cache evidence stays
unknown. The Chat reference's cache-token qualification for an older ERNIE
Turbo model does not establish cache behavior for these five cards.

## Keyed discovery and pricing boundary

The [native models API](https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y)
is `GET /v2/models`, with the same selected Bearer credential and no query
parameters. Its `object: list`, `data` envelope fits existing `openai.models`;
no decoder or common-runtime relaxation is needed. Strict envelope/ID parsing,
original-policy filtering, private response caching, byte/scan/deadline limits
and credential revocation remain in the shared discovery implementation.

Rows may contain native `context_length`, `max_completions_tokens`, `max_tokens`,
`prompt_tokens`, architecture, features, pricing, status and shutdown metadata.
They are observations, not an authorization or a replacement for selected-model
facts. Nullable/absent fields stay unknown. The API documents prices in CNY per
1,000 tokens and tier boundaries in thousands of tokens. No USD conversion,
account entitlement, tier interpolation, default zero or frozen price is added.
Discovery incurs no inference tariff; this does not declare inference free.
Fixture `policy_fixed` charges are independent router policy, not vendor prices.

## Existing embedding contract and ownership handoff

The frozen `index.ts` registers remote provider `qianfan` through the existing
`openai-compatible` memory adapter and `resolveRemoteEmbeddingBearerClient`.
Normalization trims the model and strips only `qianfan/` or
`openai-compatible/`. After lowercase comparison, exactly `embedding-v1`,
`bge-large-zh` and `bge-large-en` receive `maxInputsPerRequest: 16`.
That is a per-request batch cap, not a default model, output dimension, price or
entitlement. The comment points to the
[original embedding reference](https://ai.baidu.com/ai-doc/WENXINWORKSHOP/Ultiovtgu).
This source adds no embedding endpoint, codec, media file or common changes.
Source2 owns the existing native memory consumer; source3 owns schema, source1
shared runtime and source6 actual 16-input/17-input acceptance. Any missing
interface must be named before extending it.

## Proof boundary

`worker/test/qianfan-native-runtime.test.mjs` compiles the actual YAML and runs
the actual Worker with its existing grant authority and SQLite budget fixtures.
It covers both routes, the five identities, qualified tool replay, fragmented
SSE, thinking controls, cumulative/terminal usage, native images, strict private
discovery, errors, cancellation, late errors and no credential/model fallback.

Local source remains code-only under the qualified dependency policy. Prepared
cases are not executed proof. Source6 owns a later serialized generated-snapshot
slot and final integrated-head checks; this PR claims no snapshot lease.
Source2 owns actual frozen-client discovery/configuration, thinking and replay
qualification. No live key, account consent, inference, provisioning or manual
deployment is performed here.
