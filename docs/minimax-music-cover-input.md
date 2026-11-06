# Inactive MiniMax cover input/hash foundation

`worker/minimax-music-cover-input.ts` has no production caller. It admits,
decodes and hashes a private input, then retains its backing until explicit
discard or the original deadline. It does not qualify audio formats, duration,
provider compatibility, credentials, generation, prices or a cover route.

The private profile accepts one canonical bare `audio_base64` string, exact
`music-cover`, a10–300-character `prompt`, and optional10–1000-character `lyrics`.
Native and `{body:...}` envelopes are separate. Keys are unescaped ASCII;
duplicates, unknown fields, arrays, nested values, URLs, handles, data URIs,
numbers and booleans deny. This is an application profile, not an assertion that
MiniMax specifies bare Base64 or a particular WAV subtype. Model may occur last.
Complete UTF-8 and JSON EOF are required before hashing. The encoded image/audio
string is never retained; decoding occurs once into one50,000,000-byte backing.
No format or provider-response model-echo assertion is made.

## Admission and finite representations

`BodyLease.grow(48 MiB)` admits a constant96 MiB from the existing pool before
reader acquisition or decoding. Failure starts no read or hash. No controls,
request/identity/environment graph, authentication, RPC or upload enters this
module. The source DTO supplies only the body/signal handles, absolute deadline,
closed route/content-type/encoding and optional bounded content length. The
deadline is at most five minutes and persists through an unclaimed result.

| Simultaneously charged category | Bound |
| --- | ---: |
| Owned decoded allocation | 50,000,000 B |
| Actual WebCrypto input snapshot allowance | 50,000,000 B |
| Original-reader, decoder and feed backings | 64 KiB |
| Tokenizer batch, bounded grammar state and scalar scratch | 128 KiB |
| Eight bounded scalar-plan representations | 32 KiB |
| Four source/header/correlation representation allowances | 64 KiB |
| Eight fixed format/view-record allowances | 32 KiB |
| Sealed metadata arena | 64 KiB |
| Twelve owner records plus charged unused remainder | 256 KiB |
| **Total hash phase** | **100,655,360 B** |
| **Unassigned slack within96 MiB** | **7,936 B** |

These are operational allowances, not measurements of V8 objects or a bound on
platform-native HTTP/socket/crypto implementation memory. Caller-owned chunks
and continuations are included; none move into the platform exclusion. No GC
credit, phase downshift, independent response reservation or capacity split is
implemented. Existing Music's64 MiB response owner is untouched.

The original reader must support BYOB before its first read. Every requested
and returned whole backing is at most16 KiB. A default-reader producer is denied
without reading and its FIRST cancellation is joined. All physical read calls,
including empty reads and EOF, share an8192 limit. UTF-8 tokenizer feeds are at
most256 bytes. A raw pass checks the wire, non-audio and structural bounds before
the tokenizer receives each feed. Arrays and depth beyond the closed one/two
object envelope deny in that pass, including malformed input. A256-byte feed can
introduce at most256 lexical characters and a bounded boundary tail; the token
vector is conservatively budgeted for1024 token records plus bounded strings and
parser state inside128 KiB. No complete-document feed or growing token history
is retained. The grammar has five key bits, three scalar slots, and one writer.

Wire is at most66,732,204 bytes: canonical encoding of50,000,000 decoded bytes
plus64 KiB non-audio bytes. Only literal canonical Base64 bytes inside the exact
audio slot receive wire credit. All bytes of JSON escapes, whitespace, keys,
quotes and scalar values spend the separate64 KiB budget before tokenizer
copying. Quartet state crosses feeds; canonical padding bits and complete final
quartets are required. Scalar concatenation is checked before allocation:
32-unit keys,2000-unit values,4096 aggregate units. UTF-16 surrogate validity and
an exact closed-plan UTF-8/escaping count run before any serialization; the
scalar plan is at most4 KiB. There is no whole-plan encoding or stringify here.

Header/correlation and format-record allowances do not authorize future fields:
this foundation stores no URL, caller correlation, MIME or format graph. Only
the listed closed source fields and bounded typed-array views exist. Their
unused allowance stays charged. The maximum fixture exercises all admitted
representations; it does not manufacture objects to fill unused categories.

## Closed owner inventory

Each cell is assigned16 KiB; the12 cells total192 KiB. Another64 KiB of the
owner category is charged and unused. Cells describe the closed reference graph,
not JavaScript object-layout measurements. Fixed records can reference only
other named cells and the explicitly listed physical handles below.

| Cells | Fields and occurrences |
| --- | --- |
| Phase + terminal (2) | One owner/lease; enum phase/failure; bounded counters/booleans; one terminal promise and resolver; one running async continuation. |
| Abort/deadline (1) | One signal handle, one listener callback, one timer callback/handle; no request or signal reason retained. |
| Original read + FIRST cancel/unlock (2) | One BYOB reader, at most one pending read promise and one normalization observer; one FIRST-cancel promise/resolver and two settlement callbacks; at most one unlock. No read history or per-read race. |
| Actual digest + observer (2) | One populated view, one actual digest promise and one sanitizing observer; one32-byte result and bounded64-character digest construction. No extra input slice. |
| Public race (1) | One result promise, two resolvers and one rejection observer; public abort is independent of the running physical continuation. |
| Sealed handoff + terminal cleanup (2) | One frozen opaque handle/WeakMap entry, one bounded metadata record, one claim bit; one retired promise/two resolvers/one rejection observer and one completion continuation. |
| Primary + cleanup failure (2) | Constant failure-code enums and newly created content-free errors only. No raw Error, cause, arbitrary rejection graph or allSettled result archive. |

The returned facade has four fixed fields: result, retired, discard and snapshot.
Its two callbacks reference only this owner. Snapshot is a fixed scalar record;
it grants no authority. Parser/writer/decoder/feed locals belong to the bounded
intake call and are retired before entering hash; their maximum storage remains
charged. The writer drops its mutation reference before the populated view is
handed to WebCrypto. No caller can obtain the writable bytes. Hash is registered
before any public cancellation can settle the operation, and actual settlement
is joined even if public cancellation already rejected the result.

## Retirement and one-use handoff

Public failure can be prompt. Capacity release waits for the running intake or
digest, original pending read, memoized FIRST cancellation (including rejection)
and lock retirement. Cancellation starts before joins. A rejected cleanup is
reported separately as `cleanup`; it never becomes successful cancellation or
replaces the already-published primary failure. Repeated discard cannot replace
the FIRST promise or release twice. No root waits for encompassing completion.

On success, `claimMiniMaxMusicCoverInput` returns frozen bounded metadata once.
The opaque handle is not forgeable by reconstructing its public fields. It
exposes no bytes, authority, upload, serializer or provider operation. Its backing
remains privately held until discard/deadline. A future explicitly leased upload
handoff must add its own identity, authority and physical ownership contract;
this module does not qualify that next step.

## Qualification scope

Focused tests cover padding/escapes/complete JSON, scalar and backing limits,
model ordering, duplicate/foreign fields,8192 reads, FIRST-cancel rejection,
held read/digest, public abort/deadline, contention and one-use handoff. The
isolated Workerd fixture uses actual HTTP request bodies, two full decimal50M
envelopes, exact maximum wire and bounded scalar plan, plus malformed and held
physical-boundary cases. Network barriers are fixture controls, not production
authority/RPCs. These tests are authored evidence until the exact head passes.

This is input/hash qualification only. Audio codec/subtype/duration, vendor MB
interpretation, input prefix compatibility, original-account cover authority,
full-route control budgets, upload/response handoff, unary HEX decoding, SSE
semantics, pricing, settlement and native-client composition remain separate.
