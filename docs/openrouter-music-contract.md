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

The leaf bounds request JSON to 256 KiB before the existing codec clones it,
retaining the 32,768 UTF-16 prompt limit. It quarantines at most 4 MiB of native
SSE wire with 8,192 reads and 8,192 events (including empty reads and heartbeat
events), 256 KiB accepted frames with at most 32 lines, 2 MiB decoded audio and 128 KiB UTF-8
transcript. Encoded audio is bounded before decoding. A 32 MiB response lease
charges 64 MiB in the existing 96 MiB pool, covering quarantine, parser and JSON
scratch, base64 copies, decoded validation audio and replay; ingress keeps its
separate charge. Replay uses bounded views into the same quarantine, and common
dispatch retains the lease through delivery or cancellation. These are deliberate
smaller local limits, not duration or upstream-fee guarantees.

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

Payload lifetime within the 64 MiB charged response lease:

| Phase | Retained payload and bounded scratch | Release point |
| --- | --- | --- |
| Preparation | Original JSON remains with common ingress; at most 256 KiB JSON and 32,768 UTF-16 prompt units. Codec cloning/serialization adds less than 1 MiB for this text-only shape. | Prepared request stays with the leaf through validation; ingress has its separate reservation. |
| Quarantine | One 4 MiB buffer; one accepted upstream chunk at most 4 MiB; shared framing buffer at most 2 MiB and decoded framing string at most 4 MiB. Accepted frames are only 256 KiB, at most 32 lines before split/JSON allocation. No decoded audio is retained in this pass. | Reader canceled/released at native terminal or failure; framing/JSON scratch is not returned. |
| Codec validation | Same 4 MiB quarantine replayed in 64 KiB views; bounded frame/JSON scratch; at most 2,796,204 encoded audio characters. Budget includes UTF-16 concatenation/canonical-base64 copies, the temporary decoded string and at most 2 MiB validated audio, plus 128 KiB transcript. | Codec observation is discarded after validation. No observation audio/transcript is captured by the output stream. |
| Delivery | Only the same quarantine buffer and 64 KiB views are retained by replay; common SSE inspection is bounded. | Common observer releases the response lease on completion, cancellation or failure. |

The 64 MiB charge reserves headroom for transient JSON objects, string copies
and parser scratch; it is not a measured JavaScript heap or GC guarantee. Byte,
frame, line and read bounds remain enforced independently of Content-Length.
An oversized incoming transport chunk is rejected before copying into quarantine;
transport allocation itself remains common runtime responsibility.

Offline fixtures include MP3 at 2,096,640 bytes (6,289,920 decoded PCM bytes) and
PCM WAV at the exact 2,097,152-byte audio cap (2,097,108 decoded PCM bytes), plus
the small containers above. They are generated/repeated test audio, not vendor
inference. The HTTP response remains SSE for both requested formats; no binary
MIME is guessed from base64. The codec checks native protocol completeness,
not acoustic validity of arbitrary returned audio.

This is not full frozen music parity. The frozen client defaults to WAV and
permits a 180-second request; neither that duration nor image-conditioned music
is qualified by the smaller prompt-only leaf. Restoring original codec limits
(16 MiB decoded audio / 32 MiB wire, one reference image) is an internal original
E12 dependency, not an external-entitlement blocker or a new product:

- Source5/source1 must agree a codec validation mode that checks fragmented
  base64 and terminal state without retaining the whole base64 stream and
  materializing `OpenRouterMusicObservation.audio`. The current mandatory
  audio-returning reader cannot safely fit those original limits plus 32 MiB
  quarantine and ingress in this lease by merely raising constants.
- Source1 must qualify the corresponding original-ingress/quarantine/replay
  capacity lifetime (or an explicit larger-capacity mechanism), including
  bounded transport reads and the image body's extra copies. The existing
  parameterless `acquire()` alone does not establish that larger combined
  allocation. The existing request codec also clones/serializes image JSON.
- Original image bytes/references need source1's asset/destination authority
  contract and source5's byte validation before the text-only exclusion can
  open. Caller URLs, uploaded IDs or an unqualified boolean supply no authority.
  Source2's actual frozen consumer and source6's composed proof must exercise
  the restored surface.

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

This codec continuation does not raise the landed response leaf's limits.
At reviewed main `ecefad76f02039e57e11967b2e02a9a71483cd12`,
`validateSelectedInput` has no music factory registration. Source1 must publish
the qualified common-path composition so a real Worker fetch can prove BYOB
support through every intervening wrapper before larger quarantine activation.
An isolated byte-stream fixture cannot substitute for that proof. The planned
32 MiB fixed quarantine must never be passed as detachable BYOB backing;
only a separate bounded window may follow the reader's returned-view ownership.
Source5 can qualify scalar inspection independently while original image
ingress/ownership and common delivery qualification remain required internal work.

Primary evidence checked 2026-11-03:

- [Native Chat audio output and SSE](https://openrouter.ai/docs/guides/overview/multimodal/audio)
- [Frozen Pro identity and song price](https://openrouter.ai/google/lyria-3-pro-preview)
- [Frozen Clip identity and clip price](https://openrouter.ai/google/lyria-3-clip-preview)
