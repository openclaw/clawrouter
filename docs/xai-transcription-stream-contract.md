# xAI realtime transcription

Frozen source: `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/xai/realtime-transcription-provider-factory.ts` and its metadata.
This is raw-audio WebSocket transcription, separate from speech synthesis and
the bidirectional voice assistant. The frozen client does not choose a model.

Primary [STT protocol](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text),
checked 2026-11-03: `wss://api.x.ai/v1/stt`, server Bearer authentication,
query configuration, binary audio after `transcript.created`, then JSON
`audio.done` to obtain `transcript.done`. Chunk-final text is locked; an
utterance-final already contains its stitched text. Terminal duration is seconds.
The documented service default is `grok-voice-transcribe-2.0`; preserve model
omission, rather than silently adding that selection. The current
[pricing page](https://docs.x.ai/developers/models) distinguishes streaming
$0.20/hour from batch $0.10/hour. These are evidence, not activated tariffs.

## Source interface

`worker/xai-transcription-stream.ts` exports
`prepareXaiTranscriptionStream(query)` and `XaiTranscriptionStreamConnection`.
Require the frozen client's explicit sample_rate, encoding, interim_results and
endpointing; allow optional language. Preserve exact query values, including its
8 kHz/mulaw/true/800 defaults. Three frozen encodings and six documented sample
rates are qualified. Reject duplicate/unknown parameters, credentials, model
selection, extra channels and newer Opus/formatting features.

Construct a decoder for each admitted connection. `opened()` follows the qualified
upgrade; binary input still waits for native readiness. `clientAudio(bytes)`
returns an isolated, byte-identical copy. `client(wire)` accepts only audio.done.
These methods validate dispatch; they do not attest receipt by the provider.
`server(wire)` exposes partial text, distinct complete utterances, and a terminal
whole-session transcript. The latter replaces a transcript display; it must not
be appended to previously emitted utterances. Identical successive native
utterances are not deduplicated solely by text. Native bodies stay transient.

The decoder closes on a protocol error, including vendor errors that a broader
native client might recover from. Local closure discards locked partial state;
it does not synthesize an utterance final, reuse that state on reconnect, refund
the session or replay input. A new connection requires fresh admission.

Local bounds: 64 KiB audio frames, 16 MiB total audio, 32,768 frames, 1 MiB JSON,
256 KiB transcript accumulation and finite nonnegative duration up to 24 hours.
PCM input is sample-aligned. These are router limits, not vendor limits. Duration
is qualified only from a terminal native observation; validated input bytes are
not billing usage. No interrupted charge, rounding or account-specific price is
inferred. Unknown upstream-dollar hard budgets stay closed; policy-fixed charging
is a separate basis.

## Activation handoff

Proposed format: `xai.stt_stream` request/response, WebSocket
`audio.transcription`. Fixture: `providers/_fixtures/xai/transcription-stream.json`.
This codec does not activate the endpoint or claim actual consumer parity.

Source 11.1 owns upgrade admission, original credential/policy binding, real
socket dispatch acknowledgment, pacing/backpressure, deadlines, close behavior
and settlement. Source 11.3 owns the existing provider/schema and duration tariff
qualification. Source 11.2 owns the native consumer, including replacement
transcript semantics and removing automatic audio replay across proxy reconnects.
Source 11.6 owns integrated Worker/client proof. No deployment or live call.
