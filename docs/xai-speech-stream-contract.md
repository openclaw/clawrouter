# xAI streaming speech

Frozen source: `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/xai/tts.ts`. This is its single-utterance WebSocket path, separate
from unary speech, transcription and realtime voice conversations.

Primary [TTS documentation](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech),
checked 2026-11-03, specifies `wss://api.x.ai/v1/tts`, server Bearer authentication,
language/voice/codec/speed query, `text.delta`/`text.done`, and base64
`audio.delta` followed by `audio.done`. The native API supports multiple utterances
and `text.clear`/`audio.clear`; the frozen consumer closes after one utterance.
Billing is per session input characters. Disconnect has no documented zero-charge
guarantee. Default audio sampling is 24 kHz; no sample rate is observed on the wire.

## Codec handoff

`worker/xai-speech-stream.ts` exports `prepareXaiSpeechStream(value)` and
`XaiSpeechStreamConnection`. Preparation reuses unary validation, builds only the
native query and splits admitted text into UTF-16-safe 15,000-unit deltas. The
60,000-unit utterance cap is a local admission bound, not the vendor's WebSocket
limit. Five frozen codecs remain mp3/wav/pcm/mulaw/alaw. No secret, model alias,
custom-voice creation or dynamic session configuration is synthesized.

Construct one decoder from the admitted native request. Call `opened()` only
after the runtime qualifies the 101 upgrade. `client(wire)` accepts only the
prepared frame sequence, preventing a second utterance or changed text from
escaping its admission. Its return validates dispatch; it does not acknowledge
socket delivery. `server(wire)` emits provisional decoded bytes, a native
`done`/`error` terminal, and unknown upstream cost. `close()` records incomplete
transport without finalizing partial audio. All malformed frames close the local
decoder. No reconnect, text replay or remote cancellation is attempted.

The local limits are 16 MiB audio, 8,192 total frames and bounded JSON envelopes.
PCM alignment is checked on aggregate bytes so split samples retain byte identity.
Diagnostic text and byte lengths do not become billed characters or duration.
Native trace IDs are diagnostics, never caller/job authority. Payloads remain
transient and must not enter logs, receipts or durable accounting records.

## Activation owners

Proposed exact format: `xai.tts_stream` request/response, capability
`audio.speech`, WebSocket transport. This file does not activate a route.
Source 11.3 owns the existing xAI declaration/schema; source 11.1 owns the actual
Worker bridge, original credential/policy binding, admission before upgrade,
delivery acknowledgment, deadlines, backpressure, disconnect and one settlement.
Source 11.2 owns the real speech/Talk consumer; source 11.6 owns integrated proof.
The same utterance must not fall back to unary synthesis after uncertain dispatch.

Fixture: `providers/_fixtures/xai/speech-stream.json`; focused tests cover admitted
text identity, UTF-16 boundaries, provisional audio, duplicate completion, early
close/error, malformed and bounded frames, PCM chunks and unknown cost.
Unknown upstream-dollar hard budgets stay closed. Policy-fixed charging remains
separate. Public rates alone do not qualify normalized character counts, custom
voice charges, interruption debits or whole-session settlement. No live calls or
production deployment occur in this change.
