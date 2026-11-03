# Gradium native unary declaration

This schema-only contract consumes
[PR454](https://github.com/openclaw/clawrouter/pull/454), source head
`1b3aeac7e94fbcd4a82b12481063b6a8b82a3cc6`, and the shared runtime owner's
`prepareNativeGradiumSpeech(ProxySelection): NativeResponse | undefined` proposal.
It does not activate a provider, wrapper, snapshot or actual client route.

## Exact fields

The provider is `gradium`, class `rest_json`, with canonical origin
`https://api.gradium.ai` and one `api_key` scheme: `header: x-api-key`,
`secretKind: api_key`. The selected original server credential supplies that
header. The declaration cannot replace the origin, credential, query or native
settings with grant transports, adapter injection, header passthrough or field
renaming.

```yaml
capabilities:
  - id: audio.speech
    endpoint: speech
    methods: [POST]
endpoints:
  speech:
    path: /api/post/speech/tts
    requestFormat: gradium.speech
    responseFormat: audio.binary
    timeoutMs: 120000
```

`method` defaults to POST; explicitly declaring POST is also valid. The endpoint
has no path parameters, query, stream, WebSocket, lifecycle, model passthrough,
tariff or token limit. The compiler emits `request_format: gradium.speech` and
`response_format: audio.binary`. No OpenAI format alias is introduced.

This is a model-less provider selection. `model_name` and `voice_id` stay native
settings inside the JSON body, not registered model policy identities. Model
cards and model namespaces are rejected. The existing selection path preserves
these settings and encoded `json_config` without rewriting text or voices.

The [REST guide](https://docs.gradium.ai/guides/text-to-speech-rest) and
[request reference](https://docs.gradium.ai/api-reference/endpoint/tts-post),
checked 2026-11-03 UTC, qualify the route, header and `only_audio:true` binary
mode. The published source contract covers WAV, Opus and ulaw_8000. Schema
validation does not inspect per-request audio settings; the source-owned
`validateGradiumSpeech` must reject JSON-stream modes before dispatch.

## Ownership and proof boundary

Source 11.5 retains the new provider declaration, codec, registry and proposed
`worker/native-gradium-speech.ts` wrapper, with its focused runtime tests. Source
11.1 retains dispatch, authentication, original credential selection, shared
capacity, budgets and settlement. Source 11.2 owns actual catalog-scoped TTS/Talk
consumption. Source 11.6 serializes generated snapshot integration.

The wrapper must validate the selected native format and original canonical
origin, reserve shared binary capacity before egress, and qualify matching MIME
and complete bounded bytes before returning success. Its successful usage has
`tokens: null`; incomplete delivery remains uncertain. Transport timeout, byte
count and native voice/model settings do not prove duration or dollar cost.

There is no qualified universal dollar tariff. The existing budget path rejects
unknown native cost under hard upstream-dollar budgets; explicit `policy_fixed`
remains separately labeled. Credit-per-character documentation is not converted
to tokens or invented money. No live synthesis, login or account changes are
needed for these deterministic checks.

Six schema/selection/accounting cases qualify the declaration boundary. They do
not replace the source-owned binary wrapper or actual-client acceptance tests.
Provider discovery and snapshots must await that runtime and real proof.
