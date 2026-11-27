# xAI unary transcription

Frozen source `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`, `extensions/xai/stt.ts`,
uses native multipart POST `/v1/stt`: optional language followed by the file.
It ignores generic media model/prompt hints before constructing the native form.
The proxy must not insert those fields or an OpenAI transcription model.

Primary [speech-to-text documentation](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text),
checked 2026-11-03, confirms optional model selection defaults to
`grok-voice-transcribe-2.0`, container uploads, file-last ordering and JSON
text/duration/word results. Duration is seconds rounded to two decimals;
word timing can be more precise. The [public price](https://docs.x.ai/developers/models)
is $0.10/hour for batch versus $0.20/hour for streaming. Neither rate is activated
here; interruption debit and billing rounding still need qualification.

`worker/xai-transcription.ts` exports `prepareXaiTranscription(upload)`,
`observeXaiTranscription(body, complete)` and `readXaiTranscription(response, signal)`.
Fixture: `providers/_fixtures/xai/transcription.json`. Proposed exact format
`xai.stt` request/response, multipart `audio.transcription`.

The existing `TranscriptionUpload` shape is reused, but the current shared parser
requires model, limits language to two bytes, and admits a narrower extension
list. Source 11.1 must qualify a format-specific parse policy: optional BCP-47
language only, exactly one bounded file, no model requirement, and the native
container MIME pairs. Preserve authentication before reading, multipart duplicate
and byte limits, cancellation/deadline, then fresh admission after upload. Do not
globally relax the OpenAI parser or allow unbounded request.formData().

The adapter caps files at 25,000,000 bytes to match the existing router envelope;
this is smaller than the vendor limit. It rejects raw audio that would need
unprovided encoding/sample-rate fields. URL input, multichannel, diarization,
formatting and keyterms are outside the frozen consumer. File content remains
byte-identical, while the regenerated native multipart keeps the file last.
Container decoding/validity remains actual-client qualification; synthetic
fixture bytes prove transport identity, not playable audio or live availability.

Complete HTTP 200 UTF-8 JSON is required within 1 MiB. Empty transcript is valid
silence, not evidence of free work. Missing duration stays unknown. Native
duration and word timings are diagnostics; do not derive a dollar charge from
file size, elapsed time, text length or the public card alone. A returned model
outside the dated service contract fails qualification instead of silently
relabeling it. Caller cancellation does not authorize another paid POST.

Source 11.3 owns existing xAI YAML/schema and pricing. Source 11.1 owns bounded
native parsing, selected original grant, service admission, dispatch and exactly
one settlement. Source 11.2 owns media-understanding consumer preservation and
source 11.6 integrated proof. This focused codec does not activate the endpoint.
Unknown upstream-dollar hard budgets remain closed; policy_fixed is separate.
No live calls, production deployment or credential/account changes.
