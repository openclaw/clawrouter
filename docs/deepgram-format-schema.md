# Deepgram prerecorded format qualification

The central schema/compiler recognize `deepgram.prerecorded` as a closed native
request/response format pair. It describes raw audio POST `/v1/listen`, complete
native JSON output, provider `deepgram` at `https://api.deepgram.com`, Token
Authorization and the exact `nova-3` transcription model. It is not an OpenAI
multipart, JSON URL, callback, streaming or WebSocket compatibility claim.

Static endpoint query/header injection, model passthrough, alternate methods,
credential transports and token/request price cards are rejected. The runtime
owns native MIME and the incoming `URLSearchParams`, including repeated options;
manifest query maps must not flatten or override them. Unknown Deepgram formats
need a separately qualified contract rather than an arbitrary format string.

The concrete adapter contract is published in
[PR462](https://github.com/openclaw/clawrouter/pull/462), source
`646a9efa001a5395171ba87eed336982318dbbb2`:

- `prepareDeepgramPrerecorded(body: Uint8Array, contentType: string, input: URLSearchParams)`
- `observeDeepgramPrerecorded(value: unknown, complete: boolean)`
- Wire fixture: `providers/_fixtures/deepgram/prerecorded.json`.

The 25,000,000-byte envelope bounds router memory. It does not bound duration or
whole-upload dollars. Duration/channels remain diagnostics, never tokens. No
upstream-dollar tariff is qualified; an explicit policy-fixed fee has a separate
meaning and does not belong in a vendor price card.

This change adds no provider YAML, generated snapshot or discovery entry.
Activation requires the runtime owner's authenticated bounded-upload path,
deadline, query-model policy resolution, fresh admission, original credential,
reservation/dispatch acknowledgment, exact bytes, manual redirects and no replay
of uncertain sends. Complete-response validation must preserve all ordered
tracks. Actual Worker and frozen-client fixtures must exercise that route before
the new provider owner and serial snapshot integrator activate discovery.
