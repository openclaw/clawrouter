# DeepInfra native catalog

This focused codec implements the frozen catalog protocol; it does not activate
refresh, model cards or tariffs. The existing Chat seed and opaque-model route
remain unchanged. Common dispatch, authorization and publication remain runtime
integration work, followed by real Worker and actual-client proof.

## Qualified sources

Frozen OpenClaw revision `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`:
`extensions/deepinfra/{openclaw.plugin.json,provider-models.ts,pricing-api.ts}`.
Primary contracts checked 2026-11-03:

- [OpenAI model metadata](https://docs.deepinfra.com/api-reference/models/openai-models.md):
  Bearer authentication, list envelope and native metadata fields. The frozen
  `/v1/openai/models?sort_by=openclaw&filter=with_meta` route is the qualified
  compatibility path; the reference also documents `/v1/models`. A successful
  anonymous request does not establish a public-auth contract.
- [Native public inventory](https://docs.deepinfra.com/api-reference/models/models-list.md):
  `/models/list` array, token pricing, `deprecated` and `replaced_by`. The native
  `max_tokens` field describes context size, not a completion cap.
- [Deprecation behavior](https://docs.deepinfra.com/models.md): requests to a
  deprecated model can be forwarded upstream to its recommended replacement.
  Preserve selected model, tariff identity and observed serving model separately.

## Published codec contract

`worker/deepinfra-model-catalog.ts` exports:

- `deepinfraCatalogRequests(inferenceBaseUrl, selectedApiKey, signal)` returns
  `{metadata, pricing}` GET requests. Only the canonical DeepInfra Chat base is
  accepted. The original selected credential goes only to model metadata.
  Public pricing receives no authorization, cookies or forwarded headers. Both
  requests reject redirects and use the same caller-owned deadline signal.
- `parseDeepInfraCatalog(metadata, pricing, permittedModelIds)` returns
  `{models, availability}`. It accepts only exact permitted IDs; replacement
  names never authorize another model. Metadata prefers the native Chat bucket,
  using VLM only when that bucket is empty, before policy filtering. Media-only
  rows cannot become Chat. Missing metadata is skipped; entirely unusable
  nonempty metadata, duplicate IDs and malformed envelopes fail closed.
- `readDeepInfraCatalog(responses, signal, permittedModelIds)` consumes both
  responses concurrently, at most 2 MiB and 4,096 rows per source. Both readers
  settle before publication. Failed metadata never falls back to static seeds.
  Failed pricing permits only an authoritative empty Chat inventory; abort
  never returns empty success. Existing `readNativeJson` owns byte, MIME, HTTP,
  UTF-8, length, redirect and stream-release validation.

Model output preserves native tags, nullable context and `nativeMaxTokens`.
Missing reasoning/vision tags remain unknown, not negative capability proof.
Pricing is an observation in **USD cents per token**, with nullable discount
and cached-input ratio; it is not a billable tariff. Conditional prose/tables,
expiry and generic cache-write schedules stay unknown. Missing prices, discount,
cache ratio, cache writes and output limits never become zero. Explicit native
zero is distinguishable from absence. Service tiers, explicit cache retention,
account prices and conversion into executable tariffs require their own
qualified runtime contract.

Availability observations preserve the native deprecation epoch and optional
replacement ID, including rows absent from current metadata. They do not label
absence as retirement, infer entitlement, rewrite a selected ID or add a new
replacement card. Common availability projection must validate effective dates
and provenance against `docs/model-availability-contract.md` before publication.

## Finite frozen disposition

The current native metadata advertised seven of the eight frozen Chat IDs on
2026-11-03. The native public inventory independently documents the eighth's
replacement. Advertisement is not proof of account entitlement.

| Frozen ID | Qualified observation |
| --- | --- |
| `deepseek-ai/DeepSeek-V4-Flash` | Advertised native Chat metadata |
| `deepseek-ai/DeepSeek-V4-Pro` | Advertised native Chat metadata |
| `zai-org/GLM-5.2` | Advertised native Chat metadata |
| `moonshotai/Kimi-K2.6` | Advertised native Chat/vision metadata |
| `nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B` | Advertised native Chat metadata |
| `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` | Advertised native Chat metadata |
| `deepseek-ai/DeepSeek-V3.2` | Advertised native Chat metadata |
| `zai-org/GLM-5.1` | Native `deprecated:1790896957` (2026-10-01), `replaced_by:zai-org/GLM-5.3`; retain selected identity and do not add a GLM-5.3 card |

These observations come from the exact two endpoints above. The already-landed
`Qwen/Qwen3.8-27B` seed is preserved; this continuation does not reopen it or
expand the static frozen roster to newer market models.

## Runtime and client handoff

Runtime1 must resolve the original selected grant, bind refresh/cache identity
to that credential and product, use its bounded deadline for both fetches, and
revalidate original policy/grant eligibility before publication. Do not put
refresh on the foreground inference hot path or cache account metadata globally.
A set of permitted IDs is the intersection of the frozen/authorized surface and
that original policy; the codec itself performs no credential lookup or retry.
Strict OpenAI discovery parsing remains unchanged.

Source4's finite model declarations and real Worker inference fixtures follow
this codec. Source3 owns fact/compiler support; runtime1 owns availability and
tariff projection; client2 owns actual native client consumption; source6 owns
snapshot serialization and end-to-end acceptance. None is replaced by these
helper tests. No live inference, credential discovery, deployment or provisioning
is part of this slice.
