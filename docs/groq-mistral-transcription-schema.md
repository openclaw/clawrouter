# Groq and Mistral transcription declarations

This compiler contract consumes the landed [unary multipart codec](groq-mistral-audio-contract.md)
and its frozen fixtures. It adds no provider declaration, generated offer or
shared multipart dispatch.

| Provider | Request and response format | Existing base | Endpoint suffix | Selected upstream model |
| --- | --- | --- | --- | --- |
| Groq | `groq.transcription` | `https://api.groq.com/openai` | `/v1/audio/transcriptions` | `whisper-large-v3-turbo` |
| Mistral | `mistral.transcription` | `https://api.mistral.ai` | `/v1/audio/transcriptions` | `voxtral-mini-latest` |

Each endpoint is unary POST with `audio.transcription`, no path parameters,
query, caller-controlled headers, mapped path, model passthrough or credential
override. The existing original Bearer API key remains authoritative. Groq's
`/openai` prefix belongs to its base; repeating it in the suffix is rejected.
FormData supplies the fresh multipart boundary. An endpoint may declare only an
`Accept: application/json` header, never a fixed multipart Content-Type.

The exact audio-only model card has no price or endpoint tariff. Optional native
facts can describe audio input; the upload and JSON response byte limits cannot
be represented as token context or output limits. Existing Chat and embedding
cards retain their capabilities and prices. Neither provider can route an audio
model through Chat by adding a second capability.

The codec consumes the existing `TranscriptionUpload`: a bounded file plus
`model`, optional `language` and Groq's optional `prompt`. Mistral's prompt is
rejected without dropping or translating it. The response reader preserves the
native body, selected model and separately observed model and audio seconds.
An observed Mistral alias resolution does not rewrite the selected identity or
qualify a tariff. Byte counts, transcript length and native usage do not prove
billable duration or a whole-request dollar upper bound. Both caller and provider
hard-dollar budgets reject these unpriced cards. Explicit `policy_fixed` charging
remains separate from upstream cost.

## Activation boundary

The compiler tests compose the existing manifests, parsed-field selection,
actual multipart codec and complete JSON reader. Their four fixture bytes prove
wire preservation only; they are not playable audio or measured-duration proof.
The current shared multipart controller is OpenAI-specific. It must qualify the
two formats with authentication before upload, bounded parsing, fresh admission
after upload, original provider/model/credential binding, dispatch acknowledgment,
uncertain-outcome handling and settlement before these YAML routes are enabled.
No automatic POST replay or inferred cancellation is authorized.

The runtime owner supplies that dispatch and budget proof; the existing-provider
owner then activates YAML, and the integration owner qualifies the serialized
snapshot with the actual client. This schema foundation does not establish live
availability, actual-client parity or an upstream audio tariff. Mistral realtime
and other models remain outside this unary contract.
