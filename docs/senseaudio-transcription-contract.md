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

## Source readiness and exact remaining boundary

The existing `prepareSenseAudioUpload({ file, fields }): FormData` ABI fits the
published multipart reader's `TranscriptionUpload` shape without a new wrapper
framework. It preserves the file bytes/name/MIME, canonicalizes only the router
model prefix, bounds files to 10,000,000 bytes and prompt UTF-8 to 16,384 bytes,
and allows only the frozen model, optional language/prompt and unary JSON fields.
The finite filename/MIME slice is WAV, MP3, OGG, FLAC, AAC, M4A and MP4; the
validator checks framing results and labels, not every supported media codec.

`providers/_fixtures/senseaudio/transcription.json` now includes `aacFile`, an
offline decoder-qualified AAC-LC ADTS sample at 16 kHz mono. Its `.aac` name and
`audio/aac` MIME must survive multipart construction unchanged; renaming it to
`.m4a` is not qualification. The existing WAV is also decoder-qualified PCM16LE
at 8 kHz mono with complete RIFF/data lengths. These short synthetic samples
are separate from the response's duration observation and prove no tariff.
Seven focused tests include AAC frame/name/byte preservation and WAV framing.

At published raw-runtime source `3ac58451fdccf3950ead584be49e2e835df1a726`
([PR482](https://github.com/openclaw/clawrouter/pull/482)), multipart dispatch
still selects OpenAI, and its parser has no AAC extension entry. That source's
Deepgram binary branch is not a SenseAudio multipart implementation. Source1
must qualify provider/model selection, selected-provider AAC and three-letter
language parsing, invoke this preparer and complete-result observer, and retain
auth-before-read, fresh post-upload admission, original credentials and both
budget settlements. No central source is changed here.

The actual native client candidate is
[PR192167](https://github.com/openclaw/openclaw/pull/192167), source
`f6fbd3fae951258f999bb555dc369ec594916886`, covering OpenAI/SenseAudio only.
Its publication is not actual Worker acceptance. Source6 owns future atomic
provider/runtime/snapshot integration and composed proof. Source1's missing
dispatch integration remains the activation blocker; no new input ABI or paid
POST is required to finish this source qualification.
