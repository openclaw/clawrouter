# Responses input-token counting

## Routes and wire contract

POST these equivalent routes with a normal ClawRouter bearer key:

- `/v1/responses/input_tokens` — normal qualified model, e.g. `openai/gpt-6-astra`.
- `/v1/native/openai/v1/responses/input_tokens` — native OpenAI model, e.g. `gpt-6-astra`.
- `/v1/proxy/openai/responses_input_tokens` — manifest envelope `{ "body": { "model": "openai/gpt-6-astra", "input": "Hello" } }`.

The router forwards one unary POST to `https://api.openai.com/v1/responses/input_tokens`. It preserves the upstream status, response bytes and supported response headers, including `Retry-After`. Native success is `{ "object": "response.input_tokens", "input_tokens": 123 }`; the count includes model-specific request structure and is not a generation-usage receipt. There is no streaming/background mode. `X-Client-Request-Id` is forwarded through the manifest allowlist on all three routes; absent IDs are not synthesized. Router-owned refusals use the native OpenAI error envelope plus `x-clawrouter-error-code` diagnostics.

OpenAI SDK/OpenAPI permit an omitted model. ClawRouter deliberately requires a registered Responses model to enforce key model scopes and select a supported provider offer. This is a routing/policy requirement, not a claim that generation pricing applies to a count. The router does not infer a model from a single eligible grant: one API-key grant can serve several models, and choosing a locally eligible model would silently replace OpenAI’s unspecified default/tokenization behavior. Even a single policy-eligible model does not establish that native default. Callers must name the model whose request they intend to count; omitted/null models are rejected before egress. All registered OpenAI Responses models advertise `llm.count_tokens`; unrelated audio/image/embedding-only models do not. The catalog advertises unary unified/native routes with exact-covered local affordability. The manifest route is also available.

## Authentication and controls

Only API-key grants (including a configured environment API key) are eligible. OAuth/subscription/Codex-account credentials are not assumed compatible with this API. Key verification, revocation, model/provider policy, connection enablement, grant-pool availability/cooldown and upstream rate-limit responses still apply. No token count is computed locally or used to bypass admission.

## Stateless scope, not full account-object parity

Counts may use a different API-key account on each request. This endpoint does not create or resolve response/object custody. All routes reject unsupported stateful/opaque selectors *before upstream egress* with HTTP 400 `input_tokens_stateless_required`. Resend the full self-contained input instead. Rejections include:

- Non-null `previous_response_id` or `conversation` (string or object). Null is allowed.
- Stored prompts, item IDs/references, uploaded `file_id`, encrypted reasoning/compaction items, file/container citations.
- Hosted tools/tool choices and other account-bound tool state, including vector stores and containers.
- Turn-state headers, URL/envelope query parameters, unknown structural fields or input-item types.

Supported self-contained input: strings; inline message text; image URLs/data URLs; inline file data/file URLs; function/custom calls and inline outputs; function/custom tools and one-level namespaces; ordinary reasoning/text-format options. User text, tool argument strings, JSON schemas and custom-tool grammars remain opaque user data: property names such as `id` or `file_id` inside a schema are not mistaken for selectors. Unsupported hosted tools are rejected conservatively even when a particular configuration could be stateless. This is a documented compatibility restriction, not a claim of complete native parity.

## Free local settlement — owner-approved tariff

ClawRouter records a single zero-cost receipt for an admitted count; it neither reserves budget nor applies model-generation prices or the policy fixed per-request tariff. This applies in reserve, soft and unmetered modes, including upstream rejection, fetch failure, timeout, abort, cancellation and malformed upstream bodies. The native `input_tokens` count is not recorded as billable generated input usage. Pricing reference/effective date are null.

**Tariff decided: free, $0 local settlement, approved by Jason on 2026-10-22.** This explicit owner decision clears the router tariff gate; the endpoint is not charged generation prices or fixed policy fees. The earlier source review did not establish OpenAI invoice treatment, and this local tariff decision is not independent evidence about an upstream invoice. No paid/live provider call was used to test this.

## Primary sources checked

- [Official token-counting guide](https://developers.openai.com/api/docs/guides/token-counting).
- [Official generated Node SDK contract](https://github.com/openai/openai-node/blob/master/src/resources/responses/input-tokens.ts): `responses.inputTokens.count`, bearer-auth POST, request fields and typed count result.
- [Official generated Python parameters](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/input_token_count_params.py).
- [Official OpenAPI](https://github.com/openai/openai-openapi/blob/master/openapi.yaml): `/responses/input_tokens`, `TokenCountsBody`, `TokenCountsResource`, 200/400/429 responses.
- [Official pricing](https://developers.openai.com/api/docs/pricing): general model-token pricing is not explicit confirmation of this endpoint’s tariff.
- [Official changelog](https://developers.openai.com/api/docs/changelog) and [Node SDK README](https://github.com/openai/openai-node/blob/master/README.md) were also rechecked on October 21, 2026; neither supplied an explicit billed/free statement for this endpoint. The API reference, token-counting guide, pricing page and generated Node resource were rechecked in the same pass; that historical upstream-source uncertainty does not override Jason’s 2026-10-22 decision to make the local tariff free.

Tests exercise all three routes through the Worker, plus synthetic upstream wire/SQLite settlement through real workerd. No live OpenAI credentials or service deployment are required.
