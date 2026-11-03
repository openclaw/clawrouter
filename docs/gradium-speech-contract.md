# Gradium unary speech

This route matches OpenClaw revision
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/gradium/speech-provider.ts`. It submits JSON with text, voice_id,
only_audio:true, output_format and an encoded json_config to
`POST https://api.gradium.ai/api/post/speech/tts`, authenticated with x-api-key.
The binary output is passed through unchanged. The selected slice is WAV, Opus
and ulaw_8000, matching speech, voice-note and telephony consumers.

## Native evidence

- [REST response modes](https://docs.gradium.ai/guides/text-to-speech-rest):
  only_audio:true selects binary; omission or false selects a JSON stream.
- [Request reference](https://docs.gradium.ai/api-reference/endpoint/tts-post):
  native field names, auth header and supported audio formats.
- [Limits](https://docs.gradium.ai/guides/limits): 3000-second native session
  ceiling. The route's 120-second transport timeout is a local bound, not a
  provider completion or cancellation guarantee.
- [Pricing](https://gradium.ai/pricing): one credit per TTS character; subscription
  allocations and extra-credit prices differ by plan. No universal dollar tariff
  or Unicode normalization rule is inferred from that credit unit.

## Runtime and consumer handoff

The runtime owner must call `validateGradiumSpeech(requestObject(selection.body))`
for request_format `gradium.speech` in `validateSelectedInput`, mapping its
validation error to an HTTP 400 before budget dispatch. This is required before
snapshot activation: the manifest cannot constrain only_audio by itself.
The validator retains text/settings exactly and rejects JSON-stream modes.

The integration owner regenerates the provider snapshot and validates all
manifests. The client owner must resolve this native route using the scoped
capability bridge; the frozen client's origin allowlist otherwise still forces
api.gradium.ai. Do not relax the direct provider credential origin to achieve
proxy support. Proxy credentials and provider credentials stay separate.

`providers/_fixtures/gradium/speech.json` is synthetic wire evidence. The WAV is
transport data, not a generated voice or live inference receipt. Tests qualify
exact JSON/auth/audio forwarding, failure accounting and budget rejection.
Output MIME/EOF establishes delivered binary completion only. Wrong MIME,
partial data and disconnect do not establish zero upstream cost or cancellation.

No model or per-character dollar tariff is registered. Selection is provider-wide;
model_name and voice_id are native settings, not registered model policy IDs.
Hard budgets without an explicit policy_fixed charge must reject before fetch.
The legacy flat fallback is not vendor cost. The billing unit is documented for
a later qualified tariff, not converted to fabricated token usage.

No WebSocket, JSON streaming, voice management, live-credit proof or deployment
is included in this bounded slice.
