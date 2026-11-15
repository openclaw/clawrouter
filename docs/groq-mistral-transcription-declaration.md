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

## Shipping native catalog and registered consumer

The generated bundled snapshot includes both real YAML declarations. Each
`nativeProxy: true` endpoint advertises only its native offer:
`/v1/native/groq/v1/audio/transcriptions` or
`/v1/native/mistral/v1/audio/transcriptions`. The schema does not admit a
`nativeProxy: false` configuration for these formats. Direct manifest transport
coverage and constructed-catalog tests do not establish advertised client support.

[PR796](https://github.com/openclaw/clawrouter/pull/796), landed as
[`2f7855f`](https://github.com/openclaw/clawrouter/commit/2f7855f54b45f2f1a0e7c55951f0c4c7d8f76388),
qualifies authenticated multipart intake for these exact formats and endpoint IDs.
`worker/test/groq-mistral-transcription-declaration.test.mjs` retains its focused
codec and compiler checks. The new
`test/openclaw-groq-mistral-transcription.test.mjs` compiles all bundled manifests
before starting the actual Worker with SQLite storage. It verifies the unchanged
shipping catalog, original server-owned provider grants, multipart wire bytes,
complete response validation and explicit policy-fixed settlement. Vendor prices
and token usage remain unknown; hard-dollar requests cannot use that fixed charge
as a fabricated audio tariff.

The hosted consumer pins public
[OpenClaw PR192558](https://github.com/openclaw/openclaw/pull/192558) at
`6de028c4e960db91bdf87882989cb6756a6429c3`. It calls the exported
`transcribeAudioFile` through the actual registered ClawRouter plugin, without
constructed offers, direct adapter injection or a mocked global fetch. Thirty
cases cover both native models: Unicode text, locked proxy profiles, key rotation,
revocation after discovery, policy denial, unknown-price denial, malformed,
partial, error, redirect and truncated responses, unsupported inputs and caller
cancellation. Original response reads, cancellation and dispatcher close promises
are retained and joined; cleanup errors do not replace earlier failures.

The held-response case distinguishes caller rejection from controlled cancellation
of the original Worker request. That control operation and its joined upstream
reader do not prove that the client disconnect propagated through the service
binding. Local Worker checks do not execute the pinned SDK. Actual SDK compilation,
all thirty registered-consumer cases and the outer SQLite/cleanup assertions remain
unqualified until the hosted consumer runs successfully. No live vendor service,
manifest-route client support, deployment or full-client parity is claimed.
