# Google grounded-search declaration contract

This compiler slice consumes the actual frozen codec and complete-response
wrapper from [PR669](https://github.com/openclaw/clawrouter/pull/669), landed as
`a373d25fba14791cfc362d0dd48493ad608f5893`. It does not activate a provider,
snapshot or shared runtime. Inline audio/video declarations remain a separate
slice; this contract covers only grounded search.

The exact request and response format is `google.grounded_search`, capability
`search.web`, POST `/v1beta/models/${model}:generateContent`, with one `model`
segment. The only qualified identity is `google/gemini-3.6-flash`, upstream
`gemini-3.6-flash`. The original required `x-goog-api-key` remains bound to
`https://generativelanguage.googleapis.com`. No origin, query, credential,
stream, passthrough, path remapping, lifecycle or tool-tariff override is allowed.

An explicit `nativeProxy: false` is required. The same model/path can serve
ordinary inference; model capability alone cannot distinguish the operation.
The manifest endpoint ID selects this exact contract without endpoint ordering
or body guessing. Native discovery must remain closed until shared intent
selection has its own qualification. A manifest-offer fixture is not native
route or actual client acceptance.

The model can retain its independently qualified Chat price. Its existing
`endpointPricing[endpointId]` must explicitly contain `pricing: null` and a
nonempty `pricingRef`, so selection cannot inherit the Chat tariff for search.
No new field or accounting system is introduced. Hard upstream-dollar budgets
remain closed for this endpoint; authorized `policy_fixed` remains separate.
The independent [pricing guard](https://github.com/openclaw/clawrouter/pull/725) also closes
explicit native formats before token cards, even if a caller bypasses compiled
endpoint-price selection. Both protections are activation prerequisites.

Six composed cases use the actual compiler, catalog, model selection, codec,
wrapper, bounded response reader and budget validator. They preserve original
credentials, native attribution and usage, validate explicit manifest intent,
reject incompatible declarations and retain unknown costs. No wrapper is copied.
Complete wire limits and attribution rules remain in the
[codec contract](google-grounded-search-contract.md).

Source1 must wire the actual wrapper with original grant/credential binding,
request admission, deadlines, capacity and settlement before YAML activation.
Source2 owns actual catalog-scoped search consumption and Source6 owns serialized
snapshot and composed consumer proof. No live call or deployment is claimed.
