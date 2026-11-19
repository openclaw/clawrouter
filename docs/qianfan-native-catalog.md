# Qianfan frozen native Chat and memory contracts

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

## Separate embedding contract

The frozen `index.ts` registers remote provider `qianfan` through the existing
`openai-compatible` memory adapter and `resolveRemoteEmbeddingBearerClient`.
Normalization trims the model and strips only `qianfan/` or
`openai-compatible/`. After lowercase comparison, exactly `embedding-v1`,
`bge-large-zh` and `bge-large-en` receive `maxInputsPerRequest: 16`.
That is a per-request batch cap, not a default model, output dimension, price or
entitlement. The comment points to the
[original embedding reference](https://ai.baidu.com/ai-doc/WENXINWORKSHOP/Ultiovtgu).
The manifest declares only these three `llm.embeddings` models and the existing
`openai.embeddings` format at `/v2/embeddings`. It adds no unrestricted embedding
model passthrough, dimensions, prices, token limits, encoding defaults or generic
batch-limit schema. Chat and discovery facts remain separate.

Configure the registered OpenClaw `qianfan` memory provider with its base URL set
to the Router's `/v1/native/qianfan` route and an explicitly selected Router
credential. Use one of the three exact model IDs above; no default is inferred.
The Router resolves the original credential's Qianfan grant and forwards its
Bearer secret to the native endpoint. An unknown-price hard budget needs an
explicit fixed-cost policy; the synthetic test tariff is not a vendor price.

The separate memory fixture uses OpenClaw
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb`, the captured registered adapter, an
owned registry scope and the actual memory manager batch method. It requires
16 inputs to produce one request and 17 to produce ordered requests of 16 and
1 for each model. Direct `embedBatch(17)` is not the scheduling proof. It checks
normalization, selected credentials, response index ordering, actual request
receipts and SQLite settlement. HTTP-200 embedded errors, incomplete JSON and
invalid vector envelopes must not produce SDK vectors or trigger replay.
Router accounting and SDK validation are distinct: a complete JSON response
with an invalid vector count can still be a dispatched, fixed-cost Router
success, while the SDK rejects the result.

Pre-dispatch SDK cancellation must make no request. A separate in-flight case
for each model uses the actual registered `embed(..., { signal })` call. It waits
for real response headers, the first incomplete JSON chunk and the next original
pending read before aborting the caller. Each case needs its own SDK release,
original source cancel/return/join with no expiry, and request-bound Worker
`client_error` accounting. A test-only source-pinned witness binds the direct
embedding reader in `observeUsage` and its first logical cancellation outcome;
Chat's additional completion wrapper and receipts are not reused as evidence.
Raw read rejections remain recorded, with independent cleanup failures fatal.

Local real HTTP/Workerd controls cover this post-header route for all three
models. Independent controls also reject foreign or undefined SDK read reasons
and failed/held release; the existing first-outcome counterfactuals exercise both
reader locations. These tests do not qualify physical pre-response disconnect
propagation, which remains a separate runtime boundary. Fresh hosted qualification
is required for the changed head; previous Chat or memory results do not transfer.

## Proof boundary

`worker/test/qianfan-native-runtime.test.mjs` compiles the actual YAML and runs
the actual Worker with its existing grant authority and SQLite budget fixtures.
It covers both routes, the five identities, qualified tool replay, fragmented
SSE, thinking controls, cumulative/terminal usage, native images, strict private
discovery, errors, cancellation, late errors and no credential/model fallback.

Integration composes the source with current main and generates the snapshot
serially. The metadata endpoint uses explicit GET with no streaming protocol.
Undeclared native URL aliases remain closed with zero upstream requests.

`test/openclaw-qianfan.test.mjs` imports actual public OpenClaw
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb` from its own frozen CI checkout.
It executes the registered catalog, strict keyed discovery, host replay policy
and native serializer through real Worker/SQLite. The frozen nonreasoning
ERNIE 5.1 and DeepSeek V3.2 rows strip thinking history; the other three retain
it. Positive tool history assertions remain on every model. The cases cover
all five exact identities, V4 efforts, both image-input cards, credentials,
usage, errors, cancellation and conservative policy-fixed settlement.
The pinned registered V4 row clamps a requested `max` to `high` through the
native client's exported `clampThinkingLevel`; the fixture retains the original
`max` request and checks `high` on the wire. It does not claim literal MAX parity.
Authored cases are not execution proof; exact-head results belong in the PR.

The fixture observes original request, reader and release products and requires
their settlement before restoring observers or clearing discovery caches. It
does not close the client's shared dispatcher pool. Local observer regressions
do not qualify the fifteen actual SDK cases or physical disconnect behavior.
The bound SDK cancellation case can classify matching original read/closed
abort outcomes, and stored-error cancellation invoked before unlock. It requires
partial delivery, the observed caller abort, matching guard-input signal and
error identities, fulfilled original request release, completed unlocks and
successful cleanup. The separate controlled provider-error disposition binds
the actual SDK failure callback, exact APIError payload and identical returned
output to the invocation and acquired reader. Its three rejected reader originals
must match the distinct owned SDK abort reason, with fulfilled release and no
independent faults. Original states, reasons and counts remain retained.

Worker cancellation uses a separate, hash-bound test-bundle witness of the
actual `HttpOperation`, ingress/outbound and original fetched reader. It requires
an original caller stop, entered from owned ingress abort or downstream cancel,
with no earlier operation rejection (including revoked rejection), unset prior
status/delivery, and committed `client_error`/`canceled` before the original
inner read-failure handler. The actual protocol inspection must remain nonerror.
A secondary owned read may retain any reason, including undefined: this proves
logical outcome and complete cleanup, not native exception causality. The raw
rejected state, promise and reason remain unchanged. Single fulfilled cancel,
closed and unlock, original source cancellation with no expiry or pending work,
handler/waitUntil success, observer restoration and exact SQLite fixed-cost and
capacity assertions remain required. Foreign ownership, earlier errors and any
independent cleanup fault remain fatal. The overlay changes only the test bundle,
not shipping Worker files. SDK dispositions never apply to Worker originals.
The outer fixture requires both the once-only post-cleanup SDK receipt
and successful completion of the original consumer helper, in addition to its
independent upstream cancellation and SQLite assertions. This classifies the
observed ownership outcome; it does not establish native exception causality.
Two shared setup helpers can still mask a primary failure if their own cleanup
also fails: workerd readiness/disposal and consumer execution/fixture removal.
That helper-owner follow-up is outside this declaration's fixture changes.

This is configured native client coverage. It does not establish ClawRouter
catalog-driven or manifest client selection, the separate three-model memory
adapter, account entitlement or upstream-dollar pricing. Worker fixtures
independently cover native and manifest transport. No live key, account
consent, inference, provisioning or manual deployment is performed here.
