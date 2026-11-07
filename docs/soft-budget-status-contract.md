# Generic soft-budget status observations

Generic soft-budget status uses bounded JSON and an owned original reader. Search,
private Music-cover, dashboard reads, plan construction, reservations and charges
keep their existing paths. This is an observation boundary, not a bound for all
authority, SQL, policy, cache or request allocations.

## Compatibility

The observer still uses `response.ok`, parses JSON and consumes only `spentMicros`.
Partial objects, an empty Durable Object response URL, absent or different media
types and successful statuses other than 200 remain supported. There is no new
required envelope or field, range restriction, Content-Length agreement or network
destination check on DO replies.

Clean non-success, null, unusable spent and below-limit observations clear cached
exhaustion. Thrown fetch, read, parse, resource and cleanup failures are bounded
observation errors: they fail open without deleting exhaustion. A configured zero
limit still denies before provider/status I/O. Existing safe-integer comparison,
late cache updates and expiry remain unchanged.

Provider fetch starts before four parallel status legs. Each catches its own
failure; the same `.check` promise joins all four physical owners. The 50 ms grace
starts after provider headers and limits the wait before delivery. `close()` only
suppresses outward denial; it does not cancel the observations. No observation
deadline, signal, retry or additional provider/charge attempt is introduced.

## Limits and retained occurrences

| Boundary | Local maximum |
| --- | --- |
| Original wire / text before append | 16 KiB bytes / 16,384 UTF-16 units |
| JSON | depth 4; 128 values; 32 containers; 64 members; 64 array entries |
| Decoded strings including discarded duplicates | 4,096 total UTF-16 units; scalar 1,024; key 64 |
| Number token | 64 characters |
| Original reader | one reused whole backing ≤16 KiB; 8,192 calls including empty and EOF |
| Response headers | 32 fields; 4 KiB combined names and values |
| Object name and four query values | each ≤1,024 units; aggregate ≤4,096 |
| Encoded URL | ≤16 KiB, counted before encoding or `idFromName` |

The fixed recursive scanner counts every duplicate and ignored occurrence before
`JSON.parse`; normal last-member-wins semantics remain. It creates no token vector
or decoded string archive. Four levels bound its call stack. The wire bound precedes
UTF-8 decoding; text is bounded before append. String/graph limits then apply before
parse. Thus wire, text and graph maxima are distinct, not interchangeable proofs.

Each of at most four legs retains one actual fetch promise and response, one original
reader, one input-retirement owner, one pending read, one memoized FIRST cancellation
and one terminal promise. Fixed callbacks have no history of earlier reads. Transport,
decoder and cancellation exceptions become fixed errors before retained cleanup waits;
arbitrary original exception/cause graphs are not retained.

Count caller representations separately: up to 16 KiB read backing; up to 32 KiB
UTF-16 wire text, its bounded append fragments and parse flattening; at most 8 KiB
decoded graph strings plus 128 value/32 container records; header iteration; the
decoder; and fixed reader/fetch/retirement descriptors. Request construction retains
five bounded input references, the limit's bounded scalar conversion, encoding
temporaries and the URL. Up to five URL construction stages are each bounded by
16 KiB ASCII (32 KiB UTF-16); source plans and reservation graphs remain outside this
claim. No garbage-collection credit or measured object size is asserted. The read
window and decoder result are separate from text and parsed graph. This inventory is
operational, not a whole-heap/native buffering or common 30 MiB ledger qualification.

## Physical retirement

The fetch root is installed before invocation. Every returned body is owned before
status or header rejection. BYOB is required for reading; a default reader can only
be canceled. Failure initiates FIRST cancellation, joins the original pending read
and cancellation (including rejection), then attempts original unlock. Cleanup
failure is separately recorded: `inputRetirement`'s joined settlements alone are not
success. Rejected-but-unlocked cleanup fails open after retirement. Locked or unknown
ownership deliberately leaves `.check` pending; public delivery can already complete.
No runtime teardown is claimed as physical retirement.

## Proof boundaries

The initial real SQLite fixture seeds `/charge` and consumes the unchanged DO stub
`/status` body using BYOB through EOF, verifying spent 17. Its hosted producer pass
does not qualify the later composed implementation or consumer matrix.

The extended fixture uses public provider requests, real canonical authority, a
synthetic grant and four real BudgetLedger legs derived from `planBudgetReservation`.
It witnesses fetch invocation before statuses, zero reserve/dispatch calls, one
provider POST, four charges and the original `.check` registration. Fault replies
are labelled substitutions after a real SQLite status request. The streaming fault
uses a real local HTTP body: prefix returned, next native read actually pending,
then invalid UTF-8 and held/rejected FIRST cancellation. Sibling failure and two
retired legs must not release the held owner. Provider delivery remains independent.

A/B/C public requests share a scope without cache resets: both A and B dispatch
before A's exhausted reply, then B's clean/error result determines whether C can
dispatch. The cache clock is fixed independently of auth/HTTP wall clocks. C's real
SQL reply can still deny delivery after a clean B permits dispatch.

Controlled empty reads after observed native EOF qualify the owned 8,192-call
boundary, not 8,192 native network pulls. Oversized backings, read rejection and
unknown unlock are explicit fault injections. Unknown unlock runs last and retains
its owner; fixture disposal does not turn it into success. Limits use reachable
boundaries: whitespace reaches the wire ceiling, while ignored huge string data may
hit the wire bound before graph scanning. No vendor, deployment, heap or general
authority-transport claim follows. Fresh hosted semantics and all 37 actual consumers
remain required on the final head.
