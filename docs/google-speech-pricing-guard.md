# Google output-audio pricing guards

The actual wrapper in [PR668](https://github.com/openclaw/clawrouter/pull/668),
landed as `ac18389ae0252544c1fd2b8d0ce91a39285c2541`, uses two exact formats:
`google.speech_generate_content` and `google.speech_interactions`. Both return
native bounded audio with null normalized tokens. Neither byte limits, complete
PCM/WAV, preserved usage metadata nor a successful status establishes a
whole-request speech tariff.

The existing pricing helpers reject both formats before text, zero-rate or
foreign image prices. Caller and provider upstream-dollar hard budgets remain
closed. `actualModelCost` returns unknown even for token-shaped, zero or
`billable: false` observations. Explicit `policy_fixed` admission and settlement
remain separately labeled, including authorized zero; unmetered native usage
retains `unpriced_usage` rather than an upstream invoice claim.

The five frozen model identities and their transport/body contracts remain
owned by the actual speech codec. The first three GenerateContent previews
retain the trusted-clock cutoff `2026-11-17T00:00:00Z`; price handling neither
extends qualification nor maps them to a replacement. The two qualified
Interactions models remain stateless. This change adds no model or offer.

Twelve focused speech cases consume the actual native speech fixture and codec
with a pinned pre-cutoff time: five-model/two-format pricing closure, both hard-budget
levels, policy-fixed separation, unknown settlement, unchanged text/image/music
behavior, preview expiry, and actual accounting events for both formats.

The direct pricing helpers consume the actual `googleAudioRequest` export from
`worker/google-audio-classification.ts`, landed in
[PR680](https://github.com/openclaw/clawrouter/pull/680) as
`5b5c6e1d0c425c06cb91ebe87a038e432e252ae1`. Trusted selected identity uses the
existing `PricingEndpoint.selectedUpstreamModel` and optional fifth
`requestPricingGap` argument introduced by
[PR681](https://github.com/openclaw/clawrouter/pull/681). Five additional cases
exercise all seven frozen music/speech identities, formal ProtoJSON AUDIO,
last-wins/null aliases and misleading caller fields. The existing image
classifier and explicit image/music settlement guards remain intact.

No audio model/modality classifier is duplicated here. Source1 retains the
shared helper, selection/auth/grants, generic audio bypass closure and the
frozen accounting fact. Direct token settlement has only a request format;
its finite explicit speech guard cannot replace that runtime fact for generic
GenerateContent. Model-less estimates likewise need trusted selected context
for identity-specific intent. Input audio understanding and output speech/music
are separate capabilities. Source3 retains declaration
qualification, source2 actual clients and source6 composed runtime/snapshot
proof. No route activation, tariff, replay, refund or upstream cancellation is
certified by this guard. Full native contract: [Google speech](google-speech-contract.md).
