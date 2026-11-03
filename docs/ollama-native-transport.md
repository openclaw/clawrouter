# Ollama native transport

`worker/provider-ollama.ts` implements the native Chat request and response codec,
bounded NDJSON observation and policy-filterable native model lists. It has no
network or host lifecycle side effects. These exports are the integration contract
for the shared Worker runtime; this module alone does not register a route.

## Runtime integration

- Native `POST /api/chat` uses request/response format `ollama.chat`.
  `prepareOllamaChatRequest(body, selectedUpstreamModel)` preserves native tools,
  thinking and options, and binds the model after policy/grant selection.
- Feed delivered bytes into `createOllamaChatInspector("ndjson")`; use `"json"`
  for a non-streaming JSON response. Forward the original bytes with the existing
  reader's demand and cancellation. Call `result(delivery === "complete")` once
  at completion. Do not also run the generic OpenAI usage extractor.
- Only a native terminal carries cumulative token evidence. Tool chunks, EOF,
  missing counts and observer limits do not imply zero usage or free execution.
  Cache reads are part of input. No tariff is assigned by this codec.
- `GET /api/tags` uses `filterOllamaModels(value, allowedModelPredicate)` after
  selecting an API-key grant. Preserve its native `models` envelope and metadata.
  Shared discovery must supply the same policy/model predicate as inference and
  bypass monetary settlement for this metadata operation.
- Use an explicitly configured native API base, selected credential and model.
  Do not infer a localhost endpoint, strip `/v1` from the compatibility endpoint,
  or reinterpret an Ollama cloud key as a local server credential. The configured
  OpenAI compatibility transport is a separate wire contract.

The shared runtime owner must wire format dispatch, scoped native discovery and
the normal accounting lifecycle before this can be called end-to-end support.
Real Worker proof must cover caller attribution, exact streaming bytes, one
settlement, cancellation, in-stream errors and unknown-price denial before egress.
No model pull, installation, host provisioning, model deletion or live proof is
included here.

## Sources and verification

Contract checked on 2026-11-03 against Ollama's primary
[Chat reference](https://docs.ollama.com/api/chat),
[streaming reference](https://docs.ollama.com/api/streaming) and
[model list reference](https://docs.ollama.com/api/tags).
Run `node --test worker/test/provider-ollama.test.mjs` for deterministic request,
tool/reasoning, byte-boundary, usage, malformed/oversized and discovery fixtures.
