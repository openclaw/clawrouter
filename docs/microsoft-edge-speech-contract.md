# Microsoft Edge speech codec

This is the finite wire boundary for frozen OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/microsoft/speech-provider.ts`, and its exact
[`node-edge-tts@1.2.11`](https://www.npmjs.com/package/node-edge-tts/v/1.2.11)
dependency. The package archive matches the frozen lock integrity; its
`dist/edge-tts.js` SHA-256 is
`a3d4db15eba2ef8f208363c7c9d758a3df5ff63ca7991522bc2b64c83f7d84b3`.

There is no provider declaration, live handshake, route registration, host
service or activated speech integration in this change. Microsoft/Edge remains
distinct from Azure Speech.

## Codec contract

`worker/microsoft-edge-speech.ts` exports:

- `MICROSOFT_EDGE_SPEECH`: pinned destination, format and local capacity limits.
- `prepareMicrosoftEdgeSpeech(input, requestId)`: ordered, immutable
  `[speech.config, ssml]` strings for qualification or transport composition.
- `MicrosoftEdgeSpeechCodec(input, requestId)`: one isolated exchange with
  `nextRequestFrame()`, `receive(string | Uint8Array)`,
  `interrupt("timeout" | "abort" | "close" | "error")`, `takeAudio()` and `state`.

The input contains text and resolved native voice, lang, outputFormat, rate,
pitch and volume. Text and SSML attributes are escaped without changing their
values. Defaults match the frozen plugin: en-US-MichelleNeural, en-US, native
MP3 format, and default prosody. The client owner retains Chinese voice
selection, explicit voice overrides and settings resolution. This codec never
replays synthesis with a fallback format.

The only qualified output pair is
`audio-24khz-48kbitrate-mono-mp3` / `audio/mpeg`. Other formats fail before frame
creation. Arbitrary SSML, caller URLs, proxies, paths and credentials are not
input fields. Subtitle metadata is bounded and ignored; subtitle files are not
part of this unary audio result.

The runtime supplies a fresh 32-character lowercase hexadecimal request ID
for this admitted exchange. It retrieves and enqueues the two request frames
in order, once each. Retrieving a frame is **not** acknowledgement of a send,
acceptance, execution or billing. The runtime must not retry an uncertain send.

Every response frame must carry the exact X-RequestId. Binary messages have a
two-byte big-endian header length followed by bounded ASCII headers and audio.
Text messages have CRLF headers and a CRLFCRLF separator. Header names are
case-insensitive; duplicates, malformed lengths, missing IDs and foreign IDs
fail the exchange. Only binary Path:audio is audio. Its nonempty payload must
declare audio/mpeg. An empty audio delimiter may omit Content-Type; it is not
completion. Text paths are turn.start, response, audio.metadata and turn.end.
JSON metadata cannot masquerade as a path or establish a price.

Audio remains provisional until a bound Path:turn.end follows nonempty output.
`takeAudio()` transfers the bounded backing buffer once, with requestId,
mimeType and `upstreamCostMicros: null`. Early/late frames, malformed data and
interruption discard pending output. A normal socket close after a valid end
does not undo completion; the runtime still owns late-event retirement and
delivery. Frames are not accepted after completion or interruption.

## Bounds and transport handoff

| Surface | Local limit |
| --- | --- |
| Text UTF-8 | 16 KiB |
| Both outgoing messages | 64 KiB combined |
| Incoming header block | 4 KiB, 16 fields |
| Incoming text message | 64 KiB |
| Incoming binary message | 1 MiB including framing |
| Entire incoming exchange | 20 MiB, 8192 messages |
| Accumulated audio | 16 MiB |

These are router limits, not vendor entitlements. Transport admission must
reserve capacity before egress and account for the 16 MiB backing allocation,
incoming frames and delivery. The codec has no I/O, random source, clock,
AbortSignal listener or automatic timer. Source1 owns the deadline and invokes
interrupt when it expires, aborts, or closes before terminal completion. It
must close the original socket, retire late upgrades/events, and release its
capacity on every path. No interruption proves upstream work canceled or free.

The pinned upstream transport is WebSocket upgrade on
`https://api.msedgeservices.com/tts/cognitiveservices/websocket/v1` (wss on Node).
The dependency supplies a browser token, time-derived Sec-MS-GEC and Chromium
version. No real token or derived token is stored here. A future runtime owner
must qualify that handshake separately; no API-key account or Azure resource
is inferred. Voice discovery is a separate frozen HTTPS operation on
speech.platform.bing.com and is outside this synthesis codec.

Source5 owns this pure codec and sanitized fixtures. Source1 owns actual unary
HTTP-to-WebSocket dispatch, original caller/policy authority, admission,
deadline, cleanup and settlement. The current NativeResponse HTTP-reader ABI
does not provide that exchange. Source2 owns the actual native client. No new
host is inherently needed: the Worker already supports outbound upgrades,
but its OpenAI session controller is not an Edge controller.

## Proof and limits

`providers/_fixtures/microsoft/edge-speech.json` contains synthetic request IDs,
frame data and byte expectations, never a credential or captured prompt.
Tests cover request ordering/escaping, byte identity, two concurrent IDs,
timeout/abort/error/close, late and interleaved frames, malformed headers,
empty completion, wrong MIME, size bounds and floods. Synthetic audio is not
a playable voice sample or proof of live service acceptance.

Offline checks of the exact package found that its filesystem API leaves a
socket/writer open on timeout, its generator treats an error as normal EOF,
early generator return leaves a socket/timer open, and its binary substring
parser accepts malformed framing. This stricter codec does not copy those
behaviors. Its fixtures qualify deterministic interpretation, not a live
handshake or a guarantee that every provider response fits the accepted subset.

No dollar tariff or zero-cost assumption follows from a keyless browser
service. Unknown upstream-dollar hard budgets remain closed; policy_fixed is
a separate policy charge. Source1 retains uncertainty and exactly-once
settlement. No automatic replay or refund is authorized by a failed read.
