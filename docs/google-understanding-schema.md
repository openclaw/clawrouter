# Google inline understanding declaration contract

This bounded compiler slice consumes the landed
[PR671](https://github.com/openclaw/clawrouter/pull/671) codec and response wrapper,
source `61f279c9f850e7cf64b3ed27807925ab1aaa90ea`. It changes no bundled provider,
snapshot, shared runtime or client. The only model identity is
`google/gemini-3-flash-preview`, upstream `gemini-3-flash-preview`.

| Request format | Capability | Response format |
| --- | --- | --- |
| `google.audio_understanding` | `audio.transcription` | `google.generate_content` |
| `google.video_understanding` | `video.understanding` | `google.generate_content` |

Either endpoint can be declared independently. Both require unary POST
`/v1beta/models/${model}:generateContent`, exactly one model segment, canonical
`https://generativelanguage.googleapis.com` and the original required
`x-goog-api-key`. No query, stream, credential override, URL/path remapping,
lifecycle, model passthrough, output limit or invented tariff is qualified.

An explicit `nativeProxy: false` keeps the overlapping native path closed. The
manifest endpoint ID identifies the operation without model-only ambiguity,
endpoint ordering or guessed request-body intent. Actual native intent selection
remains shared-runtime work; a manifest offer does not prove a native consumer.

Each model endpoint must use the existing `endpointPricing` shape with a nonempty
`pricingRef` and `pricing: null`. The model's independently qualified ordinary
text price and facts remain unchanged. The landed
[PR725](https://github.com/openclaw/clawrouter/pull/725) format guard also prevents
shared token cards, counters and nonbillable flags from certifying these native
requests. Both upstream-dollar hard budgets deny unknown whole-request costs;
authorized `policy_fixed` charging remains separately labeled.

Actual wrapper input is narrower than the pure codec: explicit PCM WAV or MP4,
8 MiB request JSON, 4 MiB decoded inline media and complete 1 MiB response JSON.
These are memory/container bounds, not duration or billable-token evidence.
Raw file IDs, URLs and asset ownership are not activated. Full wire, MIME and
response behavior remain in the [codec contract](google-media-understanding-contract.md).

Seven composed cases exercise declaration selection, exact codecs, the actual
wrapper with complete PCM WAV, explicit manifest offers, endpoint-specific
unknown costs and rejected expansions. The published four-byte samples remain
wire-only fixtures and are explicitly rejected by the wrapper. This slice does
not duplicate the wrapper's decoder-qualified video tests or claim actual video
routing/delivery. Shared authenticated dispatch, deadline/capacity/settlement,
actual client acceptance and serialized snapshot proof remain activation gates.
