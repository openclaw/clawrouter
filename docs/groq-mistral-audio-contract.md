# Groq and Mistral unary transcription

Frozen OpenClaw revision `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`:
`extensions/groq/index.ts`, `extensions/mistral/media-understanding-provider.ts`
and `src/media-understanding/openai-compatible-audio.ts`. Both consumers use a
multipart file, model and optional language. Groq also supports the frozen
client's optional prompt. This slice is unary transcription, not translation,
streaming, realtime, diarization or audio chat.

| Provider | Native path and model | Credential |
| --- | --- | --- |
| Groq | POST `https://api.groq.com/openai/v1/audio/transcriptions`; `whisper-large-v3-turbo` | Server-owned `GROQ_API_KEY`, native Bearer |
| Mistral | POST `https://api.mistral.ai/v1/audio/transcriptions`; `voxtral-mini-latest` | Server-owned `MISTRAL_API_KEY`, native Bearer |

`worker/groq-mistral-audio.ts` exports `prepareGroqMistralAudio`,
`observeGroqMistralAudio`, `readGroqMistralAudio` and the frozen route facts in
`groqMistralAudio`. The prepare function consumes the existing bounded
`TranscriptionUpload` shape, keeps fields before the file, and preserves file
bytes, safe filename and MIME. It returns no credential or Content-Type header:
the selected server credential and the new FormData boundary belong to runtime.
No file URL, uploaded-file ID, redirect replay or alternate model is admitted.

The local upload limit is 25,000,000 bytes, with the existing common audio
extension/MIME pairs. This is a memory/transport bound, not a duration estimate.
Prompt bytes are locally bounded; Groq's separate native 224-token prompt limit
remains vendor validation. The frozen client trims text fields and normalizes
AAC filenames before serialization; these codecs preserve the resulting wire.

Mistral's current transcription API documents `context_bias`, not Whisper's
`prompt`. A nonempty frozen-client prompt is rejected as unqualified rather than
dropped or converted to a different field. The actual consumer owner must keep
that unsupported option explicit. No transcription options are invented to make
the generic client's full configuration appear compatible.

Reads require HTTP 200, valid UTF-8/JSON through bounded EOF, nonempty final text
and no embedded error or explicit partial finish reason. The 1MiB response bound
and AbortSignal apply before delivery. Aborting delivery does not prove upstream
cancellation. Native usage and observed model identity are preserved; an alias's
resolved model is an observation, not permission to rewrite the selected model.
Missing or invalid duration stays unknown.

## Accounting and activation

Groq publishes $0.04/hour for Whisper turbo and a ten-second minimum billed
length. The default frozen JSON result need not contain duration. Byte length,
transcript length and a diagnostic duration do not qualify a whole-request debit
or preflight upper bound. Mistral's `usage.prompt_audio_seconds` is native audio
usage; this slice does not attach an unverified alias tariff or equate it with
chat token prices. Unknown upstream-dollar hard budgets remain closed. Explicit
policy-fixed charging is distinct from actual vendor cost.

Source 11.1 must reuse the existing bounded multipart pipeline, authenticate
before reading uploads, freshly admit the exact provider/model/capability after
upload, bind selected credentials, mark dispatch and settle once. The current
OpenAI-only transcription controller cannot activate these paths from a manifest
alone. Proposed formats are `groq.transcription` and `mistral.transcription`, with
`audio.transcription` capability; 11.3 owns existing provider YAML/schema. The
native paths differ, so no unconditional `/v1` prefix or provider alias is safe.
Source 11.2 owns actual client byte/result consumption; 11.6 owns Worker/client
acceptance. No shared controller, existing YAML or generated snapshot is edited.

Mistral now labels the Voxtral 2 guides deprecated and supplies a Voxtral 3 model
mapping. Its API reference still uses `voxtral-mini-latest`; the inspected
migration timeline gives no explicit shutdown date. Do not infer endpoint
removal or replace the frozen model with a new ID. Actual availability and alias
tariff qualification remain required before a live parity claim.

Sanitized fixtures are `providers/_fixtures/groq/transcription.json` and
`providers/_fixtures/mistral/transcription.json`. Their four synthetic bytes prove
serialization identity, not playable audio or measured duration. Six tests cover
native multipart round-trip, option/model isolation, explicit prompt rejection,
native usage preservation, truncated/invalid results and stalled-read cancellation.
No live calls or deployment occurred. Mistral realtime is a separate queued
WebSocket protocol, not inferred from this unary implementation.

Primary sources checked 2026-11-03:

- [Groq speech endpoint, formats, prices and minimum](https://console.groq.com/docs/speech-to-text)
- [Mistral native transcription API](https://docs.mistral.ai/api/endpoint/audio/transcriptions)
- [Mistral frozen-compatible file guide](https://docs.mistral.ai/studio/audio/deprecated/speech_to_text/offline_transcription)
- [Mistral migration and model mappings](https://docs.mistral.ai/studio/audio/migrate-from-voxtral-2)
