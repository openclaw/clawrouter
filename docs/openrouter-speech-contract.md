# OpenRouter unary speech

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/openrouter/speech-provider.ts` and
`src/tts/openai-compatible-speech-provider.ts`.

`prepareOpenRouterSpeech(model, body)` covers exactly these frozen IDs:
`hexgrad/kokoro-82m`, `elevenlabs/eleven-turbo-v2`,
`google/gemini-3.1-flash-tts-preview`, `mistralai/voxtral-mini-tts-2603`.
This finite codec list does not prove current model or voice availability.
Preserve the server-admitted model and explicit native voice/format. The frozen
default is Kokoro, voice `af_alloy`, MP3, with a 120-second timeout. No defaults
are inserted here. Gemini TTS requires PCM according to current primary docs;
reject MP3 before dispatch instead of silently rewriting the client's format.

Wire: JSON `POST /api/v1/audio/speech`, response `audio/mpeg` for MP3 or
`audio/pcm` for PCM. Input is a single nonempty string, locally bounded to
32,768 UTF-16 units. Optional speed is retained within a local 0.25–4 bound;
upstream providers may ignore or reject non-default speed. Do not promise speed
support from this shape validation. Voice IDs are bounded opaque identifiers.
The native `provider.zdr` and `provider.data_collection` policy fields are
preserved. Speech does not honor provider `order`, `only` or `ignore`; reject
them rather than claim routing isolation. Provider-specific `provider.options`
remain closed until source3 qualifies each model's fields and their billing
effects. No arbitrary downstream options, reference uploads, cloning, multi-turn
input, new model IDs or client credentials enter this slice.

`readOpenRouterSpeech(response, request, signal)` requires complete HTTP 200,
matching MIME, no redirects/ranges, consistent length and 1–16 MiB audio.
The original request deadline/caller signal cancels stalled reads. Bytes are
copied and returned unchanged. `X-Generation-Id` is a bounded opaque receipt,
not authority for later requests. No generation lookup, credential forwarding,
fallback or paid POST replay is performed. Raw PCM's sample rate and width are
not inferred across providers; playback needs a qualified model-specific format.
Synthetic fixtures test transport identity, not acoustic validity or quality.

No authoritative billable character or dollar usage accompanies this binary
contract. Input length, byte count, missing receipt, failure and interrupted
delivery do not prove a bill or a refund. `billableCharacters`, `sampleRate` and
`upstreamCostMicros` remain null. Unknown upstream-dollar tariffs stay closed
under hard budgets; policy-fixed charging is separate.

Source3 owns existing OpenRouter YAML and the four model rows/tariffs. Reuse
the existing `openai.audio_speech` request and `audio.binary` response declarations
only after actual runtime qualification. Source1 owns original origin/key
selection, admission, dispatch acknowledgment, cancellation and settlement.
Canonical server credential is `OPENROUTER_API_KEY`; custom configured origins
need their own bound grant and no fallback to the public origin. Source2 owns
the real speech consumer and Gemini PCM selection; source6 owns end-to-end proof.
No route activation or completed parity is claimed by this source-only PR.

Fixture: `providers/_fixtures/openrouter/speech.json`.
Checks: `node --test worker/test/openrouter-speech.test.mjs`.
Primary evidence checked 2026-11-03:
[OpenRouter TTS wire, provider policy, MIME and billing](https://openrouter.ai/docs/guides/overview/multimodal/tts).
