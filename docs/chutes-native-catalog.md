# Chutes native model discovery

Frozen scope: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/chutes/openclaw.plugin.json`, `models.ts`, `pricing-api.ts`,
`provider-catalog.ts` and `index.ts`. Primary checked 2026-11-03.

The official [Agent Hub](https://chutes.ai/agents) explicitly documents public
GET `https://llm.chutes.ai/v1/models`, separate from Bearer-authenticated inference.
The [JanitorAI guide](https://chutes.ai/docs/integrations/janitorai) also states
that the list needs no API key. One bounded anonymous read returned HTTP 200,
`{object:"list",data:[...]}`, 17 rows and all five frozen model identities. The
public-auth conclusion comes from the primary contract, not that response alone.
Public inventory establishes neither a caller's grant nor upstream account access.

## Focused exports

`worker/chutes-model-catalog.ts` exports:

- `CHUTES_MODELS_FORMAT = "chutes.models"` names the native format without
  registering shared dispatch/compiler behavior.
- `chutesCatalogRequest(inferenceBaseUrl, signal): Request` accepts only
  `https://llm.chutes.ai/v1` and its single trailing-slash spelling. It emits
  exactly GET `/v1/models`, `Accept: application/json`, no authorization or
  cookies, forbidden redirects and the original abort signal. Control-plane,
  OAuth, proxy, userinfo, query, fragment and traversal bases are rejected.
- `filterChutesModels(payload, allows): ChutesModelCatalog` requires the strict
  list envelope, unique exact bounded model IDs and model object tags. The
  original caller/grant predicate filters every retained ID. Explicit non-text
  input/output rows are excluded from Chat; missing metadata remains unknown.
  Empty native/authorized lists never restore seeds or replacements.
- `readChutesModels(response, signal, allows): Promise<ChutesModelCatalog>` uses
  the existing complete JSON reader: HTTP 200, JSON MIME, valid UTF-8, no ranges
  or redirected results, declared/actual length, 2 MiB, 4,096 rows, EOF and abort.
  Errors are sanitized. It never retries with another credential or auth mode.

Named metadata preserves native observations only: independent `context_length`,
`max_model_len`, `max_output_length`; input/output modalities; feature/sampling
lists; boolean `confidential_compute`; numeric `pricing.prompt`, `completion`
and `input_cache_read`. Invalid optional fields stay absent. Explicit empty
feature lists, false confidentiality and observed zero prices remain explicit.
Metadata is bounded; routing hints, control-plane chute IDs and unknown fields
are dropped. `-TEE`, `thinking` or another name substring never creates a
reasoning, modality or confidential-compute claim. A flag is not attestation.

The frozen pricing parser calls these numeric rates USD per million; the current
Agent Hub prose calls prices per-token while its table labels them per million.
This codec performs no unit conversion, pricing arithmetic or tariff assignment.
It does not borrow the separate `price` object's USD/TAO fields, invent cache-write
rates or turn absent observations into zero. The frozen client's 128000/4096
limits, zero-cost fallback and `TEE` reasoning heuristic are not copied.

## Finite disposition and next contracts

The five frozen IDs are `deepseek-ai/DeepSeek-V3.2-TEE`,
`moonshotai/Kimi-K2.6-TEE`, `zai-org/GLM-5.2-TEE`, `Qwen/Qwen3.6-27B-TEE` and
`Qwen/Qwen3.5-397B-A17B-TEE`. The last has frozen deprecated/replacedBy metadata;
the current public catalog and its [primary model guide](https://chutes.ai/docs/models/chutes-qwen-qwen3-5-397b-a17b-tee)
still list it. Deprecation is distinct from shutdown or an upstream alias. No
silent rewrite to Qwen3.6 is performed. The existing router seed
`deepseek-ai/DeepSeek-V4-Flash-0731-TEE` is preserved. This codec adds no static
cards or current-generation models and does not infer retirement from absence.

Source3 must publish focused bodyless GET `/models` validation for `chutes.models`.
Source1 must compose this public request and native decoder with its existing
private original-grant model-discovery authorization, deadlines, cancellation,
scan/byte bounds, filtering, stopped-model exclusion and cache ownership. Public
upstream data must not bypass caller authentication or credential revocation.
Keep the strict `openai.models` decoder unchanged. No provider declaration is
activated until these dependencies and actual Worker fixtures qualify.

Source2 retains actual native discovery facts and streaming semantics. The frozen
client disables streaming usage, so future Chat fixtures must test absent usage
without claiming guaranteed terminal counters. API keys and Chutes OAuth are
different original grant kinds. The [OAuth contract](https://chutes.ai/docs/sign-in-with-chutes/overview)
uses account-scoped Authorization Code with PKCE and refresh tokens; deterministic
auth codecs/runtime binding remain separate required work. This leaf neither
logs in nor substitutes an API key, OAuth token or public-list response for consent.

Twenty-eight deterministic cases cover public request isolation, all five IDs,
original-policy filtering, sparse/explicit metadata, numeric observation handling,
strict envelopes, complete bounded reading/cancellation and native Node loading
without the test resolver. Source6 owns eventual snapshot and actual-client proof.
No shared runtime, provider YAML, snapshot, account, host or deployment is changed.
