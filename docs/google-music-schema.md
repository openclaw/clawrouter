# Google unary music declaration

This finite compiler contract consumes the actual Lyria codec and wrapper from
[PR665](https://github.com/openclaw/clawrouter/pull/665), source
`81cd93565e7af811201d7bee06b021c700415d28`, landed as
`7ad413d8b93cb93d6b7d8c48cf415a400c4fb38e`.
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

## Bundled declaration and activation dependencies

The existing Google YAML declares the two exact music-only rows and native
endpoint after the runtime in [PR686](https://github.com/openclaw/clawrouter/pull/686),
landed as `05187ff5e1d45d8e62256216f723afaa7b40d67f`. It consumes the landed
selected-model matcher, original-grant dispatch, AUDIO bypass closure and frozen
accounting facts. No shared runtime or generated snapshot is changed by the
declaration. The shared GenerateContent path cannot select by YAML order.
A manifest endpoint ID may identify a capability only when the actual offer and
client qualify it; manifest proof is not native routing proof. Ambiguous native
offers must remain unavailable until the explicit contract is qualified.

Primary [deprecations](https://ai.google.dev/gemini-api/docs/deprecations),
checked 2026-11-04, list both frozen Lyria previews with no announced shutdown.
The current [music guide](https://ai.google.dev/gemini-api/docs/music-generation)
features Lyria 3.5 and Interactions. That is not an implicit alias or permission
to rewrite these frozen GenerateContent identities. No newer model, live call,
token-context fact or tariff is added.

The source-owned runtime fixture correction in
[PR710](https://github.com/openclaw/clawrouter/pull/710), landed as
`f83f2f61aaab351322b8e9512e065470a46f9b67`, replaces only the two exact music
model IDs and capability binding before adding its explicit test values.
All runtime assertions are preserved. This declaration uses that qualified
base without copying or modifying the shared runtime fixture.

Source2 owns the actual music consumer, including removal of its automatic
text-only replay. Source6 owns composed Worker/client proof and serialized
snapshot activation. No automatic POST replay, partial output, cancellation,
refund, live availability or playback claim follows from these declarations.

Eight focused fixtures compose the actual compiler, codec, wrapper and cost
admission: exact two-model paths and original credentials, unchanged existing
routes, hard-dollar denial with policy-fixed separation, closed transport/model
expansions, native input boundaries, and separate image/music model eligibility.

## Serialized integration qualification

Source `ff2715d727f27aea4e00b19b056e4207caf573c8` is composed with authorship on
qualified landed base `655990cdb4c33a148b03425fd6a2c8831c6766ef`. Its 16 YAML
additions and declaration test file are unchanged. Removing those additions
restores the complete base Google declaration, including the landed image,
text and embedding cards. The compiler tests retain the landed image-isolation
setup and every source assertion. Three neighboring negative compiler fixtures
isolate both image and music declarations before testing their own contracts.

All 87 manifests compile and match the generated snapshot. Locally, 86 focused
compiler/codec/wrapper/runtime/pricing cases, 1,061 provider-compiler and
manifest-driven Chat cases, and Worker types pass. The real-workerd encoding
fixture also verifies native and manifest responses: default gzip negotiation
and explicit identity deliver identical complete WAV bytes with one seven-micro
receipt and NULL tokens for each request.

Generated snapshot SHA256:
`6103cc1003eb7d189ba03346c4ae6e36e661d05214276dfc8c3edc6825e97a8d`.
Only the Google provider payload changes.

`test/openclaw-lyria.test.mjs` runs the actual registered `music_generate` tool,
catalog, serializer and media delivery from public OpenClaw
`3645a2c86518e9e98e4df2a81d00355bc6b082c0` through real Worker/SQLite. Its
qualified offline receipt includes build, production/test types, lint and
26 Node plus 26 Bun real-HTTP cases. Native PR landing remains separate; no new
SDK report is rendered or older artifact transferred to this composition.

The fixture narrows real credential-scoped offers to exercise each native and
manifest transport without manufacturing eligibility. The manifest isolate
disables native preference only on the actual compiled music endpoint so its
manifest offer remains available. Explicit stale and foreign discovery cases
test rejection before a paid request.

Thirty actual-client cases cover both frozen models, the pinned offline MP3 and
valid PCM WAV bytes, host-loaded inline PNG, lyrics/instrumental preservation,
unknown-price hard-budget denial, proxy-only credentials, incomplete/error output,
no paid fallback, persistence failure and cancellation before dispatch or after
EOF. Actual POST assertions require the client's identity encoding request,
observed through `request.cf.clientAcceptEncoding` before edge normalization.
Outer assertions require one seven-micro `policy_fixed` settlement per
dispatched request and NULL token accounting despite native diagnostic counters.
These actual-source cases are **AUTHORED/UNRUN** until the final hosted composition
passes. They are not a native OpenClaw PR readiness or live-entitlement claim.

The locked edge fixture normalizes a forced gzip response to the caller's
requested identity encoding. Optional caller-boundary forced-gzip injection is
therefore not claimed here; the selected client's existing qualified real-HTTP
negative proof rejects gzip with one POST and no fallback. No production response
header, reader bound, encoding guard or timeout is changed.

Physical pre-header host-disconnect propagation remains a separate locked-local-
runtime limitation. The post-EOF client abort test does not claim that boundary,
upstream refund, cancelled generation, live playback or invoice accuracy.
