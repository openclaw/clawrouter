# OpenRouter MP3 declaration

This declaration consumes the qualified native leaf in
[`e452b1b`](https://github.com/openclaw/clawrouter/commit/e452b1b2dd510443b15a889f4b6cb99fd7b1ad63)
and common runtime in
[`0dd0b74`](https://github.com/openclaw/clawrouter/commit/0dd0b749d83c2b9e8c536199bb67c4faf4d84ce5).
The frozen source is OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/openrouter/speech-provider.ts` and
`src/tts/openai-compatible-speech-provider.ts`. The existing
[speech contract](openrouter-speech-contract.md) records the checked primary
[OpenRouter TTS contract](https://openrouter.ai/docs/guides/overview/multimodal/tts).
No additional model or tariff research is part of this declaration.

Only `hexgrad/kokoro-82m`, `elevenlabs/eleven-turbo-v2` and
`mistralai/voxtral-mini-tts-2603` gain explicit `audio.speech`. They use
`openai.audio_speech` input and `audio.binary` output at `POST /v1/audio/speech`.
The existing base `https://openrouter.ai/api` produces exactly
`https://openrouter.ai/api/v1/audio/speech`. The native caller route is
`/v1/native/openrouter/v1/audio/speech`; the manifest route is
`/v1/proxy/openrouter/speech`. Native requests select the upstream model ID;
manifest bodies select the corresponding `openrouter/`-prefixed card ID.
The 120-second endpoint timeout follows the frozen speech contract.

The existing leaf requires explicit voice and MP3 format, validates the native
body and delivers only complete bounded `audio/mpeg`. This declaration inserts
no voice default, telephony profile, token limits or output-byte limits. Gemini
PCM, arbitrary model passthrough, uploaded references and provider-specific
options remain outside this qualified route. Speech cards do not inherit Chat
or Responses capability. All pre-existing OpenRouter YAML blocks are preserved.

The three cards have no pricing or pricing reference: compiled prices remain
null. Trusted OpenRouter context keeps unknown upstream-dollar speech charges
closed before dispatch even when unrelated LLM rates exist. Explicit policy
fees remain `policy_fixed`; binary audio does not become token usage or an
invoice. Existing provider billing metadata remains unchanged; the qualified
native runtime owns its speech accounting and original credential binding.

`worker/test/openrouter-mp3-declaration.test.mjs` compiles the actual YAML into
real Worker/SQLite fixtures. It reuses the qualified MP3 fixture and checks both
caller routes, complete bytes, original credentials, conservative costs and
excluded request shapes. All 22 cases are authored and unrun locally because
this checkout has no qualified dependencies; syntax checks do not prove execution.

The actual client handoff is published in
[OpenClaw PR192535](https://github.com/openclaw/openclaw/pull/192535) at
`cb95c93764466390c000c1b00bf8ac38e74b9610`: native/manifest routes, the selected
proxy key, caller signal and no paid POST replay. Its 31 actual TTS/Talk cases
are authored and unrun at this handoff; publication is not client execution
proof. Generated snapshots and composed qualification remain in the existing
serialized integration queue after PR797. This declaration does not establish
voice availability, a live provider result or completed registered-client parity.
