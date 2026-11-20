# OpenRouter JSON transcription contract

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`:
`extensions/openrouter/media-understanding-provider.ts` and its tests. The only
finite default model is `openai/whisper-large-v3-turbo`. Image understanding is
declared through the generic image consumer (`describeImage`/`describeImages`
are undefined); it does not imply a second native audio or video transport.

Primary evidence checked 2026-11-03:
[OpenRouter STT](https://openrouter.ai/docs/guides/overview/multimodal/stt) documents
JSON `POST /api/v1/audio/transcriptions` with base64 `input_audio.data`, explicit
format, optional language/temperature, transcript and optional usage. This frozen
slice uses the seven documented formats, ISO-639-1 language and temperature 0–1.
The endpoint also supports other input forms/options; those are outside this
frozen consumer. Provider routing preferences are not uniformly applied, so this
codec does not accept them. Native duration, tokens and cost are distinct fields.

[The exact model page](https://openrouter.ai/openai/whisper-large-v3-turbo) lists
different endpoint rates. Do not price every OpenRouter account, selected
endpoint or BYOK arrangement using the cheapest advertised rate.

## Concrete source contract

`worker/openrouter-transcription.ts` exports `openRouterTranscriptionModels`,
`openRouterTranscriptionFormats`, `prepareOpenRouterTranscription`,
`observeOpenRouterTranscription`, and `readOpenRouterTranscription`.
Sanitized fixture: `providers/_fixtures/openrouter/transcription.json`.

Preparation checks the admitted model against the body, snapshots the request,
preserves canonical base64 bytes, and sets JSON/Accept headers. Runtime owns the
selected origin and server credential. No file paths, client secrets, remote
audio URLs, multipart fallback, streaming or external fetch occurs here. The
16 MiB decoded audio cap is local, not a provider duration or price bound. MIME
and filename mapping stays in the actual client: e.g. mp4 maps to m4a, and
oga/opus map to ogg. The codec receives the normalized native format.

The existing shared `readNativeJson` enforces complete HTTP 200 JSON, strict
UTF-8, 1 MiB response, length consistency, no ranges/redirects, and abort handling.
Transcript text is at most 262,144 UTF-16 units and must be well-formed. Trimming
matches frozen `requireTranscriptionText`; silence may produce an empty string
and must not trigger an automatic retry. API errors and partial completion fail.
Optional response model must match. The generation header is bounded diagnostic
identity, not authority to retrieve another job.

`audioSeconds`, `nativeCost`, `inputTokens`, `outputTokens`, `totalTokens` are
nullable, independent native observations. No sum, zero, duration or tariff is
invented when fields are absent. The response body is transient; do not persist
transcripts in ownership state or logs. `upstreamCostMicros` stays unknown until
shared accounting qualifies the actual route/tariff. Silence, failed delivery,
abort and missing usage do not prove free processing. Upstream-dollar hard
budgets stay closed without a preflight bound; policy-fixed charging is distinct.

## Owner handoff

- Source3: existing OpenRouter YAML/schema. Proposed format handshake:
  `openrouter.audio_transcription` for this JSON request/result, capability
  `audio.transcription`. It is not `openai.audio_transcriptions` multipart.
- Source1: auth-before-body, bounded JSON admission, selected-grant dispatch,
  fresh policy/budget qualification after body arrival, and existing settlement.
  No automatic paid POST retry following uncertain dispatch.
- Source2: actual native media consumer; preserve byte identity, language,
  temperature, normalized formats, silent transcript and cancellation behavior.
- Source6: Worker/client proof and serialized provider snapshot integration.

No provider manifest or shared runtime changed here. Six deterministic tests
qualify wire behavior; route activation, live transcription accuracy and live
cost proof remain separate. Synthetic bytes are not playable-audio evidence.
