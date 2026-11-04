# Frozen Groq and Mistral transcription cards

These existing-provider declarations consume the landed
[multipart codec](groq-mistral-audio-contract.md) at
[`826a67c`](https://github.com/openclaw/clawrouter/commit/826a67cdad73b3e89e90d72133249cdb1f4c5906)
and the existing [compiler contract](groq-mistral-transcription-schema.md).
Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7` supplies the exact
selectors in `extensions/groq/index.ts` and
`extensions/mistral/media-understanding-provider.ts`.

| Provider | Selected upstream model | Paired request/response format | Existing base plus endpoint |
| --- | --- | --- | --- |
| Groq | `whisper-large-v3-turbo` | `groq.transcription` | `https://api.groq.com/openai` + `/v1/audio/transcriptions` |
| Mistral | `voxtral-mini-latest` | `mistral.transcription` | `https://api.mistral.ai` + `/v1/audio/transcriptions` |

Each `transcription` endpoint is unary POST with only `audio.transcription`.
Each provider gains exactly one audio-only card with its existing model prefix.
The declarations add no query, passthrough, fixed multipart boundary, mapped
origin, caller headers, token limits or new input profile. FormData and original
credential binding stay in the qualified codec and common controller. All
pre-existing Chat, embedding, auth, pricing and billing blocks remain unchanged.

The codec's existing primary evidence qualifies audio input and native wire
identity. Its Groq fixture records $0.04/hour and a ten-second minimum, but no
qualified billable duration or whole-upload admission bound. That observation
is not an executable request tariff. Mistral's returned model and
`usage.prompt_audio_seconds` are observations; they do not replace the selected
`voxtral-mini-latest` identity or qualify its alias tariff. Both cards therefore
omit pricing and pricing references, compiling to null prices. Hard-dollar
admission stays closed; an explicit policy-fixed charge remains distinct.

Mistral's frozen selector is preserved without a silent upgrade. The codec's
checked migration evidence contains no explicit shutdown date; this declaration
does not prove live availability. Groq preserves its supported prompt field;
Mistral rejects that field rather than discarding it or converting it to
`context_bias`. Translation, realtime and streaming remain separate contracts.

## Pending multipart registration

The common owner must publish the registry binding for these exact paired
formats and `transcription` endpoint IDs. The intended native paths are
`/v1/native/groq/v1/audio/transcriptions` and
`/v1/native/mistral/v1/audio/transcriptions`; the manifest paths are
`/v1/proxy/groq/transcription` and `/v1/proxy/mistral/transcription`. Parsed
native fields select the upstream ID; parsed manifest fields select the full
card ID. No new schema field is required by the existing compiler contract.

`worker/test/groq-mistral-transcription-declaration.test.mjs` composes the actual
YAML, parsed-field selection, landed multipart codec, complete response reader
and conservative budget checks. It uses the original four-byte fixtures only
for wire identity. These tests do not exercise HTTP multipart intake, fresh
owner checks, playable audio or actual client dispatch. Those proofs require
the common registered profile and the actual transcription consumer. Keep this
declaration local until both handoffs qualify; snapshot publication stays with
the existing integration owner.
