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
generic routes by itself: `requestPricingGap` currently has no selected path-model
argument. Source3 will consume the actual published classifier and context ABI;
it does not infer image execution from user text, nested JSON or duplicated
model-name heuristics. Source1 owns actual Worker bypass/zero-egress proof.

Source5 owns the focused native wrapper, complete bounded image validation and
null-token observations. The wrapper's byte/output bounds and preserved native
usage metadata do not certify a tariff. This pricing foundation does not claim
native image activation, partial-output safety, replay, cancellation or refunds.
