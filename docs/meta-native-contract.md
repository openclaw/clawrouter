# Meta native Responses and frozen model cards

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/meta/openclaw.plugin.json` and `provider-catalog.ts`.
Primary contracts checked 2026-11-03. This source change requires a separately
assigned generated-snapshot slot before bundled activation.

The existing Chat route remains unchanged. Native Responses use
`POST https://api.meta.ai/v1/responses` and the selected Meta `MODEL_API_KEY`
or provider-scoped API-key grant. Neither OpenAI credentials nor Muse Code
subscription credentials are substituted. The native route is
`/v1/native/meta/responses`; the manifest route is `/v1/proxy/meta/responses`.
No Chat-to-Responses conversion occurs.

## Finite model disposition

The [current primary model inventory](https://dev.meta.ai/docs/models) still
lists all six frozen IDs. Each is a separate unpriced card eligible for Chat
and Responses. The default seed remains `muse-spark-1.3`.

| Frozen ID | Current documented product |
| --- | --- |
| `muse-wonder-1.0` | Standard Model API; account and geographic availability apply |
| `muse-spark-1.3` | Standard Model API |
| `muse-spark-1.3-contributor` | Explicit Contributor mode |
| `muse-spark-1.2` | Standard Model API |
| `muse-spark-1.2-contributor` | Explicit Contributor mode |
| `muse-spark-1.1` | Standard Model API |

Contributor mode has different data-use terms. The router never rewrites a
Standard ID to a Contributor ID or aliases the two. Muse Wonder Full is not a
Model API model and is not added. Newer media and open-weight model families
are outside this finite continuation.

The native facts record the documented 1,048,576-token context window and
text/image input for Responses. Output ceilings and token prices remain
unknown. The frozen OpenClaw cost fields are not a vendor billing contract.
Hard budgets require explicit policy-fixed pricing for these unpriced models.

## Replay, streaming and original-response controls

The [Responses contract](https://dev.meta.ai/docs/protocols/responses) preserves
typed input, encrypted reasoning, function calls/results and assistant phase.
Stateless replay uses `store: false` and `include: ["reasoning.encrypted_content"]`.
The router forwards these fields unchanged. It does not synthesize visible
reasoning, remove encrypted items or silently convert reasoning efforts.

SSE terminal completion supplies token usage, including cache and reasoning
details. A terminal `response.failed` is an error even under HTTP 200. A
transport disconnect does not prove execution stopped: Meta documents continued
processing for stored streams. Missing usage remains unknown.

`responsesLifecycle` links retrieval and cancellation to the original create.
`GET /v1/responses/{response_id}` and
`POST /v1/responses/{response_id}/cancel` use the original router owner and
selected credential. An arbitrary upstream ID cannot authorize a control.
Cancellation can return a completed response; it does not imply a refund.
Deletion and uploaded-file ownership are not activated by these links.

## Discovery and integration handoff

Credential-scoped `GET /v1/models` and `GET /v1/models/{model_id}` use the same
selected Meta key. No foreground discovery request is added to inference.
The current schema already represents both endpoints as `openai.models`.
The shared runtime must validate and filter that format by endpoint format,
including retaining `{object: "list", data}`, rather than requiring provider ID
`openai`. The focused Worker fixture exposes that existing dependency.

The source fixtures compile this manifest and inject it into the real Worker
with SQLite-backed authority/budgets and sanitized upstream responses. They
cover native/manifest unary and SSE transport, replay, errors, cancellation,
admission, fixed-charge settlement and discovery. Exact CI results, snapshot
activation, actual OpenClaw client acceptance and live entitlement are distinct
proof stages; declarations alone do not complete them.
