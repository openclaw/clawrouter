# Fish Audio speech

The experimental `fish-audio` provider exposes native JSON `POST /v1/tts` at
`/v1/native/fish-audio/v1/tts`, with `FISH_AUDIO_API_KEY` bearer credentials.
It preserves text, reference voice IDs, format/sample rate and the native `model`
header. Audio bytes and MIME type pass through the existing binary observer.
The synthetic WAV wire/result fixture is
`providers/_fixtures/fish-audio/speech.json`.

This model-less offer grants provider-wide speech access. It does not enforce a
voice or engine allowlist. Fish selects `s2.1-pro` when the header is missing or
unrecognized; clients should send an explicit supported engine. This route does
not claim MessagePack inline-reference support, WebSockets or file transcription.
See the [native TTS contract](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech).

Fish bills TTS by UTF-8 input bytes. Those are neither Unicode characters nor
language-model tokens. Prices depend on the engine and can include temporary
promotions. This manifest deliberately publishes no token/character tariff;
hard-budget requests need an explicit fixed request price. Unmetered requests
use the router's existing one-microdollar fallback, which is not an upstream
invoice estimate. Rejected upstream calls remain nonbillable; partial/invalid
audio is not proof of completed synthesis. See
[pricing](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits).

The real Worker fixture tests cover auth, native header/body preservation, binary
delivery, policy denial, hard-budget refusal, fixed charging and wrong MIME.
Live synthesis, UTF-8 tariff admission and OpenClaw's speech consumer bridge still
require qualification. Sources checked 2026-11-03.
