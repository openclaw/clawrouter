# Grant-scoped native model discovery

Contract checked against official API reference and generated TypeScript SDKs, 2026-10-21. This lane is read-only metadata; fine-tuned model DELETE is deliberately unsupported.

## Namespace decision

| Surface | Meaning |
| --- | --- |
| GET /v1/models | Existing router aggregate, policy-projected inference catalog. Unchanged; not a live provider inventory. Existing anthropic-version aggregate representation is unchanged. |
| GET /v1/native/openai/v1/models | Selected OpenAI API-key grant's upstream list. |
| GET /v1/native/openai/v1/models/{model_id} | Selected OpenAI API-key grant's upstream model metadata. |
| GET /v1/native/anthropic/v1/models | Selected Anthropic API-key grant's upstream paginated list. |
| GET /v1/native/anthropic/v1/models/{model_id} | Selected Anthropic API-key grant's upstream metadata / alias resolution. |
| GET /v1/models/{provider}/{upstream_id} | Unambiguous provider-qualified retrieve only (openai or anthropic); the entire qualified ID can also be URL-encoded. No unqualified upstream-ID guessing. |
| /v1/proxy/{provider}/models_list or models_retrieve | Manifest equivalents. Direct GET uses model_id query for retrieve. POST manifest envelopes select method GET and pathParams.model_id; body must be absent/empty. |

**List/retrieve asymmetry:** `/v1/models` is the local router inference catalog, but `/v1/models/{provider}/{upstream_id}` is a live upstream metadata request, not a catalog lookup. A listed router ID such as `openai/gpt-6-astra` retrieves an upstream object whose ID is `gpt-6-astra`. Subscription-only or environment-only deployments can list the local catalog but receive `503 upstream_grant_pool_unavailable` on metadata retrieval. Use the native SDK base URLs below when list and retrieve must share the same upstream namespace.

Opaque upstream IDs are encoded as one path segment, including slash, question mark and percent. Native/manifest requests use upstream IDs, not router-prefixed IDs. Provider-qualified retrieve removes exactly its explicit provider prefix. A discovered private/custom model is not added to the aggregate or assigned an inference tariff.

SDK baseURL examples: OpenAI: https://ROUTER/v1/native/openai/v1 (SDK appends /models); Anthropic: https://ROUTER/v1/native/anthropic (SDK appends /v1/models). Use the router key as client credential, never the upstream grant secret.

## Contract and upstream cost evidence

- OpenAI [list](https://developers.openai.com/api/reference/resources/models/methods/list), [retrieve](https://developers.openai.com/api/reference/resources/models/methods/retrieve), [OpenAPI-generated SDK](https://github.com/openai/openai-node/blob/master/src/resources/models.ts): GET, list object/data or a model object with native IDs, ownership and creation metadata. No current list pagination. DELETE is a separate owner-authorized fine-tune operation, not enabled here.
- Anthropic [list](https://platform.claude.com/docs/en/api/models/list), [retrieve](https://platform.claude.com/docs/en/api/models/retrieve), [SDK](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/models.ts): GET list with first_id/last_id/has_more; newer models first; after_id or before_id; limit 1–1000 (upstream default 20); lifecycle active/deprecated/retired (up to three). The [SDK serializer](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/internal/utils/query.ts) uses bracket arrays, so repeated lifecycle[] is forwarded; manifest query lifecycle arrays are normalized to that form. Version, beta and workspace-selection headers are preserved through the provider's existing allowlist plus the workspace header declaration.
- These methods return metadata, not generated tokens. Neither [OpenAI published pricing](https://developers.openai.com/api/docs/pricing) nor [Anthropic published pricing](https://platform.claude.com/docs/en/about-claude/pricing) lists a model-discovery tariff. **Router treatment:** zero monetary reservation/settlement, even under a fixed request-price policy and on upstream/malformed/transport failures. This is an inference from the published metadata contract and absence of a tariff, not a provider guarantee of unlimited free requests or exemption from rate limits. No paid/live provider calls were made.

## Authority and privacy

- Stored, scoped kind=api_key grants only. Environment-only credentials, subscription and OAuth transports are not qualified for this lane. Revocation cannot silently fall back to an environment inventory. Admission and materialized-credential checks share this restriction with catalog/offers.
- Router authentication, fresh policy/credential revocation, provider enablement, model allowlists, grant selection/runtime cooldown and existing hard-zero budget denial remain authoritative. Soft-budget policies use the zero-cost hard reservation path rather than a billable soft charge. Normal nonzero budgets reserve/settle zero; explicitly disabled budget limits still deny.
- After credential preparation, a request uses one grant, with no response-driven model-discovery failover to a second account. Preparation may select an alternate before egress when a credential cannot be materialized. Any internal pagination uses the same selected credential. No cross-account inventory merge or response cache.
- Separate client page requests are not pinned to a grant: round-robin and similar pool strategies can select different accounts for consecutive requests. Internal scans stay pinned only for the lifetime of one request; there is no cross-request discovery session stickiness.
- Discovery responses, including 401/403/429 and internal pagination responses, do not update shared grant runtime health or cooldowns. Metadata endpoint permissions/rate limits can differ from inference. Upstream status and Retry-After still reach the caller (restricted policies keep generic errors). Existing inference cooldowns continue to block discovery.
- When policy.models is present, both requested and resolved retrieve IDs must be allowlisted as router-qualified IDs. An Anthropic alias resolving to a non-allowlisted snapshot fails closed; permit both IDs when alias resolution is desired.
- Lists retain native metadata only for permitted IDs. Denied model rows and first/last cursors are removed. An all-hidden Anthropic page is advanced internally until a visible or terminal page, never returning a hidden cursor. Visible pages may contain fewer than limit entries. The upstream has_more Boolean remains a continuation hint, not a promise of another visible model. Denied user-supplied cursors fail before egress. Restricted provider errors are generic rather than echoing private model IDs.
- Success JSON is re-encoded, private/no-store, without stale length/encoding/ETag/Last-Modified/Location headers. JSON parsing is bounded to 2 MiB per page, 32 pages per request and the endpoint's 30-second operation deadline; malformed/cyclic/exhausted scans fail closed with 502. Native fields of allowed models remain extensible. Redirects are not followed with grant credentials.

## Verification

worker/test/model-discovery-runtime.test.mjs exercises the actual Worker in workerd against a synthetic upstream service and SQLite authority/grant owners. It captures upstream URL/method/headers/body and final usage events, not implementation source strings. Coverage includes both namespace families, qualified retrieve, aliases, allowlisted rows/cursors, forward/reverse/hidden/cyclic/bounded pagination, malformed/oversize payloads, auth/provider/credential/grant denial, unsupported DELETE/transports, opaque identifiers, zero hard/soft/fixed-price settlement, upstream error/429, discovery rejection isolation from inference health, and existing inference cooldown enforcement. Aggregate/catalog isolation is asserted without upstream egress.

No deployment. Account-specific provider availability, provider tariff changes and production integration remain unproven by synthetic tests.
