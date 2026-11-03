# Google native image declaration

This finite contract consumes the actual `prepareNativeGoogleImage(selection)`
wrapper in [PR661](https://github.com/openclaw/clawrouter/pull/661), source
`e2203e7ff4a18b1a2bbf95d8d57c0f9b64113d75`, landed as
`4cb7ba420622183cc2c1fa44961f55d45d2346b9`, and the landed `prepareGoogleImage`
codec. It qualifies only `gemini-3.1-flash-image` and `gemini-3-pro-image` from
OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`. It does not activate YAML,
generated discovery, shared routing or live image calls.

## Exact declaration

Provider `google-gemini` uses only `https://generativelanguage.googleapis.com`
with its original required `x-goog-api-key` API-key scheme. The endpoint is:

```yaml
image_generate:
  method: POST
  path: /v1beta/models/${model}:generateContent
  pathParams: [model]
  requestFormat: google.image_generate
  responseFormat: google.image
  timeoutMs: 600000
```

Associate exactly one `image.generate` capability with methods `[POST]`.
Native proxy remains enabled. Model rows use exact IDs
`google/gemini-3.1-flash-image` and `google/gemini-3-pro-image`, their unchanged
upstream IDs and only `image.generate`. No alias, text/token/image price card,
endpoint tariff, model passthrough or request-parameter rewrite qualifies.
No alternate origin, grant transport, dispatch path, query, caller header,
credential override, stream, lifecycle or WebSocket is admitted by this contract.
Optional fixed JSON accept/content-type headers and the existing segment model
path style remain compatible with the actual wrapper.

The wrapper requires `pathParams.model === selected model.upstream`; compiled
schema does not establish ownership of a caller-selected path. Both this endpoint
and ordinary GenerateContent use the same public path. Source1 owns capability-
and selected-model-aware matching plus ambiguity rejection. YAML ordering is
**not** a routing contract, and this compiler never reorders routes as a workaround.
The shared image classifier in [PR662](https://github.com/openclaw/clawrouter/pull/662)
handles generic GenerateContent/stream intent; it is not a replacement for the
actual qualified image wrapper or model matcher.

## Bounds, costs and evidence

The wrapper enforces 8 MiB request/response JSON, at most four images sharing
4 MiB decoded output, explicit PNG/JPEG/WebP MIME with matching bounded signatures,
complete HTTP200 UTF-8 EOF and terminal valid siblings. It uses the existing
64 MiB response reservation. Missing MIME, remote assets, file ownership,
continuation tokens and partial output remain outside this declaration.
See [the actual wrapper contract](google-image-contract.md) for delivery details;
schema tests are not complete Worker or actual-client delivery proof.

The landed [PR660](https://github.com/openclaw/clawrouter/pull/660) guard keeps
upstream-dollar hard budgets closed and explicit `policy_fixed` separate.
Preserved native counters are not a text-token invoice, image tariff, refund or
free-generation receipt. This contract does not derive rates from image sizes,
byte bounds, output count or another provider's card.

Current unlocalized primary [image documentation](https://ai.google.dev/gemini-api/docs/image-generation)
and [deprecation schedule](https://ai.google.dev/gemini-api/docs/deprecations),
checked 2026-11-03, list both frozen non-preview identities without an announced
shutdown. Their preview IDs are separate retired identities and are rejected.
Current examples prefer Interactions; they do not prove live GenerateContent
compatibility. This slice preserves the actual frozen codec/wrapper wire and
makes no newer-model alias or live backwards-compatibility claim.

Seven focused cases compose compiler output with actual codec/wrapper selection,
matched model paths, conservative admission, unchanged existing routes, rejected
origins/formats/prices and strict request preparation. Source1 owns common matching,
auth, classification, dispatch and accounting; source5 owns the wrapper; source2
owns actual-client image consumption; source6 owns serialized snapshot and composed
Worker proof. Existing Google YAML remains source3-owned and unactivated until
those runtime prerequisites qualify.
