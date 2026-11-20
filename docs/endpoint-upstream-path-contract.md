# Literal endpoint dispatch paths

The single declaration is optional YAML `endpoints.<id>.upstreamPath`, compiled
unchanged as `CompiledEndpoint.upstreamPath?: string`. There is no snake-case
alias. Existing `path` remains the caller route, native routing and authorization
identity. Only upstream dispatch uses the mapping; it does not change the method,
request/response format, selected model, policy, origin or credential.

```yaml
chat_completions:
  path: /v1/chat/completions
  upstreamPath: /openai/v1/chat/completions
  requestFormat: openai.chat_completions
  responseFormat: openai.chat_completions
  streaming: sse
```

The first qualified surface is POST Chat (`openai.chat_completions`), POST
Messages (`anthropic.messages`) and GET model listing (`openai.models` or
`anthropic.models`). Both
formats must match. Model listing is bodyless and cannot stream or pass through
inference models. A mapping cannot override a managed lifecycle, WebSocket,
qualified request tariff or hosted-tool tariff. Other native codecs need their
own path qualification before accepting this field.

Both paths must be canonical literal paths, at most 2,048 characters: a leading
slash, nonempty ASCII segments, and no URL, query, fragment, template, path
parameter, percent encoding, backslash, dot segment or trailing slash. Configured
endpoint query parameters keep their existing meaning; they cannot select or
rewrite this field. Caller input never supplies an upstream path or origin.

If a grant transport also declares `endpointPaths[id]`, it must equal
`upstreamPath`; a conflicting value is rejected. The selected original grant and
approved origin remain authoritative. This field neither grants cross-origin
access nor authorizes a different account/product credential. The runtime must
validate the same literal-path constraints before dispatching compiled or stored
metadata, preserving selected origin/API-prefix restrictions and deadlines.

## Synthetic handoff

The [Synthetic API overview](https://dev.synthetic.new/docs/api/overview), checked
2026-11-03, documents the following routes under `https://api.synthetic.new` and
the same `SYNTHETIC_API_KEY`:

| Caller path | Dispatch path | Format |
| --- | --- | --- |
| `/chat/completions` | `/openai/v1/chat/completions` | `openai.chat_completions` |
| `/v1/messages` | `/anthropic/v1/messages` | `anthropic.messages` |
| `/models` | `/openai/v1/models` | `synthetic.models` (separate required follow-through) |

Synthetic returns a data-only model envelope. It is not `openai.models` or
`anthropic.models`. The landed `filterSyntheticModels(payload, allows)` codec in
`worker/synthetic-model-catalog.ts` needs explicit native-format validation and
shared metadata dispatch before this third route can activate. Keep OpenAI's
strict decoder unchanged. A successful anonymous metadata read does not establish
public authentication or selected-account access semantics.

Declare the origin without the old `/openai/v1` base suffix when using these full
dispatch paths. Do not combine prefixes twice, resolve against an arbitrary
caller URL, follow credential-bearing redirects or silently translate Chat into
Messages. Caller-route authorization and original grant revalidation happen
before dispatch. Discovery still filters exact caller-permitted model identities.

This compiler slice preserves routes/auth and rejects invalid declarations. It
does not implement shared path dispatch, change a provider YAML, or regenerate
the snapshot. Shared types/runtime and real route tests must land before the
provider owner activates these declarations. Static compiler tests do not prove
native Chat/Messages/discovery parity or qualify unknown inference prices.

## Responses create continuation

The compiler also qualifies `openai.responses` on both sides of literal
`POST /v1/responses`. It preserves the existing request body, SSE setting,
selected model and original credential. GET retrieval, cancellation, WebSocket
Responses, endpoint queries, lifecycle links, templates, path parameters and
request/tool tariffs remain outside this mapping contract.

The frozen OpenCode product paths supplied by the provider owner are
`/inference/go/openai/v1/responses` for Go and
`/inference/openai/v1/responses` for Console, under `https://opencode.ai`.
The declaration uses the same camelCase `upstreamPath`; the caller route stays
`/v1/responses`. This does not grant access across the two account products,
alter their selected credentials, rewrite model identities or admit a custom
origin. A grant-transport path must still agree exactly with the declared path.

The common runtime's `worker/endpoint-path.ts` must independently qualify the
same finite Responses contract before provider activation. Compiler publication
alone cannot open a dispatch path rejected by that guard. Provider YAML belongs
to source4; this continuation does not change it or generated snapshots.
