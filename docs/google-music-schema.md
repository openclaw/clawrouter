# Google unary music declaration

This finite compiler contract consumes the actual Lyria codec and wrapper from
[PR665](https://github.com/openclaw/clawrouter/pull/665), source
`81cd93565e7af811201d7bee06b021c700415d28`, landed as
`7ad413d8b93cb93d6b7d8c48cf415a400c4fb38e`. It registers no provider or model offer.
The wire and response bounds remain in [the wrapper contract](google-music-contract.md).

## Exact declaration

- Provider: `google-gemini`, only `https://generativelanguage.googleapis.com`.
- Original required API key: `x-goog-api-key`, `secretKind: api_key`; no alternate
  grants, origin parameters, injected headers/query or request-field renaming.
- Capability: `audio.generate`, one endpoint with methods `[POST]`.
- Endpoint: POST `/v1beta/models/${model}:generateContent`, path parameters
  `[model]`, optional segment style only; native proxy enabled.
- Request format `google.music_generate`, response format `google.music`.
- No query, streaming, lifecycle, model passthrough, output-token override,
  endpoint auth override, caller-controlled headers or borrowed request/tool tariff.
- Model IDs: `google/lyria-3-clip-preview` and `google/lyria-3-pro-preview`, with
  their exact native upstream IDs and only `audio.generate`. A declaration may
  include either qualified model or both; no alias or automatic replacement.
- Prices, pricing references, endpoint prices and request-parameter overrides
  remain absent. Bounded audio and native counters do not establish a tariff.

The compiler reuses the same canonical unary-media transport validation as
Google images, while keeping separate finite formats, model sets and
capabilities. Existing image, generic text and embedding declarations retain
those contracts; their own tests remain in the validation suite.

## Actual consumer boundary

`prepareNativeGoogleMusic(selection)` consumes the compiled endpoint and the
selected native model. `pathParams.model` must match that selected model.
The actual native body contains one user prompt and optional qualified inline
images, with `generationConfig.responseModalities: ["AUDIO", "TEXT"]`.
No prompt, lyrics, instrumental instruction or requested format is rewritten.
Missing MIME, remote/file references, unowned continuation and extra native
configuration remain rejected by the actual wrapper and codec.

The music guard from [PR674](https://github.com/openclaw/clawrouter/pull/674)
keeps admission and settlement unpriced under upstream-dollar hard budgets.
Explicit `policy_fixed` remains separately labeled, including authorized zero.
There is no guessed duration, text-token or image-conditioned music charge.

## Activation dependencies

This change contains schema, compiler and composed fixtures only. It changes no
provider YAML, generated snapshot, shared matcher, dispatch or account state.
Source1 must qualify selected-model/capability-aware routing, original grants,
generic/stream AUDIO bypass closure and frozen accounting facts before native
music activation. The shared GenerateContent path cannot select by YAML order.
A manifest endpoint ID may identify a capability only when the actual offer and
client qualify it; manifest proof is not native routing proof. Ambiguous native
offers must remain unavailable until the explicit contract is qualified.

Source2 owns the actual music consumer, including removal of its automatic
text-only replay. Source6 owns composed Worker/client proof and serialized
snapshot activation. No automatic POST replay, partial output, cancellation,
refund, live availability or playback claim follows from these declarations.

Eight focused fixtures compose the actual compiler, codec, wrapper and cost
admission: exact two-model paths and original credentials, unchanged existing
routes, hard-dollar denial with policy-fixed separation, closed transport/model
expansions, native input boundaries, and separate image/music model eligibility.
