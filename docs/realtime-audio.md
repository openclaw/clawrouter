# Bounded GA Realtime audio

Server-to-server bearer WebSockets at `/v1/realtime?model=gpt-realtime-2.1`.
No browser/WebRTC, subscription transport, hosted tools, or automatic replay.
This is a bounded service path, not full native Talk/bridge parity.

## Turn ownership

Explicit full session policy is required before media. PCM16 mono 24kHz and
PCMU mono 8kHz are supported; input and output codecs must match. The native
server-bridge default shape is accepted: server VAD, mini input transcription,
audio output, named function definitions and automatic tool choice. The omitted
output cap is narrowed to 4096, never an unlimited vendor default.

The proxy disables both vendor response-auto flags and idle timeout while
retaining VAD speech/commit events. It creates and cancels responses itself,
only after fresh caller/model/policy/grant/account authority and budget admission.
Native partial VAD-flag updates are local transitions; effective ACKs truthfully
report the effective proxy-owned flags, while upstream ACKs must confirm both
vendor flags remain disabled. Partial patches merge with the effective policy;
a pending full update excludes local toggles until its ACK. Unknown billable
events fail closed.

Barge-in cancellation retires the old response before another response is funded.
Provisional function arguments do not authorize a tool result: only a completed
owned response does. One output per call is supported; streaming/multiple outputs
for one call and out-of-conversation speech are not. Clients must await buffer
clear ACK before appending more audio. Cancel-after-terminal is a correlated,
nonterminal invalid-request error; a subsequent explicit request is allowed.

## Separate input-transcription accounting

`gpt-4o-mini-transcribe` input transcription is available only with an explicit
soft budget policy. Its own model must be allowed, not merely the Realtime model.
Each input buffer owns a separate unit before its first byte leaves the proxy.
Committed item IDs bind asynchronous ASR terminals, including out-of-order
completion; identical terminals cannot charge twice. Delayed VAD commits consume
only their audio-time boundary, retaining already-forwarded trailing media.
Manual responses and tool continuations use the committed conversation without
consuming or blocking on that next VAD input buffer; no-VAD media still requires
an explicit commit before a response. Every response retains fresh admission.
Fresh soft admission precedes the first ASR byte. Continuing media coalesces
socket-local authority and soft-budget observations for at most 100ms, measured
from observation start, not completion. Config changes, new response/input
funders and the independent 5-second periodic guard always recheck authority;
funded units are owned and rechecked after the funding await before egress.
The first ASR byte is therefore serial authority, funded soft admission and
authority; its budget lease starts when that funding observation starts. ASR
cadence is qualified with 40ms authority and 30ms ledger RPCs; at 50/30ms the
blocking re-observations can exceed the shared 16-event queue and close the
session with `queue_limit` (fail closed; no unadmitted media is sent). Media
without ASR tolerates authority RPCs below the 100ms lease (tested at 90ms).
Per-item child receipts inherit the admitted media attribution and budget
windows, with unique once-only charge IDs.
These are soft reporting receipts, not new post-execution hard reservations.

Input transcription is billed separately from the Realtime response. Its token
usage is attributed to `audio.transcription`, model `openai/gpt-4o-mini-transcribe`,
with `realtime_usage.item_id`. Published input/output rates are 1.25/5 microUSD
per token; quarter-micro arithmetic rounds once per unit. Missing, malformed,
failed or disconnected soft usage is explicitly `unpriced_usage`, not evidence
of free execution. Soft mode is not hard capacity enforcement.

There is no qualified whole-input ASR hard-budget envelope. Hard mode returns
`pricing_required` before enabling ASR, including with a fixed-zero tariff.
Hard VAD without ASR remains supported: reserve the full 128000-input/4096-output
highest-modality response bound, then settle exact valid native modality usage.
Missing hard response usage retains the bound, never a fixed-zero refund.

## Limits and qualification

Existing limits remain: 120-second sessions, 30-second idle, 64 response turns,
256 retained identities, 4096 events, 64KiB frames, queue 16/256KiB, aggregate
input 4MiB/output 8MiB and uncommitted decoded input 960000 bytes. Native 20ms
media chunks do not each consume a retained control identity. The existing 4096
bidirectional-event cap can terminate continuous 20ms duplex traffic well before
120 seconds; the session duration is a ceiling, not a sustained-audio guarantee.
No durable reconnect resumption, paid-provider integration or physical/native
audio proof is claimed.

Source-qualified on 2026-10-20 against OpenAI mini-transcribe model/pricing page,
Realtime VAD/conversation and voice-cost guides, and the official openai-node
Realtime schema. Upstream protocol changes require requalification; synthetic
WS + production router + private SQLite tests do not attest live acceptance.

- https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe
- https://developers.openai.com/api/docs/guides/realtime-vad
- https://developers.openai.com/api/docs/guides/voice-latency-cost?voice-api=realtime
- https://github.com/openai/openai-node/blob/master/src/resources/realtime/realtime.ts
