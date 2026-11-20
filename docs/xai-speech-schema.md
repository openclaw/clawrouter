# Model-less xAI unary speech schema

The settled native contract is `xai.tts` to `audio.binary`, capability
`audio.speech`, POST `/v1/tts` at `https://api.x.ai`. There is no `binary`
response-format alias, OpenAI speech conversion or model selection.

```yaml
capabilities:
  - id: audio.speech
    endpoint: tts
    methods: [POST]
endpoints:
  tts:
    method: POST
    path: /v1/tts
    pathParams: []
    requestFormat: xai.tts
    responseFormat: audio.binary
```

This is a compiler fixture, not an activated provider declaration. The exact
original Bearer API-key scheme is required. The provider's existing Chat cards
remain unchanged; speech adds no model row or sample-model alias. The compiler
rejects endpoint remapping, query/header injection, streaming/WebSocket variants,
voice-list expansion, declared outcome tariffs and token ceilings. Per-codec
Accept headers come from the actual speech preparation, not caller passthrough.

The composed cases consume `prepareXaiSpeech`, `readXaiSpeech` and
`xaiSpeechFormats` from the landed codec. Native text, markup, voice, language,
speed and all five frozen codecs retain their wire identity. Complete synthetic
bytes test MIME/EOF validation, not intelligibility, playback or live synthesis.
The codec's service-default sample rate is not measured billing usage.

No qualified whole-request audio tariff is introduced. Model-less hard-dollar
admission stays closed and explicit policy-fixed charges remain separate.
The future runtime must preserve these boundaries against supplied Chat cards,
generic-route bypasses, interrupted delivery and uncertain POST replay.

The speech-specific legacy catalog repair
[PR759](https://github.com/openclaw/clawrouter/pull/759) landed as
`e0e8d2f23c1ae7a7b516976ddabff2216f8c9abd`. It qualifies the asymmetric
OpenAI speech request/binary-response pair. This schema consumes that foundation
without editing its projection or relaxing the legacy-route assertion.

Source5 published `prepareNativeXaiSpeech(selection)` in
[PR755](https://github.com/openclaw/clawrouter/pull/755) at
`c7e81e6aa593495e5d76f25ed7d0155d21342194`; its hosted qualification is separate.
That leaf matches this exact model-less `xai.tts` to `audio.binary` contract.
Source5 owns the factory and the pure
[speech codec contract](xai-speech-contract.md); source1 owns common selection,
authentication, deadline, admission and settlement. Provider YAML and snapshots
remain closed until that runtime and meaningful composed proof exist. Actual
speech/Talk consumers remain a separate qualification. No new shared field,
deployment, live call or provider capability badge is claimed.
