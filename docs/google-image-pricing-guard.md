# Explicit Google image pricing guard

The frozen E06 image request format is `google.image_generate`, with response
format `google.image`, for `gemini-3.1-flash-image` and `gemini-3-pro-image`.
This change adds no model, manifest, wrapper, snapshot or route activation.

`requestPricingGap` returns the existing conservative `opaque_input_bound` gap
for this exact format, regardless of an attached text, zero-rate or other
provider's image card. `estimateModelCost` refuses to produce token bounds or
a qualified price. `actualModelCost` returns null even if raw counters or a
nonbillable flag are supplied. No Google image tariff, text-token bill, provider
receipt or zero-cost inference is derived from a bounded JSON/image envelope.

The existing accounting path denies caller/provider upstream-dollar hard budgets
before dispatch. Explicit `policy_fixed`, including authorized fixed zero, keeps
its separate basis and null token fields. Unmetered settlement stays labeled
`unpriced_usage`; its ledger value is not a known invoice or a free-generation
claim. Eight focused estimator/admission/settlement cases cover these boundaries
and retain ordinary Google text and qualified OpenAI image behavior.

## Required shared continuation

Source1 owns one shared classifier accepting selected upstream model, body and
request format, and threads that context through generic GenerateContent,
streaming and pricing callers. This explicit-format guard does not close those
generic routes by itself: the optional selected-model
argument must come from trusted routing. The helpers consume the published ABI;
they do not infer image execution from user text, nested JSON or duplicated
model-name heuristics. Source1 owns actual Worker bypass/zero-egress proof.

Source5 owns the focused native wrapper, complete bounded image validation and
null-token observations. The wrapper's byte/output bounds and preserved native
usage metadata do not certify a tariff. This pricing foundation does not claim
native image activation, partial-output safety, replay, cancellation or refunds.

## Shared selected-model context

The direct pricing helpers consume `googleImageRequest` from source1's
`worker/google-image-classification.ts`, published in
[PR662](https://github.com/openclaw/clawrouter/pull/662). `PricingEndpoint` accepts
optional `selectedUpstreamModel`, matching the actual shared estimator call.
`requestPricingGap` accepts the same trusted identity as an optional fifth
argument, after existing `parentTools`; earlier callers remain compatible.
Both helpers reuse the classifier for formal native output modalities and the
two selected image models. Neither reads `body.model`, prompt text or nested
user JSON as model authority, and no second model/modality classifier is added.

The existing explicit-format settlement guard remains. Source1's accounting
freezes generic-image classification before dispatch and rejects token-based
settlement from that frozen fact; this pricing slice does not change common
callers, matching or settlement. Generic native/manifest Worker zero-egress
proof remains source1-owned. Model-less helper callers can classify formal
output modalities but need trusted selected context for model-specific intent.
