# Google Live voice contract

Source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/google/realtime-voice-provider.ts`, `realtime-voice-model-contract.ts`
and `realtime-voice-metadata.ts`. This is a native WebSocket protocol, not OpenAI
Realtime or unary text-to-speech. `worker/google-live.ts` supplies setup validation
and connection-local frame validation; it does not open a socket or activate a
provider route. `providers/_fixtures/google/live.json` is sanitized synthetic wire
evidence, not a live audio, tariff or deployed compatibility proof.

Primary sources checked 2026-11-03:

- [Live WebSocket reference](https://aistudio.google.com/api-reference/live)
- [Live session endpoint](https://aistudio.google.com/api-reference/live/bidi-generate-content)
- [Model retirement dates](https://aistudio.google.com/docs/deprecations)
- [Native usage and current price evidence](https://aistudio.google.com/docs/pricing)

## Frozen model and wire boundaries

The selected server origin is `https://generativelanguage.googleapis.com`. Upgrade
to WSS at `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`.
The first message is native `setup`, with `model:models/<id>` and AUDIO generation
configuration. The SDK moves speech/thinking/temperature settings under
`setup.generationConfig`; sending its flat shorthand directly is not equivalent.
The wrapper supplies no key, query credential, ephemeral token or alternate host.

| Frozen model | Text input | Tool and completion contract |
| --- | --- | --- |
| `gemini-3.1-flash-live-preview` | `realtimeInput.text` | Sequential tools; no NON_BLOCKING or continuing responses |
| `gemini-3.8-live` | Completed `clientContent` user turn | No thinking configuration; NON_BLOCKING permits continuing responses |
| `gemini-3.8-live-extended-thinking` | Completed `clientContent` user turn | NON_BLOCKING tools required; no scheduling/continuation; turnComplete needs IDLE or observed interruption |
| `gemini-2.5-flash-native-audio-preview-12-2025` | Completed `clientContent` user turn | Legacy thinking budget and explicit input-transcription finished flag |

The two preview models have a published earliest retirement date of 2026-11-17.
The codec conservatively ends their qualification at 00:00 UTC that day; this is
a local cutoff, not a claim about Google's exact shutdown time zone.
`gemini-live-2.5-flash-preview` retired 2025-12-09 and is rejected. No automatic
replacement, new transcription/translation model or newer inventory is added.
Voice names remain bounded native identifiers; syntactic acceptance does not
assert availability of every voice. Extended Thinking maps only native
LOW/MEDIUM/HIGH; any consumer preference conversion remains client-owned.

`prepareGoogleLiveSetup` accepts native text system instructions, bounded function
declarations, voice/VAD/thinking configuration and empty initial session-resumption
and sliding-window settings. Arbitrary search tools, transcription upgrades,
caller resume handles and unknown setup fields are rejected. The frozen Extended
Thinking client can emit ordinary tools without NON_BLOCKING; those are rejected
until the client sets the model-required behavior, not silently rewritten.

## Frames and connection ownership

Create one `GoogleLiveConnection` from the validated setup for each original
connection. Runtime must send setup once and wait for both an actual open socket
and native `setupComplete` before draining any input queue. The codec gates on
setupComplete only; it cannot attest socket readiness or dispatch acknowledgment.
Parse a complete native text WebSocket message, not a transport fragment.

Input is aligned mono PCM16 at 16kHz, at most 64KiB per frame. Output is aligned
PCM16 at 24kHz, bounded by the 1MiB JSON frame. Standard or URL-safe canonical
base64 is validated before publishing any audio. The codec does not resample,
convert G.711, play audio or infer timestamps, duration, token counts or cost.
Every silent 3.8 input frame remains intact: audioStreamEnd does not finish that
model's turn. Manual activity signals require disabled automatic VAD. Other
models retain native audioStreamEnd. Model-turn text is not substituted for the
separate canonical input/output transcription events.

Tool call IDs must be present and bounded, declared names must match, and replies
must belong to the same original connection. No synthetic IDs are invented.
Duplicate calls never execute again; canceled/completed calls cannot accept late
results. A complete frame is validated before any output or ownership update.
The 1024-ID bound never evicts old dedupe entries. Session messages are bounded to
4096; the runtime owns stricter time, byte, queue and capacity limits. Any protocol
rejection requires the runtime to stop forwarding and close the affected socket;
the codec does not repair malformed messages or authorize a retry.

`interrupted` clears playback but is not a successful remote cancellation or
refund. `generationComplete` alone does not close a response. Extended Thinking
may emit turnComplete while IN_PROGRESS; wait for IDLE or prior interruption.
Google has no `response.cancel` equivalent. A best-effort client-content interrupt
can produce later audio, so it must not be represented as guaranteed silence.

## Shared runtime and consumer handoff

The current ClawRouter realtime controller is OpenAI-specific. Source-owned work
must add native Google dispatch using the existing caller/policy/credential,
reservation and settlement machinery. No second global session/job index:

- 11.1 owns authenticated WebSocket upgrade, selected credential/origin, fresh
  admission and bounded queues before generation-producing input. Google VAD can
  generate without OpenAI `response.create`; input forwarding is not free.
- The original connection owns resumption handles and pending tool IDs. Preserve
  caller/policy/model/credential lineage and dispatch uncertainty through any
  reconnect. Raw handles remain transient private server data. No blind audio,
  text or tool-result replay; reuse across sockets needs explicit continuity
  proof. This codec deliberately does not restore or persist connection state.
- Usage observations remain native metadata, with no cumulative/delta assumption
  or automatic sum. Modality, cached input, context recomputation, interrupted
  responses and settlement identity need qualified native accounting and tariffs.
  Unknown upstream-dollar hard budgets stay closed. Explicit policy-fixed
  charging, if qualified by the runtime, is separate from actual upstream cost.
- 11.2 owns frozen client audio conversion, playback/backpressure, transcript
  accumulation, tool execution, original connection readiness and interruption
  behavior. 11.3 owns existing Google declarations; 11.6 owns actual Worker/client
  acceptance. Missing pricing evidence blocks live cost proof, not these codecs.

The frozen browser client requests single-use ephemeral credentials through the
SDK's v1alpha constrained endpoint. Current native auth-token documentation is a
separate contract. This slice neither mints tokens nor exposes server credentials.
An authenticated ClawRouter bridge must bind caller, model, credential, expiry and
budget before browser support. Do not alias the constrained endpoint to server
v1beta or advertise browser parity from a static token fixture.

Activation still needs real socket/Worker tests, native client playback/tool tests,
selected-grant privacy checks, model/capability admission and final settlement
proof. Close, goAway, usage absence, canceled tools or lost resumption are never
evidence that upstream work was free. No live call or production deployment is
performed by these deterministic tests.
