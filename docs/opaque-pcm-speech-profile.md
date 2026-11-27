# Opaque PCM speech metadata

The optional `nativeCapabilities.endpoints.<endpointId>.speech` profile describes
one selected model's endpoint. It is support metadata, never a grant, price,
admission result or dispatch selector. The existing
`clawrouter.native-capabilities.v1` envelope still requires source provenance
and a checked date.

```ts
interface OpaquePcmSpeechProfile {
  voiceRequired: true;
  responseFormat: "pcm";
  output: {
    kind: "opaque";
    mimeType: "audio/pcm";
    sampleRate: null;
    voiceCompatible: false;
  };
}
```

`responseFormat` describes the required native request's `response_format`.
The schema requires every field and rejects additional properties at both
profile levels. It cannot declare default voices, a voice inventory, playback,
WAV, Talk, channels, sample width, signedness, byte order or a guessed rate.
`sampleRate: null` is explicit unknown metadata; `voiceCompatible: false` must
survive JSON projection as false, not omission or a default.

The compiler requires an endpoint supported by that model with explicit
`audio.speech`, unary POST, `openai.audio_speech` input and `audio.binary` output.
The global endpoint and model root cannot hold the profile. Other models on the
same endpoint do not inherit it. Existing compilation and caller-scoped public
catalog projection preserve the profile without adding eligibility or prices.

The qualified [OpenRouter PCM leaf](openrouter-pcm-speech-contract.md) is the
current consumer contract. This metadata change adds no provider YAML, model,
snapshot, route activation or runtime reader. Common PCM dispatch, original
credential/admission binding and actual client qualification remain separate.
The three OpenRouter MP3 cards and their defaults remain unchanged.

`worker/test/speech-profile-compiler.test.mjs` covers compiled/model-index JSON
round trips, optional-profile compatibility, malformed and misplaced profiles,
native/manifest public projection and grant revocation without upstream calls.
These are metadata tests, not PCM dispatch or playback evidence.
