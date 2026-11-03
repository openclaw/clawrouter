# Native decision codecs

These modules implement native request admission, typed response validation and
token evidence. They do not register routes or replace the OpenClaw DecisionV2
bridge. The codecs accept text/JSON SystemOne state, text/list Sage content and the native
inline image envelopes described below. Unsupported question types fail before
dispatch. Transport admission does not certify a model’s vision capability.

| Family | Native endpoint | Credential | Wire format |
| --- | --- | --- | --- |
| Levanto Sage | `https://sage.levanto.ai/decide` | `SAGE_API_KEY`, Bearer | `sage.decide` |
| Levanto Sage batch | `https://sage.levanto.ai/decide/batch` | Same product key | `sage.decide_batch` |
| Liquid AI | `https://api.liquid.ai/decisions/v1/systemone` | `LIQUID_API_KEY`, Bearer | `systemone.decisions` |
| TypeSafe hosted | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY`, Bearer | `systemone.decisions` |

Sage selects its model server-side; do not inject a model field. Its documented
response identifies `levanto-sage-2`. Liquid's current hosted models are `d1.1`
and `d1-ultra`; the earlier `d1` is a separate model name. TypeSafe's `jev-latest`
is an alias; its response may report a different concrete model. A local Kev
server is a separate configured transport, not the hosted credential contract.

## Runtime and client handoff

- `prepareSageRequest(value, batch)` admits native requests and preserves question
  IDs, rubric units, reasoning modes and list identities. `decodeSageResponse`
  correlates every response with those questions and returns native answers plus
  `UsageInspection`. Batch usage comes only from top-level `meta.usage`; summing
  child usage would double count. Valid per-answer failures stay in their slots.
- `prepareSystemOneRequest(value, selectedModel, product)` binds the selected
  model after policy admission. `decodeSystemOneResponse` validates the native
  question types, answer IDs, complete probability maps, score legends and token
  counters. `product` is the selected provider, never a caller-selected override.
- Noul is a probability, not a thresholded boolean. Sage yes/no and choice retain
  `null` abstention. Confidence is provider-specific; scores remain in the native
  rubric's units. Do not normalize distributions or recompute scores.
- Native response bytes remain unchanged. The observer validates a bounded JSON
  body and supplies token evidence to normal caller attribution and settlement.
  Missing Sage usage remains unknown. Liquid requires its documented zero output
  count; TypeSafe's actual output count is preserved. Neither implies free input
  or installs a tariff. Unknown prices need the normal explicit policy price or
  pre-egress rejection under hard budgets.
- The compiler/catalog owner must qualify `levanto-sage`, `liquid-ai-systemone` and
  `typesafe-systemone` decision protocols for these formats instead of describing them as `openai-decisions`.
  The client owner maps DecisionV2 to native requests and validates the decoded
  answer contract. Keep Sage batch and single endpoints distinct.

The generic runtime owner owns routing, credentials and accounting integration.
The new provider manifests and focused codecs have the same family owner; shared
schema/compiler and DecisionV2 consumer work have separate owners. End-to-end
proof must import the actual client bridge and exercise native dispatch, answers,
usage and budget behavior. Codec tests alone are not that proof.

## Evidence

Primary contracts checked on 2026-11-03:

- [Sage quickstart](https://docs.levanto.ai/quickstart),
  [batch contract](https://docs.levanto.ai/decision-model/batch),
  [choice](https://docs.levanto.ai/decision-model/choice) and
  [scale](https://docs.levanto.ai/decision-model/scale).
- [Liquid hosted d1 API](https://docs.liquid.ai/lfm/models/d1).
- [TypeSafe OpenAPI](https://api.typesafe.ai/openapi.json).

Consumer comparison is pinned to OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`, including its Levanto, Liquid AI,
TypeSafe and SystemOne codecs. No dependency on an unpinned future client exists.

`node --test worker/test/provider-decision-codecs.test.mjs` exercises typed
fixtures, native meaning, rejection, malformed usage and batch correlation.

## Inline images

Sage preserves `content: {kind: "image", media, text?}` in single and batch
requests. Only PNG/JPEG/WebP data URIs are accepted; image Sort is rejected and
image Choice permits at most 20 options. Image Tags cannot return null verdicts.
Native `meta.usage.image_tokens` survives unchanged. Its overlap with
`input_tokens` is not yet qualified, so Sage image inspection returns unknown
token usage instead of fabricating an additive or inclusive total. Fixed-policy
accounting can still use the validated success outcome.

Liquid preserves its ordered `images` array (up to eight data URIs or
`{content_type, base64}` objects), including GIF. Its aggregate `input_tokens`
already includes images. TypeSafe instead preserves referenced `assets` with
PNG/JPEG bytes. Placeholder references must occur in state, instructions or
criteria; unused or overlapping names are rejected. Multipart assets and box
questions are outside this frozen DecisionV2 slice.

After preparing a TypeSafe body, the shared runtime must apply
`systemOneRequestHeaders(request, "typesafe")`; image requests require
`TypeSafe-Danger-Zone-Images: true`. This header is not sent to Liquid or to
text-only TypeSafe requests. The client creates collision-free references; the
router does not replace or generate them.

The image helper validates canonical base64, decoded byte bounds and media
signatures without decoding the full image into a second buffer. Full body bounds
still include base64, text and questions. Pixel decoding/dimension checks and
model vision eligibility remain separate; the common runtime needs the existing
bounded image parser's provider-neutral dimensions before it can advertise
Sage's edge/area limits or Liquid's patch/aspect limits. No image price or local
executor is inferred from accepted wire fields.

Primary image contracts: [Sage images](https://docs.levanto.ai/decision-model/images.md),
[Sage limits](https://docs.levanto.ai/decision-model/limits.md),
[Liquid image inputs](https://docs.liquid.ai/lfm/models/d1), and
[TypeSafe's OpenAPI assets](https://api.typesafe.ai/openapi.json).
Typed image fixtures and rejection/accounting checks run with
`node --test worker/test/provider-decision-images.test.mjs`.
