# Native xAI image admission and cost receipts

This contract extends `endpoint.requestPricing` with `unit: image` and
`protocol: xai.images`. It qualifies the existing `prepareXaiImage` and
`readXaiImage` exports from `worker/xai-images.ts`. The compiler accepts only
POST `/v1/images/generations` (`xai.images_generations`) and JSON POST
`/v1/images/edits` (`xai.images_edits`), both returning `xai.images`, with
`image.generate`, original global Bearer API-key auth and the three frozen
model identities. Streaming, deferred jobs, raw controls, model passthrough,
credential overrides and token-price substitutions are excluded.

No existing YAML or generated snapshot activates these routes in this change.
The ordinary token estimator continues to report these models as unpriced.
Source 11.1 owns shared types, dispatch, admission and settlement integration;
source 11.2 owns actual image consumers; source 11.6 owns serialized snapshot
and integrated proof. Source 11.3 retains the existing manifest and tariff.

## Published units and alias

Primary rates checked 2026-11-03, in micro-USD per image:

| Serving model | Input | 1k output | 2k output |
| --- | ---: | ---: | ---: |
| grok-imagine-image | 2,000 | 20,000 | 20,000 |
| grok-imagine-image-2.0, low | 10,000 | 40,000 | 60,000 |
| grok-imagine-image-2.0, medium | 10,000 | 60,000 | 80,000 |

The tariff's closed `rates` object keys actual serving models. Its `alias`
records selected model `grok-imagine-image-quality`, serving model
`grok-imagine-image-2.0`, quality `low`, effective date `2026-11-02` and the
primary migration source. The retired slug remains the selected policy/request
identity. It is not an independent live model and is never rewritten to direct
2.0 auto. The compiler rejects a different alias target, quality or rate matrix.

## Exported pricing boundary

`worker/pricing.ts` exports `ImageRequestPricing`, `ImageRequestSelection`,
`imageRequestReserve(pricing, selection)` and
`imageRequestCost(pricing, selection, originalJson, complete)`.

`ImageRequestSelection` is the secret-free projection of the validated codec
request: `model`, `servingModel`, `mode`, `count`, `inputImages`, `resolution`,
`quality` and `qualityBasis`. Call `prepareXaiImage` before constructing it.
Freeze it with the original caller, model, endpoint, credential and tariff
version for reservation/settlement. Never derive it from unvalidated caller
metadata or returned model identity alone.

The reserve helper returns integer micro-USD or `null` for an unqualified
selection/rate/overflow. It bounds one to four outputs and zero to three input
images at 1k/2k. Every edit reference is conservatively reserved per output;
this multiplicity is admission headroom, not an observed bill. Direct 2.0 auto
reserves the higher qualified quality at the selected resolution. Explicit
quality uses that rate. The supported retired alias always uses low, including
edits; unaffected 1.0 keeps its separate rates. No video-second, token or
Responses violation charge is substituted into this tariff.

The cost helper accepts only complete original native JSON with the expected
serving model and safe nonnegative integer `usage.cost_in_usd_ticks`. It returns
`{ costMicros, basis: "provider_reported", pricingVersion }`. One USD is
10^10 ticks; round upward to integer micro-USD. This is the whole request cost:
never add the rate estimate, input-image cost or an assumed outcome fee again.
A valid explicit zero receipt is evidence; missing receipt is not zero.

The shared runtime must attest original global-origin HTTP response identity,
bounded JSON/UTF-8 EOF, deadline and manual redirects before passing `complete`.
Image delivery remains independently validated by the codec; a cost receipt
does not authorize partial or malformed media delivery. Missing/unsafe receipts,
foreign models, errors and interrupted responses retain the dispatched reserve
through the existing uncertainty/outbox path. Never replay an uncertain paid
POST. Explicit `policy_fixed` remains separate from upstream-dollar accounting.

## Evidence and tests

The focused compiler/pricing tests consume the real native codec and
`providers/_fixtures/xai/images.json`, preserving selected/serving identity,
native paths, low versus auto admission, repeated input multiplicity, actual
tick receipts, unknown accounting and rejected credentials/protocols.
The image bytes are synthetic; these checks are not live-provider or actual
client/runtime activation proof.

- [Published image unit rates](https://docs.x.ai/developers/pricing)
- [Retired quality alias and direct auto defaults](https://docs.x.ai/developers/migration/imagine-image-quality-nov-2)
- [Native Images receipt fields](https://docs.x.ai/developers/rest-api-reference/inference/images)
- [Whole-request ticks and conversion](https://docs.x.ai/developers/cost-tracking)
