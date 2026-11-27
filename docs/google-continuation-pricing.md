# Google continuation input bounds

A native GenerateContent continuation can restore generated context that is
absent from the repeated original prompt. Pricing the request from its JSON
bytes can therefore admit a hop whose actual input cost exceeds its reservation.

The existing exported `estimateModelCost` / `estimateCost` path now recognizes
only the native top-level `continuationToken` / `continuation_token` field on
`google.generate_content`. It reserves the declared request input ceiling, or
the model input ceiling when no request override exists. Missing or invalid
ceilings remain unpriced. The existing ProtoJSON last-field-wins rule applies;
nested text, function declarations and other wire formats do not trigger this
classification. Output limits, hosted-tool guards and explicit policy-fixed
charges retain their existing behavior.

Primary evidence checked 2026-11-03:

- [GenerateContentRequest](https://ai.google.dev/api/batch-api#GenerateContentRequest)
  defines the opaque continuation field and requires the original contents.
- [Google's SDK](https://github.com/googleapis/js-genai/blob/b24cfc2212905946f74c86de78c0e13117a23b20/src/models.ts)
  issues separate GenerateContent HTTP requests and merges their responses.
- [Long decode](https://ai.google.dev/gemini-api/docs/generate-content/long-decode)
  describes the shared input/thinking/output window and per-hop continuation.

The exact native wire is POST `models/{model}:generateContent` or
`models/{model}:streamGenerateContent` under the existing `/v1beta` prefix.
The request's top-level base64 `continuationToken` is opaque. `contents` must
repeat the initial prompt and conversation history. A candidate may return
`finishReason: CONTINUATION` with `candidates[].continuationToken`; token usage
remains in that HTTP response's `usageMetadata`, including thinking tokens.
The [pinned SDK types and converters](https://github.com/googleapis/js-genai/blob/b24cfc2212905946f74c86de78c0e13117a23b20/src/converters/_models_converters.ts)
map SDK `config.continuationToken` to the top-level REST field. SDK automatic
continuation is a client action, not a router background task.

The frozen E01 identity `gemini-4-argon` documents a **1,048,576-token unified
input, thinking and output window** and a 65,536-token default synchronous
output ceiling, with larger output requiring long decode. This is the current
[primary model bound](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon),
not a promise of that many input tokens plus an independent million outputs.
A full input-window reservation is conservative for one restored hop; it does
not price all client continuations. Argon card/pricing activation remains
blocked until the runtime and actual client qualify original request/session,
caller/grant, model, credential and replay ownership. This change adds no Argon
offer or tariff.

This is a reservation fix, not a new continuation executor. Each observed HTTP
hop is admitted and settled separately; the router neither follows tokens nor
replays uncertain requests. A response token is passed through unchanged and
is never decoded, logged or treated as job ownership. Full-context reservation
does not certify original-session binding, client replay behavior, hosted tool
fees or an entire multi-hop dollar budget.

Runtime/client owners retain original caller, route, model and credential
binding and continuation/replay qualification. No new helper ABI is needed:
the estimator's existing return shape is unchanged. No model, manifest or
snapshot is activated by this slice. Fixtures use the existing priced model to
exercise accounting and do not claim that model accepts live long decode.
