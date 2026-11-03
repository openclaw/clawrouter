# Native speech providers

Checked 2026-11-03. The experimental Inworld route forwards native unary speech
requests. They do not implement OpenAI speech compatibility, voice discovery,
voice cloning, multipart transcription, WebSocket sessions or asynchronous jobs.

| Provider | Native route | Credential | Response |
| --- | --- | --- | --- |
| Inworld | `POST /v1/native/inworld/tts/v1/voice` | Selected `INWORLD_API_KEY` supplies `Authorization: Basic …`; the stored value is already Base64 encoded | JSON containing Base64 `audioContent` and native usage |

Use Inworld's JSON body with `text`, `modelId`, `voiceId` and `audioConfig`.
Do not replace those names with a router `model` field. No synthetic language-model
rows are created. Provider-wide permission is the current authorization unit;
per-voice and native model-field authorization are not implemented. Use dedicated
upstream credentials when exposing a restricted voice/model inventory. Existing
router model allowlists are not native voice or modelId allowlists.

Sources: [ElevenLabs speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert),
[Inworld unary speech](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech).
Inworld HTTP streaming uses a different framed JSON format and is not declared
by this unary endpoint. ElevenLabs is withheld: its `previous_request_ids` and `next_request_ids`
reference upstream history and require owner-bound access or pre-dispatch
rejection before a pooled route can ship. No ElevenLabs manifest is included.

This manifest does not qualify upstream character, audio-duration or credit costs.
Reserve budgets fail closed without an explicit fixed policy request price.
A fixed price charges router policy, not the upstream invoice. Legacy unmetered
accounting records `flat_fallback` at one micro-unit; it is not measured speech
cost. Native usage fields are preserved for the client but are not normalized
into a speech-credit ledger. Incomplete binary delivery must not be reported as
completed audio or zero-cost synthesis.

The focused tests exercise native payload and JSON preservation, provider
credential isolation, reserve rejection, policy charging and error delivery.
Live voice/model entitlement, actual billing and OpenClaw client end-to-end
execution remain independent qualification gates. Integration must regenerate
the runtime provider snapshot before these routes can ship.
