# Inactive MiniMax cover upload and unary response

This private foundation has no production route caller, credential selection,
current-authority verdict, accounting finalizer or discovery registration.
`runInactiveMiniMaxMusicCoverUpload` accepts a genuine unused sealed input and a
transport supplied by an internal fixture. It fixes the global destination,
method, redirect policy, sealed model/prompt/lyrics/audio, unary HEX options and
one attempt. A copied input, metadata claim, completed inactive preparation or
raw allocation cannot substitute for that custody. Custody is not permission.

The separate inactive authority preparation finishes known-unsent accounting.
It must never be followed by this POST. Future composition needs a separate
lease: move the existing final connection/policy/original-owner refresh to the
actual POST tail, after preparation and slot waits, and use dispatch-aware
settlement with the original IDs. No extra refresh, retry or zero-debit claim is
provided here. PCM16/input-format compatibility, vendor availability, entitlement,
SSE, public routes and authorized end-to-end cover generation remain unqualified.

## Ownership and charges

The existing 96 MiB pool charge remains constant during upload:

| Application ownership | Bytes |
| --- | ---: |
| Original decimal 50,000,000-byte input backing | 50,000,000 |
| Control and accounting allowance | 33,554,432 |
| Upload allowance | 16,777,216 |
| Total | 100,331,648 |
| Margin below 96 MiB | 331,648 |

The 16 MiB upload allowance assigns 440 KiB; the remaining 15,944 KiB is unavailable
for new representations. These are operational cells, not measured object sizes.

| Fixed representation group | Allowance |
| --- | ---: |
| Eight bounded scalar-plan representations, including escaped text | 128 KiB |
| Prefix and suffix | 32 KiB |
| Working and queued encoded chunks | 32 KiB |
| Four header/URL/correlation representations | 64 KiB |
| Sixteen state records | 64 KiB |
| Sixteen callback/continuation records | 64 KiB |
| Twelve promise/barrier records | 48 KiB |
| Four listener records | 8 KiB |

State records contain only bounded cursors/counts/phase flags, source/controller,
capability, pending pull, FIRST discard, close/retirement, fetch/early response,
disposal and transfer handles. Promise records cover source retirement, original
produce plus its physical observer, FIRST discard and its observer, closure,
actual fetch and its adoption, late disposal, public result and transfer/reader
handoff. Ordinary slot/result/finalization roots belong to the separate control
allowance; response reader/delivery roots belong to the 64 MiB successor. There
is one source, one pending pull, zero prefetch, one working/queued chunk, one
fetch and one unread response; no history or raw exception/cause archive.

The serializer writes ASCII directly into whole backings no larger than 16 KiB.
It never creates a base64 string or another input backing. The sealed bytes have
no public view or mutable writer. Source EOF, the last physical pull and FIRST
discard settle before input/capability/source references clear. Later discard calls
reuse the terminal closure, including rejection, without invoking source disposal
again. The genuine input owner then atomically splits its charge into 32 MiB control and 64 MiB
response successors. Neither a release/reacquire gap nor a second native-response
acquisition exists. The response successor is private and single-use. Failed
transfer retains the original allocation and disposes the unread response.

Transfer joins intake/hash and source retirement, not the whole POST slot.
The POST slot joins actual fetch/late disposal, source, response reader and
output retirement. Control completion joins that slot; input closure joins
control completion. Disposal starts before these joins and never waits for a
successful split. Early headers do not release capacity. Original pending reads,
FIRST cancellation (including rejection) and unlock remain owned. Cleanup failure
is separate from the primary protocol result. Synchronous/asynchronous fetch and
read exceptions are normalized before entering owned promises. Cleanup joins
retain only a bounded failure flag, not an original exception/cause graph.
A failed unlock or a still-locked body retains the root, POST slot and charge;
rejected cancellation with a proved unlock can retire. Public rejection does not
wait for physical cleanup. Stalled cleanup retains capacity.
The original deadline covers parsing and unclaimed output. The established input
listener cancels the control operation with bounded `cover control stopped`; this
slice does not promise original caller-reason identity.

Platform-native HTTP frames, copies, internal pumps and socket storage remain an
explicit unqualified boundary. Application-source retirement is not a native
pump acknowledgment or a whole-heap bound. No garbage-collection credit is used.

## Partial unary response profile

The additive cover scanner does not change text Music or SSE behavior. It accepts
HTTP 200 at the exact fixed URL, JSON UTF-8, identity encoding, no range/redirect,
and a safe matching Content-Length when present. The original reader is acquired
before header validation. Reading requires BYOB; a default reader may only be
cancelled. Whole returned backing is at most 16 KiB and total reads, including
empty and EOF calls, are at most 8192.

Decoded audio is limited to 4 MiB and wire to 8 MiB + 64 KiB. This is partial
operational support, not a vendor maximum or full-output parity. One accumulator
receives incremental HEX; it is never lent to BYOB or copied as a whole. Delivery
regenerates native unary HEX in bounded chunks and retains the successor until
EOF/cancel. Request identity is separate from provider-reported fields: no model
echo is required.

The cover-only fixed-state scanner uses zero tokenizer vectors. Each feed is at
most 1 KiB. Before retaining metadata or parsing its small envelope it enforces
64 KiB metadata (conservative UTF-8 accounting), depth 8, 512 values, 128
containers, 256 members, 256 array entries, 32,768 decoded key/string UTF-16 units,
256-unit keys and 64-character number tokens. Duplicate keys and discarded
occurrences count. Complete JSON and EOF, base status code 0, data status 2 and
nonempty even canonical HEX are required. SSE, URL/reference output, error
fields, malformed UTF-8/JSON/HEX and incomplete tails deny. Only the validated
terminal status and HEX are projected; unknown metadata is not replayed.

## Evidence boundaries

The isolated Workerd fixture exercises the same source passed to actual fetch,
with two streamed 50M inputs, maximum response metadata/audio/wire, exact upload
bytes and one provider POST. It observes held source pull/early headers, atomic
split/reference clearing, failed split, original read/FIRST cancellation and
unlock, late response, output EOF/cancel, deadline and full-pool contention. Separate isolated cases
prove locked-after-unlock-failure retention before and after transfer. Those
fixtures terminate their own runtime after observing retained ownership; runtime
disposal is not claimed as a successful application cleanup acknowledgment.
The 8192/8193 response cases are controlled owned-reader calls after observed
HTTP EOF, not 8192 native-transport reads. Maximum phases are cumulative
reservation evidence, not simultaneous measured-heap evidence.

This inactive registered path has one ordinary POST and no authority/settlement
RPCs. The reserved 17-hard/13-soft ordinary and 10-mandatory ceiling tests are
scheduler primitives, not manufactured end-to-end calls. Full authority and
billing composition is not established by this transport fixture. All semantic
evidence must be qualified by the actual final-head hosted results.
