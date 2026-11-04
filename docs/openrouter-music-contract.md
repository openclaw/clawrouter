# OpenRouter Lyria streaming music

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/openrouter/music-generation-provider.ts`.
Finite models: `google/lyria-3-pro-preview`, `google/lyria-3-clip-preview`.
No automatic substitution with direct Google credentials, newer Lyria or other
audio models is allowed.

`prepareOpenRouterMusic(model, body)` preserves native JSON
`POST /api/v1/chat/completions`: one user message, `modalities:["text","audio"]`,
`audio:{format:"wav"|"mp3"}`, `stream:true`. Lyrics, instrumental instructions
and target duration are already composed into the frozen client's prompt. They
are instructions, not enforceable duration or fee bounds. Do not invent native
duration fields or imply that one requested track guarantees one billed track.
One optional ordered image follows the text, either bounded inline PNG/JPEG/WebP
or an opaque HTTPS upstream reference. The router never fetches that URL or
sends credentials to it. Upload/file IDs, additional tracks/tools/options and
newer model IDs are closed. Input text is bounded to 32,768 UTF-16 units; inline
image bytes to 8 MiB; request JSON to 12 MiB.

`OpenRouterMusicStream` consumes SSE data payloads. `readOpenRouterMusic`
uses the existing strict `createSseFrames` parser, with 2 MiB frames, 8,192 data
events, 32 MiB wire data, 16 MiB decoded audio and 1 MiB transcript limits.
These are local bounds. The frozen client permits larger configured media;
larger single events need a separately qualified shared parser limit, not silent
truncation or a second parsing framework.

`delta.audio.data` fragments form one base64 stream; decode after assembling
the bounded sequence, preserving split quartets. Transcript fragments concatenate.
Native `[DONE]` is required; socket EOF alone cannot complete the result. A
native finish reason, when supplied, must be `stop`. Audio after stop, conflicting
generation/model identity, provider errors, filtered output, invalid UTF-8,
malformed base64 and post-terminal data invalidate success. On `[DONE]`, cancel
the remaining transport instead of waiting indefinitely for EOF. The original
deadline/caller signal interrupts a stalled body. No reconnect, retry, synthetic
terminal, remote cancel promise or refund is inferred.

Native usage and the bounded generation ID are transient diagnostic evidence;
neither is authority for another request. `upstreamCostMicros` stays null.
Public model pages list $0.08/song for Pro and $0.04/clip for Clip, but those are
evidence for source3 tariff qualification, not an activated fee or preflight
bound. Failed/incomplete delivery does not prove free generation. Keep unknown
upstream-dollar budgets closed; policy-fixed charging is separate. Synthetic
audio verifies byte transport, not sound quality or a live inference.

Source3 owns existing OpenRouter declarations/model pricing. Reuse the actual
`openai.chat_completions` SSE wire for `music.generate` with the focused audio
observation contract; do not count binary audio as ordinary completion text.
Source1 owns original origin/credential selection, dispatch acknowledgment,
admission, body reservation, deadlines and settlement. Source2 owns the actual
music consumer; source6 owns native acceptance. No route activation or completed
parity is claimed by this source codec.

Exports: `openRouterMusicModels`, `prepareOpenRouterMusic`,
`OpenRouterMusicStream`, `readOpenRouterMusic`.
Fixture: `providers/_fixtures/openrouter/music.json`.
Checks: `node --test worker/test/openrouter-music.test.mjs`.

The partial original E12 response leaf exports
`prepareNativeOpenRouterMusic(selection: ProxySelection): NativeResponse | undefined`
from `worker/native-openrouter-music.ts`. Invoke it before generic Chat
validation. It binds explicit `music.generate`, the selected frozen model,
`openai.chat_completions` request/response with SSE, configured base
`https://openrouter.ai/api` and endpoint `/v1/chat/completions`. The final
destination is `https://openrouter.ai/api/v1/chat/completions`. It neither
changes the request body nor selects credentials or a direct Google fallback.
This leaf accepts text-only messages; every image/reference remains closed
pending original asset authority. The standalone codec's larger input surface
does not grant that authority.

The output-only continuation keeps request JSON at 256 KiB before the existing
codec clones it, retaining the 32,768 UTF-16 prompt limit. It restores the
original 32 MiB wire, 16 MiB audio and 1 MiB transcript bounds through
`createOpenRouterMusicInspector`, without accumulating base64, decoded audio or
transcript. All 262,144 reads and 8,192 events, including heartbeat events, are
bounded; frames remain at most 2 MiB with at most 32 lines. The original codec's
default audio-returning reader is unchanged.

A 32 MiB response lease still charges 64 MiB in the existing 96 MiB pool.
Quarantine uses one fixed 32 MiB allocation and a **separate** 64 KiB BYOB
window. Every next read follows the returned view's buffer ownership; quarantine
is never passed to a reader as detachable backing. Reads have no minimum-fill
requirement, so a small native terminal on an open socket can complete. A
non-BYOB body fails conservatively; there is no default-reader allocation
fallback. Replay copies at most 64 KiB into a consumer BYOB view or a fresh
bounded output window. It never enqueues a borrowed quarantine view into a byte
controller. Common dispatch retains the lease until delivery or cancellation.
These are payload bounds, not duration or upstream-fee guarantees.

Only complete HTTP 200 native SSE with real `[DONE]` is replayed. Socket EOF
alone, errors, malformed UTF-8/base64, inconsistent native identity, overflow or
interruption release no partial response. The upstream transport is canceled at
the native terminal; the wrapper never resubmits generation. LF/CRLF framing and
one data line per event preserve compatibility with the frozen client's reader.
Multiline data events, CR-only framing and any top-level `error` field or
`event:error` are rejected, including `error:null`, which the common error
sniffer would otherwise classify as a rejection. Identity encoding preserves
exact original Content-Length checks; other encodings and ranges are closed.

The response remains the original SSE bytes with native usage frames intact,
not a binary audio response or a synthesized terminal. Local MP3/WAV test
containers are decoder-verified test audio, not native synthesis evidence.
Validated usage is `{tokens:null,outcome:"success"}`; no invoice/cost receipt is
created from native diagnostics. Failed or canceled delivery retains common
conservative settlement. Unknown hard-dollar admission stays closed; explicit
policy-fixed charging is separate. Source1 still owns factory wiring, the
generic Chat bypass guard, original grant/model routing, admission and settlement;
source2/source6 own actual-client and Worker acceptance. This leaf does not
activate a route.

Payload lifetime within the existing 64 MiB charged response lease:

| Reservation | Retained payload and explicit transient copies | Release point |
| --- | --- | --- |
| 32 MiB | One fixed original-wire quarantine; no chunk list, geometric resize or final whole-wire copy. | Delivery EOF, cancellation or failure. |
| 16 MiB | Shared SSE framing buffer and its bounded growth copy, decoded frame/data strings and at most 32 line views. Frames are at most 2 MiB. Root-key scanning uses the existing tokenizer in 1,024-unit feeds without a second parsed object graph. | Each frame; no frame/data strings escape quarantine. |
| 8 MiB | One structurally bounded JSON event parsed by the inspector; transient bounded usage serialization and the last diagnostic usage record. No aggregate base64/audio/transcript is retained. | Each event; inspector is discarded at validated terminal. |
| 8 MiB | Separate 64 KiB BYOB transport window, returned view, bounded delivery copy, text-only request preparation and parser/window headroom. Delivery also covers the existing bounded common SSE observer/sniffer scratch. | Transport reader is canceled/released at terminal/failure; replay and common observer end at delivery EOF/cancel. |

Ingress remains separately charged: a 16 MiB ingress charge plus this 64 MiB
response charge is 80 MiB within the existing 96 MiB pool. The ledger accounts
for reachable payloads and explicit copies; it is not a measured heap or GC
guarantee. Wire/frame/structure/read bounds apply independently of Content-Length.
Actual network BYOB support must survive every common wrapper; a synthetic byte
stream alone cannot qualify this larger response path.

Offline decoder-verified fixtures include a 16,777,216-byte PCM WAV with
16,777,172 decoded PCM bytes and a 16,776,576-byte repeated MP3 with 50,329,728
decoded PCM bytes, both 24 kHz mono test audio. Small and former partial-leaf
fixtures remain. The HTTP response stays SSE for both requested formats; no
binary MIME is guessed from base64. Protocol completeness does not establish
acoustic validity of arbitrary upstream audio, a live synthesis, or a duration
promise.

This remains partial original E12 until common dispatch and actual-client proof
qualify. The frozen client defaults to WAV and permits a 180-second request;
restored output bounds alone do not prove every such result fits. Reference-image
ingress and ownership remain a separate **internal original dependency**:
`prepareOpenRouterMusic` accepts one image and clones/serializes its JSON, while
this leaf continues rejecting every image/reference. Source1 must qualify those
copies and original asset/destination authority; source5 must qualify input
bytes. Caller URLs, uploaded IDs or an unqualified boolean grant no authority.
Source2's frozen consumer and source6's composed proof must exercise that surface.

Focused leaf checks: `node --test worker/test/native-openrouter-music.test.mjs`.

An independent codec continuation exports
`createOpenRouterMusicInspector(request: OpenRouterMusicRequest)`, with
`accept(data: string)`, `isDone()` and `result()` methods. Its result is
`{audioBytes, transcriptBytes, format, usage, responseId, upstreamCostMicros:null}`.
It retains neither a whole base64 stream nor decoded audio nor transcript.
Canonical base64 is checked across fragments with quartet position, final sextet
and padding state; tail bits, split padding and unpadded final quartets obey the
existing codec's contract. Transcript validation retains only a pending high
surrogate and the original per-fragment UTF-8 byte count.

Inspection keeps the original 16 MiB audio, 1 MiB transcript, 8,192 data-event
and 2 MiB frame bounds. The existing tokenizer bounds JSON amplification before
parsing: depth 32, 4,096 nodes/properties, 128 fields per object, 256-unit keys
and 128-unit numeric literals. Existing `OpenRouterMusicStream` and
`readOpenRouterMusic` default behavior and assertions remain intact, including
their decoded output and image-request syntax. The inspector consumes decoded
data events; its caller still owns fatal UTF-8 framing, wire limits, original
terminal/cancellation lifetime and the response lease. Native usage is diagnostic,
not an invoice or pricing authority.

The scalar inspector landed independently in PR783. The full-output wrapper
must compose with source1's PR784 common selector/factory route and pass actual
workerd fetch, full-size delivery, cancellation and lease-release proof before
publication or activation. `worker/test/native-openrouter-music-workerd.test.mjs`
uses that published composition's fixture declaration and the real Worker
entrypoint. It streams original wire to the host for hashing rather than
materializing a second full response inside the router isolate. Common runtime,
auth, pricing, declarations, snapshots and actual-client acceptance remain with
their existing owners.

Primary evidence checked 2026-11-03:

- [Native Chat audio output and SSE](https://openrouter.ai/docs/guides/overview/multimodal/audio)
- [Frozen Pro identity and song price](https://openrouter.ai/google/lyria-3-pro-preview)
- [Frozen Clip identity and clip price](https://openrouter.ai/google/lyria-3-clip-preview)
