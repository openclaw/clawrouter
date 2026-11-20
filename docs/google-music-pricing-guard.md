# Explicit Lyria music pricing guard

The actual landed [PR665](https://github.com/openclaw/clawrouter/pull/665)
wrapper, source `81cd93565e7af811201d7bee06b021c700415d28`, squash
`7ad413d8b93cb93d6b7d8c48cf415a400c4fb38e`, accepts `google.music_generate`
with response `google.music` and `audio.generate`. Its only model IDs are
`lyria-3-clip-preview` and `lyria-3-pro-preview`; the native GenerateContent
body requests AUDIO/TEXT. See [the wire contract](google-music-contract.md).

The three existing pricing helpers now keep this explicit format unpriced:
`requestPricingGap` returns `opaque_input_bound`, `estimateModelCost` returns
no qualified price or token bounds, and `actualModelCost` returns null even
for token-shaped counters, zero rates, image cards or a nonbillable flag.
Request/image/audio byte caps, complete MP3/WAV framing, lyrics and preserved
native usage do not qualify whole-request upstream dollars or a free response.
No new tariff, shared type, classifier or provider switch is introduced.

Eight focused cases consume the actual codec's two identities and native body,
then verify caller/provider hard-budget denial, token/invoice refusal, separately
labeled fixed zero/positive policy charges and unknown unmetered settlement.
Ordinary Google text and independently qualified OpenAI images retain their
contracts. Synthetic rate cards in these tests demonstrate rejected borrowing;
they are not Lyria model limits or vendor prices.

This is an explicit-format foundation. Source1 still owns generic AUDIO/music
classification with trusted selected-model context, ambiguity rejection on the
shared GenerateContent path, native/manifest/stream bypass closure, original
credentials, actual dispatch and frozen settlement facts. Source3 will consume
that actual shared contract; no second model/modality classifier is invented.
The image-specific classifier is not silently broadened to music in this slice.

Source3's finite declaration follows the actual wrapper; existing Google YAML
and snapshots remain inactive until common matching/admission and Worker/client
proof qualify. Source5 retains wrapper ownership. No partial-delivery, automatic
retry, upstream cancellation, refund, live compatibility or account claim is
made. Canceling a reader does not prove canceled or free upstream generation.
