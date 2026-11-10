# Inactive private credential preflight

This foundation is **partial and inactive**. No default Worker admission,
preverification, public HTTP route, provider path, cache, generation index or
copy allocator calls it. A later integration needs its own source and runtime
qualification. A preflight match is secret preverification, **not authenticated
identity**. A disabled credential with the correct secret still matches here;
full admission retains its current lifecycle, rotation and authority checks.

The local candidate is code-only. Authored Node and actual Workerd witnesses
are unrun locally. In particular, the runtime normalization assumptions and
factory inventory require qualification before publication/landing. Neither
Node's minimum version nor source review proves those runtime properties.

## Closed private protocol

The Worker helper obtains the actual `ACCESS_CONTROL` binding and only its
`policy-bindings` namespace. The new DO path is
`/admission/credential-preflight`, selected after existing specialized selectors
and before generic CRUD dispatch. It requires the private
`x-clawrouter-credential-preflight: v1` selector. That selector chooses a parser;
it does not authenticate a public caller or turn metadata into authority.

Request: exactly `{credentialId, secretSha256, source}`. The digest is exactly
64 lowercase hexadecimal characters; no raw secret crosses this protocol.
The stable key id is derived from existing admitted proxy-key grammar: at most
`4096 - 10 - 1 - 8 = 4077` ASCII units. It cannot contain both delimiter forms.
The complete JSON receiver still has the existing 2 MiB profile; the derived
maximum compact request size is not a replacement receiver cap.

Reply: exactly `{outcome, source}`, with outcome `unknown`, `invalid` or
`matched`. The seven source fields are `bytes`, `text`, `values`, `containers`,
`members`, `entries` and `units`. Unknown fields, nonintegers and exceeded limits
are rejected. Unknown/invalid are preliminary outcomes for future ordinary 401
handling, not permission to retry authentication against another source.

`matched` creates an empty opaque carrier. A private WeakMap binds it to the
actual binding, namespace, stable id, submitted digest, source-budget owner and
funded ticket. Wire objects, serialized values and clones cannot mint proofs.
A successful consume transfers the original funding to an opaque continuation
once. Failed expansion keeps the original small charge and proof owned by its
caller. Explicit release clears owned identity strings/binding references.
There is no final-admission implementation on the continuation yet.

## Common arena and separate ledgers

Each temporary ticket reserves **exactly 32 MiB of logical payload** using the
same 96 MiB Worker counter as `BodyLease`. `ExactBodyCharge` does not double the
request and has no 1 MiB floor. Its replacement transfers actual credit in one
synchronous step without release/reacquire. Three full tickets fit only when
competing body charges permit. No cache, colo, feedback or Music allowance is
counted as spare capacity.

Each DO instance has an independent 96 MiB arena. Its charge never funds a
Worker ticket. The request, original KV reads, staged representation, final
canonical decision and response producer remain in that DO ticket. Sending
headers does not retire the response: its new byte producer releases only on
actual EOF pull or cancellation. An unread response remains charged. The
Worker independently joins transport acquisition, late response body, read,
FIRST cancellation and unlock before it can shrink to a proof.

The retained proof's exact **normative scalar-payload charge** is
`2 * (kid.length + digest.length + namespace.length) + 7 * 8`, at most 8368
bytes. The 4156-unit string carrier and seven numeric counters are separate
from application control slots. This is a policy accounting formula, not a JS
object-size measurement. Full temporary expansion remains 32 MiB. No control
object, native allocation, shared cache or DO-instance ledger disappears from
its ledger merely because a string charge shrinks.

## Data vector and phase maximum

`preflightDataVector` declares the component vector independently of logical
payload and control slots. The existing complete/record profiles remain:

| Component | Complete | Record |
| --- | ---: | ---: |
| Original wire / text | 2097152 | 1048576 |
| Values | 131072 | 65536 |
| Containers | 32768 | 16384 |
| Members | 65536 | 32768 |
| Entries | 32768 | 16384 |
| Members + entries | 98304 | 49152 |
| Decoded string units | 2097152 | 1048576 |
| Individual string units | 1048576 | 1048576 |
| Depth | 24 | 16 |

Every duplicate, discarded unknown field and original occurrence is scanned
before JSON parsing and final closed grammar. Last-wins JSON behavior is kept.
An invalid heavy final request shape performs zero SQL/KV work. The consuming
request helper returns only the closed scalar carrier (at most 4215 units),
after joining and clearing its text, decoder, backing, parsed graph and source
body references. Its ticket remains charged through the later phase maximum.

Each source has at most 8192 reads including EOF and a 16 KiB whole backing.
There is one active read owner, not an 8192-entry control history. Potential
wire block/view/entry bounds are separate data channels; this closed consumer
does not retain a wire-block archive. Each header set keeps 32 pairs / 4096
units; two sets are recorded as 64 pairs / 8192 units. Derived key strings have
28646 units (`5*4095 + 4089 + 4082`), marker strings 180 and query templates
931. The prospective visitor has 48 descriptor slots / 24 frames, an index
scratch of five characters and number scratch of 64. It does not collect a
whole key vector.

The logical payload argument is conditional on actual runtime normalization.
The request/reply phase retains at most two complete decoded text aliases,
one admitted parsed-string vector, one 16 KiB backing and decoder chunk,
scanner scratch, closed carriers and the declared key/header/query vectors.
The credential phase uses the record limits, its admitted normalized value,
staged serialization and final canonical reread; these phases share one
funded maximum, not separate credits. The previously reviewed conditional
inventories (14756078 request, 18991736 credential, 14777299 Worker) are not
measured heap and do not replace the updated component vector above. A source
closure must account for the actual factory/data layout, not merely cite those
prior figures.

A conservative logical-string envelope keeps two complete decoded aliases
(8 MiB), a complete parsed-string vector (4 MiB), conditional normalized
strings (4 MiB + 128 bytes), staged serialization (2 MiB), final canonical
text (2 MiB), and final parsed strings (2 MiB). That is 22 MiB + 128 bytes,
even before using the phase separation. Adding the explicit backing/chunk,
scanner, headers, derived keys, markers, queries and closed carriers stays
below the 32 MiB policy charge. Structural graph counts remain their separate
vector; they are not converted into guessed object sizes. This is a logical
payload envelope conditional on normalization, never an actual heap fit.

Default lowercase/trim coupling is a runtime qualification condition, not a
runtime version guess. The source basis is ECMAScript default case conversion
and Unicode 17 default mappings; locale-specific mappings are not used.
The authored Node and Workerd qualifiers iterate the entire code-point space
without collecting a case vector, check each transform against ORIGINAL UTF8 bytes (separately from the two-transform `2R+64` allowance), Cased and
Case_Ignorable contexts, default final sigma, source escapes, lone surrogates
and invalid-UTF8 replacement. The credential name uses the existing validator,
not a new slice/fallback copy. See [ECMAScript case conversion](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.tolowercase)
and [Unicode 17 SpecialCasing](https://www.unicode.org/Public/17.0.0/ucd/SpecialCasing.txt).

## Factory charges and ownership

`preflightFactoryCharges` is the concrete application factory-charge table.
All four windows are prepaid at ticket reservation: operation, source, read
and terminal, 128 slots each, plus 512 synchronous slots. The table names the
original and derived promises, discarded API products, callbacks, outcomes,
listeners, reader/stream states, SQL cursor/array/row objects, normalization
objects, descriptors and plans. Counts are application slot ceilings, not
engine object weights. Captured payload remains in the data ledger.

Capacity is checked before per-ticket factories. Window admission prevents
reuse during an active phase. Read reuse follows actual original and
propagated settlement, value admission/copy and explicit alias clearing.
Source reuse follows read/FIRSTcancel/unlock and listener removal. The terminal
window is reserved before work; cleanup does not acquire new credit. The
synchronous table includes the bounded 43 SQL cursor/array/row objects, eight
credential wrappers/twelve slots, five normalization objects/nineteen slots,
seven-counter records and visitor/stage closures. Source review still needs to
close every row against the final implementation; a scalar counter alone is
not a factory proof.

Generic `InputRetirement` is unchanged. The consuming owner separately tracks
original read, memoized FIRST cancellation, unlock and listener-removal
outcomes. Explicit primary presence preserves literal `undefined`. Independent
origins remain ordered even when their reasons are the same object. Propagating
one original read is not another failure. A late fetch is joined and its body
owned even after abort. Unsupported BYOB uses a default reader only to cancel
and unlock, never to read. Unknown original ownership/retirement holds the
entire ticket indefinitely; no timeout, GC, EOF from a wrapper or native
physical-retirement claim substitutes for a receipt.

## Source counters and final commit

Request intake, original KV reads and canonical SQL reads use one cumulative
logical budget. Submitted counters cannot buy another complete allowance.
Producer outbound JSON plans are separate prospective work, not new original
source consumption. The reply contains counters including the submitted
budget and producer's actual consumption. The Worker replaces its unchanged
sent snapshot with those monotonic counters once and adds its original reply
consumption once. A stale/repeated merge fails. The private continuation keeps
the same source owner; no public parsed record or metadata grants authority.

Canonical SQL checks `LENGTH(CAST(... AS BLOB))` before selecting a value.
Cold lookup reads `credentials/id`, then only a nullish miss permits genuine
legacy `keys/id`. The current canonical winner and global initialization fence
are checked before normalization after KV await. The new path stages once,
admits the full normalized record before serialization, strips provenance and
never overwrites an existing row. Existing global stage behavior is unchanged.

The final transaction rereads the current winner. If a seed is still needed,
it prospectively checks **the entire planned canonical reread plus verdict,
counters, JSON serialization and consumer reply headroom before the INSERT**.
The check does not spend source credit. The actual full SQL reread subsequently
charges the same budget once. No await intervenes between the final decision,
nonoverwriting write and canonical reread. A staged alias is not a fresh source
allowance, and no projection omits unknown source data. The near-limit witness
uses a full 1048576-byte normalized record: request + KV + final canonical read
cannot fit 2097152, so it must deny before any seed/marker/write. This is not a
rollback claim. Unexpected SQL/transport failures retain their normal error
boundary; the private HTTP response remains sanitized.

## Qualification scope

Focused authored witnesses cover common-counter competition, capacity before
factories, exact small/full atomic transfers, clone/binding/digest rejection,
single use, disabled secret-only match versus unchanged full revocation,
canonical winner during KV await, metadata-before-value, no policy/pool/provider
work, near-limit zero writes, duplicates and cumulative counters, independent
undefined/shared cleanup failures, late transport/body retirement, native
Workerd KV/RPC bytes, actual SQLite and the two runtime normalization qualifiers.
The Workerd setup supplies the complete Env before initialization. Node-only
synthetic producers use explicit byte streams; healthy platform bodies are not
replaced. Workerd observation forwards original readers and promises.

No combined heap fit, native allocation/physical retirement, generation count,
cache arena, public Music/Images or 32/64 MiB response qualification is claimed.
Local syntax/diff/privacy checks do not qualify TypeScript or semantics. Before
landing: bounded source closure, actual Node and Workerd qualifier success,
fresh nine-job CI, both CodeQL analyses, all 37 actual clients and aggregate at
the exact candidate head. Default activation is outside this foundation.
