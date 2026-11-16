# Gradium unary speech

This route matches OpenClaw revision
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/gradium/speech-provider.ts`. It submits JSON with text, voice_id,
only_audio:true, output_format and an encoded json_config to
`POST https://api.gradium.ai/api/post/speech/tts`, authenticated with x-api-key.
The validator preserves WAV, Opus and ulaw_8000 settings from the frozen client.
The complete-output wrapper qualifies only WAV (audio/wav) and Opus (audio/ogg).
It denies ulaw_8000 before dispatch because its HTTP MIME pair is unqualified;
validator acceptance alone is not executable telephony support.

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

The runtime owner wires `prepareNativeGradiumSpeech(selection)` for request_format
`gradium.speech`. That wrapper calls `validateGradiumSpeech`, preserves native
JSON and maps invalid settings to HTTP 400 before dispatch. The manifest cannot
constrain only_audio by itself. The wrapper also denies unqualified output
formats and rejects JSON-stream modes before paid egress.

The existing shared capacity lease reserves 32 MiB before dispatch for at most
16 MiB of complete output. Only HTTP 200, matching MIME and complete bounded EOF
produce unchanged audio bytes. Redirects, ranges, bad lengths, overflow, wrong
MIME and interrupted audio produce no partial audio publication. The native
runtime returns sanitized `502 provider_unavailable` for those upstream failures,
including rejected synthesis. A rejection without a qualified nonbillable
classifier does not release the dispatched policy_fixed charge or prove free
upstream work. Successful and failed delivery each settle once; neither permits
remote POST replay. Known-unsent admission remains a separate runtime outcome.

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
