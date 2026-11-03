# SenseAudio file transcription

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7` calls
`transcribeOpenAiCompatibleAudio` from its SenseAudio media-understanding provider.
The default is `senseaudio-asr-pro-1.5-260319`, multipart POST to
`https://api.senseaudio.cn/v1/audio/transcriptions`, with Bearer authorization.
The client supplies file/model and optional language/prompt, then requires text.

## Native evidence

- [HTTP transcription reference](https://docs.senseaudio.cn/api-reference/endpoint/asr/transcriptions)
  and [OpenAPI](https://docs.senseaudio.cn/api-reference/endpoint/asr/transcriptions.openapi.json):
  exact model, Bearer auth, direct files up to 10 MB, JSON text and optional
  duration (seconds) / audio_info.duration (milliseconds).
- [Model billing](https://docs.senseaudio.cn/guides/account/model-list-billing):
  ASR-Pro is CNY 3.6 per audio hour. Whole-file duration, rounding and currency
  conversion are not qualified for dollar reservation. Do not use OpenAI tokens.
- Direct file upload avoids the separate file_id lifecycle. No uploaded-file
  ownership or arbitrary file-ID access is enabled.

The regional origin is fixed to api.senseaudio.cn. No global fallback or alternate
credential region is inferred. The docs do not specify the frozen client's prompt
hint semantics; it is preserved as an optional compatibility field without claiming
recognition quality. The bounded adapter supports ISO-639-1/3 language codes.

## Activation handoff

The existing `worker/transcription.ts` hard-codes OpenAI routes and one OpenAI
model. Its owner must resolve this provider/model/endpoint through the same
authenticated, bounded multipart pipeline, fresh post-upload admission,
credential selection, reservation, dispatch acknowledgement and settlement.
Use `prepareSenseAudioUpload` after bounded multipart parsing and before dispatch;
keep the parser's raw-byte/framing limits and enforce the smaller 10 MB file limit.
Its allowed extension/MIME slice includes AAC; the existing parser needs the
corresponding selected-provider qualification, plus three-letter language codes.

Use `observeSenseAudioTranscription` only after bounded complete UTF-8 JSON EOF.
It accepts native text, retains unknown or inconsistent duration as null and
never creates token usage. HTTP errors, redirects, truncated bodies and
cancellation retain the existing no-replay/fixed-reservation behavior.
The manifest's distinct response format prevents an accidental OpenAI-token claim.

No generic JSON route can replace this multipart path. The new manifest must not
be activated by snapshot regeneration until that runtime work and real Worker
tests land. The client bridge owner consumes
`providers/_fixtures/senseaudio/transcription.json`; direct provider credentials
stay outside proxy requests. Fixtures are synthetic transport data, not live ASR.

The single qualified model has no dollar tariff. Unknown-price hard budgets must
fail before dispatch; explicit policy_fixed remains a policy charge. The fixture's
CNY rate and duration evidence do not certify a live upstream dollar cost.
