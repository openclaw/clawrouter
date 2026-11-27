# Arcee direct model discovery

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/arcee/models.ts`, `provider-catalog.ts`, `index.ts` and `onboard.ts`.
Primary qualification: 2026-11-03. The [Models API](https://docs.arcee.ai/api-reference/models)
specifies GET `/api/v1/models` and a native `{data:[...]}` envelope. Its rows
include modalities, context/output limits, supported features/sampling parameters
and independent price strings. The [first-call guide](https://docs.arcee.ai/api-reference/your-first-api-call)
uses the same `https://api.arcee.ai/api/v1` service with a direct Arcee Bearer key.

The newer [Chat reference](https://docs.arcee.ai/api-reference/chat-completion)
uses `/v1/chat/completions`, while the first-call guide and frozen configuration
use `/api/v1/chat/completions`. This codec keeps the documented frozen catalog
route. It does not silently migrate inference paths or treat the two spellings
as interchangeable. A bounded anonymous catalog read returned HTTP 403; no body
was read, no credential was sent and no authentication fallback was attempted.
That result establishes neither retirement nor account access.

## Published exports

`worker/arcee-model-catalog.ts` exports:

- `ARCEE_MODELS_FORMAT = "arcee.models"` names the focused native format. It does
  not register the format in shared runtime or compiler code.
- `arceeCatalogRequest(inferenceBaseUrl, selectedApiKey, signal): Request` builds
  exactly GET `https://api.arcee.ai/api/v1/models` with the original selected
  direct credential. Only the canonical base and its trailing-slash spelling are
  accepted. OpenRouter, proxies, alternate paths/ports, traversal, userinfo,
  queries, fragments and invalid header values are rejected. Redirects are
  forbidden, browser credentials omitted and the supplied abort signal retained.
- `filterArceeModels(payload, allows): ArceeModelCatalog` validates the bounded
  data-only list, optional valid object tags and unique exact IDs. Documented
  native modalities and positive safe integer limits must be present. Non-model
  rows and rows without text input/output are excluded from Chat. The original
  caller/grant predicate filters every eligible identity; no static seed is
  restored after an empty authorized list.
- `readArceeModels(response, signal, allows): Promise<ArceeModelCatalog>` uses the
  existing complete JSON reader with HTTP 200, JSON MIME, UTF-8, length, range,
  redirect, 2 MiB, 4,096-row and abort checks. Unsupported root/error/pagination
  envelopes fail rather than publishing an ambiguous partial or empty result.

Only named metadata is returned. Missing optional feature/sampling/price fields
remain absent; explicit empty lists and observed decimal zero strings remain
explicit. The six native pricing fields stay separate: `prompt`, `completion`,
`image`, `request`, `input_cache_reads`, `input_cache_writes`. No floating-point
conversion, tariff, fee arithmetic or zero-cost default is produced. Native
context and output observations remain independent; no serving maximum or
account entitlement is inferred. Unknown fields, destinations, credential
material and `openrouter.slug` routing hints are not copied into the result.

## Finite model and product disposition

The frozen direct catalog has exactly `trinity-mini`, `trinity-large-preview`
and `trinity-large-thinking`. The separate frozen OpenRouter preset includes
only `arcee-ai/trinity-large-preview` and `arcee-ai/trinity-large-thinking`, under
OpenRouter's endpoint and credential. It does not include Mini. Neither product
borrows the other's key, model namespace, price or account eligibility.

The current [Trinity page](https://www.arcee.ai/trinity) distinguishes open-weight
context from the Preview/Thinking hosted API context. The current
[pricing page](https://docs.arcee.ai/get-started/pricing) does not list these three
identities. That absence does not prove retirement, and historical frozen rates
must not become current tariffs. The existing Mini seed is preserved; no live
retirement, replacement alias, enforced limit or zero-price assertion is added.
The [reasoning guide](https://docs.arcee.ai/capabilities/reasoning-traces) also
separates direct `reasoning_content` replay from OpenRouter `reasoning_details`.
Actual inference/card qualification remains a separate source slice.

## Integration handoff

Source3 must publish bodyless GET `/models` request/response validation for
`arcee.models`; source1 must consume `filterArceeModels` in its existing bounded
model discovery path, retaining original grant/credential selection, deadline,
revocation, filtering and stopped-model eligibility. The fixed base already
contains `/api/v1`; no `upstreamPath` mapping is needed. Keep the strict
`openai.models` decoder unchanged. No provider declaration activates this format
until both shared dependencies are available and actual Worker fixtures pass.

Source2 owns actual direct/OpenRouter client selection and native replay. Source3
retains the existing OpenRouter manifest and its two frozen Arcee model
identities; this direct codec does not add an alias provider or mix accounts.
Source6 owns eventual serialized snapshot and actual client/Worker acceptance.
Twenty-four deterministic cases cover the native catalog contract and native
Node loading without the test resolver. They do not prove live account access
or activate discovery. No shared file, YAML, snapshot, host, account, login or
deployment is changed here.
