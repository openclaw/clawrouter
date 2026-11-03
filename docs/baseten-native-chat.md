# Baseten frozen Chat contracts

This source slice declares the six frozen Chat cards beside the existing
`zai-org/GLM-5.3` seed. It preserves the original Baseten grant and selected slug.
It does not register SystemOne, Responses or Messages, or activate a snapshot.

## Qualified finite identities

The roster is frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/baseten/{openclaw.plugin.json,models.ts,index.ts}`. Current primary
contracts checked 2026-11-03:
[overview](https://docs.baseten.co/inference/model-apis/overview),
[reasoning](https://docs.baseten.co/inference/model-apis/reasoning),
[vision](https://docs.baseten.co/inference/model-apis/vision),
[Chat API](https://docs.baseten.co/reference/inference-api/chat-completions), and
[pricing and limits](https://docs.baseten.co/inference/model-apis/pricing-and-limits).

| Exact upstream ID | Qualified inputs | Reasoning control |
| --- | --- | --- |
| `deepseek-ai/DeepSeek-V4.1-Flash` | text, image | `reasoning_effort`; high by default |
| `deepseek-ai/DeepSeek-V4-Pro-0813` | text | `reasoning_effort`; frozen client also sends matching `thinking.type` |
| `zai-org/GLM-5.2` | text, image | `chat_template_args.enable_thinking`; off by default |
| `zai-org/GLM-5.2-Fast` | text, image | `reasoning_effort`; frozen client also sends `chat_template_args` |
| `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B` | text | `chat_template_args.enable_thinking`; off by default |
| `openai/gpt-oss-120b` | text | `reasoning_effort`; medium by default; `none` can still reason |

All six support tools. Current documented effort values are attached to each
card, without copying the frozen client's effort aliases into Worker transforms.
Fast remains its own selected product even if Baseten serves it on base capacity;
no model rewrite or base-product tariff is inferred. The existing seed is kept,
with no extra current-generation models.

The primary overview's dynamic table confirms every exact slug above. Its
rounded context/output numbers and its warning that `/v1/models` may report
different limits do not establish exact enforced token bounds. Those fields stay
unset pending precise qualification; frozen 1,048,576 versus rounded 1,048K is not
silently normalized. Vendor prices remain unknown, including cache rates. A
policy-fixed charge is not a Baseten tariff or account entitlement.

## Native wire and proof

Chat uses `POST https://inference.baseten.co/v1/chat/completions` and the original
selected `BASETEN_API_KEY` Bearer credential. The manifest allows only the named
`x-session-affinity` caller header for opaque cache affinity. It does not generate
an identifier from private conversation content or add a credential fallback.
Client2 retains affinity generation/disable behavior and native thinking/replay
normalization; Worker carries the resulting wire unchanged.

Real Worker/SQLite fixtures exercise each selected card through native and
manifest routes, JSON and fragmented SSE, reasoning/tool replay, streamed tool
arguments, original credentials, fixed reservations, cached-input subsets,
errors, missing usage and cancellation. Separate cases preserve all three image
inputs and the old seed. Synthetic fixture observations are not live provider
proof. Client2 and proof6 still own actual native client acceptance.

The three frozen `decision-models/baseten-{elephant-9b,mammoth-27b,joey-2b}-latest`
rows are known with no executable Chat capability. Six route cases prove they
cannot revive through opaque Chat passthrough. This is a protocol boundary, not
retirement. Their independent codec is documented in
[the SystemOne contract](baseten-systemone-contract.md); schema, wrapper, central
dispatch/accounting and actual DecisionV2 client remain separate dependencies.

## Native discovery follow-through

The primary overview qualifies authenticated `GET /v1/models` on the same origin
and key. Frozen `models.ts` consumes `data` rows with optional `object: model`,
`context_length`, `max_completion_tokens`, `supported_features` and per-token
pricing; it excludes the entire `decision-models/` namespace from Chat discovery.
It must not copy missing-price zeroes, context defaults or completion defaults.
The frozen strict refresh uses 10-second timeout and five-minute TTL, with no
static fallback after an authorized refresh failure. Missing selected discovery
auth and an authoritative empty catalog are distinct states.

This slice does not advertise an unqualified `openai.models` endpoint or relax
that strict decoder. Source4 retains the focused native catalog codec work;
source1/schema3 must qualify dispatch/filtering and common fact projection, with
original-grant scope and decision-only exclusion. Exact metadata observations do
not supersede endpoint-enforced limits. No snapshot lease, live key, host install,
account action or deployment is part of this source change.
