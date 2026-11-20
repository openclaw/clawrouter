# Mistral realtime transcription

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/mistral/realtime-transcription-provider-factory.ts`, selects
`voxtral-mini-transcribe-realtime-2602`. This is native transcription over
WebSocket, separate from unary multipart, OpenAI Realtime and speech generation.
No Voxtral 3 model, new diarization/turn-detection product or browser credential
flow is inferred from the frozen provider.

`worker/mistral-realtime.ts` exports `prepareMistralRealtime`,
`MistralRealtimeConnection`, `mistralRealtimeModel` and `mistralRealtimePath`.
It supplies deterministic wire validation and transient connection state only.
It does not open sockets, execute reconnects, select credentials or settle money.

## Native wire

Upgrade to `wss://api.mistral.ai/v1/audio/transcriptions/realtime` with query
`model=voxtral-mini-transcribe-realtime-2602` and
`target_streaming_delay_ms=800` by default. Authentication is the selected server
`MISTRAL_API_KEY` in native Bearer form. The codec returns no credential, caller
URL override or alternate account. Query model and configured audio format stay
fixed for the connection.

After `session.created`, send one `session.update` with
`session.audio_format.encoding` and `sample_rate`. The default is mono 8kHz
`pcm_mulaw`; the six frozen encodings are pcm_s16le, pcm_s32le, pcm_f16le,
pcm_f32le, pcm_mulaw and pcm_alaw. Local sample-rate bounds are 8–48kHz and target
delay 1–10,000ms; these parser bounds do not certify every vendor combination.

Wait for a matching `session.updated` before forwarding audio. The frozen client
marks ready immediately after sending its update; the shared bridge must queue
until acknowledgment instead of treating a local send as accepted configuration.
The official SDK exposes both created/updated events and the native audio-format
contract. Do not weaken that binding when connecting the actual client.

`input_audio.append` carries canonical base64 with at most 64KiB aligned samples.
No container decoding or resampling is performed. `input_audio.flush`, then
`input_audio.end`, finish input but do not complete the response: keep draining
until native `transcription.done`, an error or a bounded runtime deadline.
Audio and configuration updates after end are rejected. There is no qualified
remote cancel action; closing delivery is not a vendor refund or cancellation.

The observer preserves native usage and model metadata. It accumulates text
deltas under the frozen 256KiB UTF-8 limit, emits final segments, then emits only
new remaining speech on done. Full terminal text cannot replay completed
segments; punctuation-only tails do not duplicate them. Errors clear pending
text. Disconnect without done does not promote a partial transcript to success.
Frames are limited to 1MiB, connections to 8192 observed client/server messages;
runtime owns tighter time, queue, capacity and total-byte budgets. Protocol
rejection requires the shared bridge to close the affected connection.

## Ownership and billing handoff

Source 11.1 must reuse existing caller/policy/credential and reservation/outbox
machinery for the original socket. Admit before audio egress, preserve dispatch
uncertainty, and settle once on a qualified terminal or conservative incomplete
outcome. Never replay uncertain audio on reconnect or change credential lineage.
No second global session store or unscoped provider session-ID route is added.

`transcription.done` usage may contain audio seconds and token fields. These are
observations; no cumulative/delta or billable-duration equivalence is invented.
No tariff for this exact frozen model is activated here. Unknown upstream-dollar
hard budgets stay closed; policy-fixed charges remain distinct from actual
upstream costs. Errors, missing usage and socket close do not prove free work.

Source 11.3 owns existing Mistral YAML/schema; proposed request/response format
`mistral.realtime_transcription` denotes this exact native protocol. Source 11.2
owns audio conversion, transport readiness, bounded pending audio and actual
transcript callbacks. Source 11.6 owns real Worker/client socket proof. This
module and its synthetic fixture do not activate a catalog route or API badge.

Current Mistral docs place this frozen model in legacy guides and map it to a
Voxtral 3 replacement. The inspected migration timeline gives no explicit
shutdown date. Preserve the frozen identity and qualify availability before live
activation; do not silently substitute a new model or infer endpoint removal.

Fixture: `providers/_fixtures/mistral/realtime.json`. Its aligned synthetic bytes
prove encoding/state handling, not playback, accuracy or measured audio duration.
No live call, token provisioning or deployment occurred.

Primary sources checked 2026-11-03:

- [Legacy native realtime model and encoding usage](https://docs.mistral.ai/studio/audio/deprecated/speech_to_text/realtime_transcription)
- [Official connection implementation and event models](https://github.com/mistralai/client-python/blob/main/src/mistralai/extra/realtime/connection.py)
- [Official native endpoint construction](https://github.com/mistralai/client-python/blob/main/src/mistralai/extra/realtime/transcription.py)
- [Voxtral migration contract](https://docs.mistral.ai/studio/audio/migrate-from-voxtral-2)
