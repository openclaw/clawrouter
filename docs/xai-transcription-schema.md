# Model-less xAI transcription declarations

The compiler qualifies the landed [xAI unary STT codec](xai-transcription-contract.md)
as exact request/response format `xai.stt`, capability `audio.transcription`,
POST `/v1/stt` under `https://api.x.ai`. This native multipart operation has no
model selector. Its documented service default is not a router model card or
permission to insert a model field into the frozen request.

One endpoint uses the original selected Bearer API key, no path parameters,
query, mapped path, streaming, model passthrough or caller headers. FormData
owns the fresh multipart boundary. Static endpoint headers may only declare
`Accept: application/json`. Existing Chat models and token prices are unchanged;
none can acquire the transcription capability. No request tariff is qualified.

Parsed native fields pass unchanged to `prepareXaiTranscription`: optional
BCP-47 language followed by the bounded file. Model/prompt hints, remote URLs
and raw audio requiring new encoding/sample-rate fields stay rejected. The
common runtime must qualify this format's parse policy without relaxing the
OpenAI model requirement or language contract globally. Authentication before
upload, duplicate/byte bounds, deadline, fresh admission after upload and
original grant/credential binding remain shared runtime responsibilities.

The complete JSON reader preserves text, native duration and word timing.
Empty text is valid silence, not free execution. Observed native model identity
does not register a model, and response duration is not a qualified billable
duration or dollar upper bound. Both hard-dollar budgets reject the unpriced
operation. Explicit `policy_fixed` is separate; no rate or zero-charge failure
is inferred. No automatic paid replay or upstream cancellation is introduced.

Six composed cases consume the actual source codec/reader, compiler, catalog,
parsed-field selection and budget gate. Fixture bytes establish wire identity
only. This foundation adds no existing-provider YAML, generated snapshot,
common multipart parser, runtime dispatch or actual-client proof. Those remain
with their original owners before activation; WebSocket STT is a separate
protocol and is not an alias of this unary format.
