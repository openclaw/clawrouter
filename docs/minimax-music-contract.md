# Frozen MiniMax music streaming contract

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/minimax/music-generation-provider.ts`. Finite identities:
`music-2.6`, `music-2.6-free`, `music-cover`, `music-cover-free`.
No automatic migration to Music 3 or host-local implementation.

## Availability and original product

Checked 2026-11-05: the [global guide](https://platform.minimax.io/docs/guides/music-generation)
closes paid Music/Lyrics APIs to new users from 2026-08-20; existing paying users
may continue. It announces free-variant discontinuation without a separate date.
The [CN guide](https://platform.minimax.cn/docs/guides/music-generation) instead
says free music APIs have stopped. `miniMaxMusicAvailability` retains the earlier
aggregate disposition; it cannot express this regional difference and is not a
regional availability or entitlement verdict. A separate regional metadata
contract is required before catalog activation. Compatibility fixtures prove
neither continued free service nor account eligibility.

The frozen codec retains global `https://api.minimax.io` and legacy CN
`https://api.minimaxi.com`. The [current CN API contract](https://platform.minimax.cn/docs/api-reference/music-generation)
uses `https://api.minimax.cn`; this change does not replace the legacy origin or
qualify an alias or credential interchange. CN activation still requires its own
origin and original-grant qualification. Native API Bearer, plan keys and E09
Anthropic OAuth resources are not interchangeable by inference. No login, account
changes, credential fallback or client upstream-secret forwarding occurs here.

## Request and concrete client correction

`worker/minimax-music.ts` exports `miniMaxMusicModels`,
`miniMaxMusicAvailability`, `prepareMiniMaxMusic(region, body)`,
`inspectMiniMaxCoverBase64(value): Readonly<{ decodedBytes: number }>`,
`observeMiniMaxMusic(frames, request, complete)` and
`readMiniMaxMusic(response, request, signal)`.

POST `/v1/music_generation` with `stream:true`, `output_format:hex`, MP3,
44100Hz and 256000bps. Original prompt/lyrics/options are retained, not silently
translated. Regular models accept lyrics or `lyrics_optimizer:true`; instrumental
requests must omit lyrics and the optimizer. Local lengths follow the documented
2000-character prompt and 3500-character lyrics bounds conservatively in UTF-16.

Cover models require exactly one `audio_url` or `audio_base64`, a 10–300-character
style prompt, optional 10–1000-character lyrics, and no instrumental/optimizer
flags. **The frozen client exposes cover IDs but never supplies reference audio;
its generic request is invalid and is rejected before egress.** Source 11.2 owns
the actual input-reference correction. Raw `cover_feature_id` stays closed until
durable original-caller/credential asset binding exists. No preprocessing call
or raw feature-ID pass-through is introduced.

HTTPS reference URLs are opaque upstream input, never router fetch targets.
Inline reference encoding is bounded to 8MiB, below the primary 50MB limit.
Encoding checks do not establish playable audio or the required 6-second to
6-minute source duration. Actual client/runtime asset qualification must enforce
that duration and media validity before cover activation.

Cover preparation calls `inspectMiniMaxCoverBase64` directly. It scans the
original string with scalar state and returns only an immutable decoded-byte
count: nonempty standard alphabet, complete padding, zero unused tail bits and
at most 8MiB decoded. It does not decode, normalize, re-encode or retain the
input. Existing preparation still returns the caller's original body; this is
not a new body-ownership or lifetime guarantee. A bounded test-only copy of the
old roundtrip checks canonical tails and the exact size boundary. Encoding
equivalence is not an audio MIME, duration, playability, heap measurement or
whole-request capacity claim. Cover dispatch and asset authority remain closed.

## Complete stream and accounting

Accept native SSE or complete JSON with HTTP 200, no redirects/ranges, valid
UTF-8 and complete bytes. Stage audio until a status-2 terminal frame; `[DONE]`
alone, EOF, vendor errors and post-terminal data cannot finalize a track.
The frozen consumer ignores terminal audio when earlier deltas exist. This
codec instead verifies that a supplied terminal full-file aggregate starts with
the earlier decoded prefix, then uses it once. An ambiguous terminal delta or
contradictory aggregate fails closed. A status-2 frame without audio may close
the already staged deltas. Six sanitized state tests establish this accepted
subset; a different native terminal form needs qualification before widening it.

Local bounds: 8MiB output, 2048 frames and five times the audio limit plus 64KiB
for the SSE envelope. No speculative partial track, URL download, bare binary
fallback, remote task ID or automatic POST replay. Abort cancels stalled reads.
Final metadata must agree with byte size and selected audio settings when
present. Native `music_duration` is observed in milliseconds, not a price input.

The public existing-user Music-2.6 card lists $0.15/track up to five minutes;
the inspected card does not qualify a cover tariff. This does not prove an
account debit, lyric-generation surcharge, interrupted-work refund or safe
pre-dispatch total. All upstream costs remain unknown; upstream-dollar hard
budgets stay closed until qualified. `policy_fixed` remains a separate basis.

## Integration handoff

Proposed exact native request/response format `minimax.music`, capability
`music.generate`, existing provider `minimax`. Source 11.3 owns existing
YAML/schema/catalog; source 11.1 owns dispatch, admission, deadlines and
accounting; source 11.2 owns actual music consumption/reference correction;
source 11.4 owns grant/product qualification; source 11.6 integrated proof.
No manifest activation or claim of complete E10 parity is made by this codec.

Fixture: `providers/_fixtures/minimax/music.json`. Synthetic bytes prove encoding,
not playable MP3 or measured duration. No live call or deployment.

## Inactive bounded streaming response leaf

`readMiniMaxMusicStream(response, model, signal)` is an additive inspection mode.
The existing `readMiniMaxMusic` reader and unary response behavior remain intact.
`prepareNativeMiniMaxMusic(selection)` now accepts an explicitly declared SSE
endpoint for global `music-2.6` and `music-2.6-free`, `minimax.music` request and
response formats, and `music.generate`. Input must explicitly select
`stream:true`, hex MP3, 44100Hz and 256000bps within the existing 64KiB request
bound. CN, cover and reference input remain unavailable in this leaf.
The same SSE-capable endpoint also accepts explicit `stream:false` and returns
the unchanged native unary JSON. Unary requests retain support for absent/null
stream metadata; `stream:true` requires SSE metadata. Every request must select
a boolean mode. One native path supports both modes without duplicate endpoint
aliases or YAML ordering. Other stream modes and WebSockets remain rejected.

The reader requires HTTP 200 SSE, absent or identity encoding, fatal UTF-8,
matching Content-Length when present, a valid status-2 frame and complete EOF.
A terminal frame on an open connection is not complete. It verifies deltas
against any terminal full-file aggregate in one owned accumulator, including
when the aggregate is longer. It then replays exactly one native terminal SSE
aggregate in bounded hex chunks, followed by `[DONE]`. This preserves the full
track for the frozen client's decoder without delivering speculative audio.
The decoder-compatible unit fixture is the existing locally generated,
decoder-verified 44100Hz stereo 256000bps MP3; it is not vendor synthesis or
registered-client proof.

Explicit retained allocations and operational bounds:

| Phase | Ownership and bound |
| --- | --- |
| Input validation | At most 64KiB JSON; prepared input is transient. The returned reader captures only model/stream scalars. |
| Upstream read | At most 40MiB + 64KiB cumulative wire, 2048 frames and 262144 reads including empty reads. One separate 64KiB read window; returned BYOB backing owns the next window. |
| Parsing | One decoded read window, tokenizer feeds of at most 1024 UTF-16 units, depth 8, 512 metadata nodes and 64KiB metadata text per frame. No full-wire string or frame array. |
| Audio inspection | One fixed 8MiB owned accumulator; terminal-prefix validation and suffix compaction happen in place. The result view can retain the full backing buffer. |
| Delivery | The same audio backing, bounded terminal metadata and its serialized/encoded prefix (at most 1MiB encoded), plus at most one 64KiB replay chunk. No full-file hex string. EOF/cancel retires retained audio and the signal listener. |

The existing 32MiB lease charges 64MiB; the separate 16MiB ingress charge fits
within the unchanged 96MiB pool. These are reservation and explicit-allocation
bounds, not a measured runtime heap or complete transport-lifetime proof.
The common delivery owner must hold the lease through downstream EOF/cancel,
and retain the upstream operation until cancellation completes. Unit coverage
checks that ownership without claiming common runtime activation.

Actual-fetch/runtime chunk qualification is **unsupported until independently
proven**. The reader uses BYOB when available; otherwise it rejects any returned
chunk or backing buffer larger than 64KiB. It neither assumes BYOB survives
common transforms nor copies an unbounded chunk into smaller windows. Source 11.1
and source 11.6 must qualify the actual fetch, reader and cancellation path before
dispatch can use this leaf. The existing default codec is not a fallback.

There is no production caller or private original music-operation grant binding
in this change. Source 11.1 owns that global authorization and common selection;
speech, image, Messages and TokenPlan permissions confer no music authority.
Source 11.2 still owns registered-client delivery, signal and no-replay proof.
Success has null token usage; native duration/size are not USD or invoice
receipts. Unknown upstream-dollar budgets remain closed; `policy_fixed` is
separate, and interrupted/dispatched work does not imply a refund. Cover and CN
remain required internal work, not qualified by this streaming leaf.

Primary evidence checked 2026-11-03:
- [Native music schema and availability notice](https://platform.minimax.io/docs/api-reference/music-generation)
- [One-step and owned-feature cover workflows](https://platform.minimax.io/docs/guides/music-generation)
- [Existing-user music pricing](https://platform.minimax.io/docs/pricing/overview)
