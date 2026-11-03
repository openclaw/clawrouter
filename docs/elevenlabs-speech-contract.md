# ElevenLabs unary speech

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/elevenlabs/speech-provider-factory.ts`, submits JSON to the
voice-scoped `/v1/text-to-speech/{voice_id}` path with xi-api-key. Native model_id,
voice_settings, seed and normalization stay in the body; output_format and
optional optimize_streaming_latency stay in the query.

The manifest expresses this route directly. Binary audio is delivered unchanged.
The frozen default is eleven_multilingual_v2; default normal output is
mp3_44100_128 and voice notes use opus_48000_64. The fixture uses silent PCM
to check byte transport without requiring a codec or a live generated voice.

## Evidence and boundaries

- [Create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
  qualifies the voice path, query, JSON and binary response. Some formats require
  a higher subscription tier. Latency optimization is deprecated upstream;
  preserving the frozen client's query does not guarantee that optimization.
- [Authentication](https://elevenlabs.io/docs/api-reference/authentication)
  specifies xi-api-key. Caller proxy authorization never becomes that key.
- [API pricing](https://elevenlabs.io/pricing/api) lists Multilingual v2 at
  USD 0.08 per thousand characters and Flash/Turbo at USD 0.04. The manifest
  deliberately has no invented universal speech rate: native model_id is not
  resolved as a registered model, and billed character/plan qualification remains.

This is provider-wide capability selection. Native voice/model IDs are not
registered policy model IDs. Hard upstream-dollar budgets must reject unknown
pricing before fetch; explicit policy_fixed is a policy fee, not vendor cost.
Binary MIME/EOF proves delivery only. Partial delivery and disconnect do not
prove that upstream work was canceled or free.

## Integration

Integration owns snapshot regeneration and all-manifest validation. The scoped
client bridge must pass the selected native voice path, body and output query,
using its proxy credential separately from the upstream key. Fixtures at
`providers/_fixtures/elevenlabs/speech.json` are the portable consumer contract.
Worker tests cover native and manifest paths, query placement, credentials,
audio bytes, unknown-price budget refusal and unsuccessful delivery.

The /stream, timestamped JSON, voice management and multipart Scribe endpoints
are outside this unary slice. No deployment, paid entitlement or live cost proof
is claimed.
