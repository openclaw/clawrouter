# Arcee native catalog declaration

This finite compiler contract consumes [PR646](https://github.com/openclaw/clawrouter/pull/646),
source `32acc13d75ce9f256dea94283a1dd11212540997`, landed as
`09e0d063fa99633103734b530d3879248d5b75bc`. Its exports are
`arceeCatalogRequest`, `filterArceeModels` and `readArceeModels` in
`worker/arcee-model-catalog.ts`; see [the codec contract](arcee-native-catalog.md).

Primary qualification on 2026-11-03: the [Models API](https://docs.arcee.ai/api-reference/models)
specifies GET `/api/v1/models` and a native data-only envelope. The
[first-call guide](https://docs.arcee.ai/api-reference/your-first-api-call)
qualifies the direct service and Bearer credential. This declaration does not
change the existing Chat endpoint spelling or substitute OpenRouter credentials.

## Exact declaration

- Provider `arcee`, every base URL exactly `https://api.arcee.ai/api/v1`.
- One required Bearer `api_key` scheme, `Authorization: Bearer ${secret}`.
- One endpoint with explicit `method: GET`, `path: /models`, request and response
  formats both `arcee.models`, and exactly one `models.list` capability using GET.
- No mapping, path parameters, query defaults, caller request headers, endpoint
  auth override, credential/grant transport override or adapter injection.
  The only optional fixed header is `accept: application/json`.
- No inference pricing, model passthrough, streaming, lifecycle or output limit.
  Native proxy remains enabled; the actual request is bodyless.

Native metadata is not a model card or account entitlement. The three frozen
direct identities are `trinity-mini`, `trinity-large-preview` and
`trinity-large-thinking`. Exact original policy filtering applies; `openrouter.slug`
cannot rewrite identities, credentials or destinations. Empty permitted lists
remain empty. No model row or current tariff is introduced here.

The actual codec requires native input/output modalities and positive integer
context/output observations. Non-text rows are excluded from Chat. Missing or
invalid required observations fail; static defaults cannot fill them. Independent
limits remain observations rather than enforced serving maxima. Optional features,
sampling parameters and each of the six native price strings remain absent when
unknown. Explicit observed zero strings stay explicit; no zero fallback, arithmetic,
price-unit conversion or inference tariff is derived. Existing compiled cards and
the strict OpenAI catalog decoder remain unchanged.

## Activation handoff

Source1 owns `arcee.models` registration and dispatch through existing model
discovery: original grant/key, complete response/deadline checks, policy filtering,
revocation, cache revalidation and stopped-model exclusion. Source4 owns the
Arcee declaration only after both shared contracts and real Worker fixtures
qualify. Source2 owns actual client catalog consumption; source6 owns serialized
snapshot and client/Worker acceptance. This compiler slice changes no YAML,
snapshot, shared runtime, account or deployment and does not activate discovery.

Seven focused cases compose the compiled declaration with the actual codec for
canonical requests, malformed declarations, original-key isolation, exact policy
identities, required native metadata, independent unknown prices and unchanged
strict OpenAI decoding. Baseten's existing six compiler cases also retain its
separate canonical origin and native format through the shared finite validator.
