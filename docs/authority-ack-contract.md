# Generic authority acknowledgment ownership

The generic `policy-bindings` transport consumes a closed acknowledgment for 17
paths, after existing specialized control branches. Other namespaces, reads and
specialized Search, Video, Wan, Music-cover and attestation owners keep their
existing transport. Request serialization and bulk request limits are unchanged.

| Paths | Exact acknowledgment |
| --- | --- |
| `/initialize`, `/initialize-all`, and `/users`, `/policies`, `/credentials`, `/connections` with `/initialize` or `/initialize-all` | `initialized` |
| `/mutate`, `/users/put`, `/policies/put`, `/grant-pools/feedback`, `/oauth-states/put` | `updated` |
| `/grant-pools/record` | `recorded` |
| `/submission-tickets/release` | `released` |

## Compatibility and deliberate tightening

Successful status still means `response.ok`. An empty DO response URL, another
successful status and absent media type do not cause network-only rejection.
The existing case-sensitive `content-type.includes("application/json")` decision
remains. JSON must be one complete root string, with standard escapes and bounded
JSON whitespace, equal to the expected acknowledgment. A tiny root-string guard
runs before `JSON.parse`; there is no token vector or invalid-JSON text fallback.
Other media types require the exact bare literal, without trimming or unquoting.
Default UTF-8 replacement and initial BOM handling match the prior text decoder.

Wrong, empty, object, array and other formerly accepted replies now fail. These
are intentional closed-protocol restrictions, not claims about earlier validation.

| Representation | Local ceiling |
| --- | --- |
| Wire / accumulated text | 128 bytes / 128 UTF-16 units, checked before append |
| Original BYOB reader | one reused whole backing at most 128 bytes |
| Owned reads, including empty and EOF | 8,192 |
| Response headers | 32 fields / 4,096 combined name and value bytes |
| Decoded JSON root string | 11 UTF-16 units; no containers |

The reader separately retains its backing, decoder fragment, bounded text rope,
parse flattening and at most one decoded 11-unit string. Header iteration and
fixed fetch/reader/cancellation/terminal records are separate occurrences. At most
one read is pending, with no history of prior reads or raw exception/cause graph.
These are operational bounds, not measured object sizes, platform buffering or a
whole-heap/common 30 MiB ledger claim. Request and producer graphs are outside scope.

## Failure and physical retirement

One actual fetch root is registered before invocation. The supplied signal is the
only cancellation source; no new timer, deadline reset or retry is introduced.
Pre-invocation abort reports `NOT_INVOKED`. Once fetch is invoked, synchronous
throws, rejected fetches, malformed replies and cleanup failures report
`OUTCOME_UNKNOWN`. That phase does not establish producer rollback, replay safety,
refund or compensation. Errors expose only fixed code, reason and outcome fields.

The original body reader is owned before status/header rejection. BYOB is required
for reading; a default reader is cancellation-only. Failure starts disposal before
joining actual fetch, any late body, the original pending read and memoized FIRST
cancellation, including rejection. Unlock follows those physical settlements.
Cleanup rejection is independently recorded; `inputRetirement` joining settlements
is not evidence of clean retirement. A rejected but unlocked cleanup fails after
retirement. A still-locked or unknown body keeps the returned facade pending.
Abort therefore stops useful work but cannot promise prompt physical completion.

Existing callers retain their propagation or advisory-catch behavior. In particular,
the actual `flushSelections` promise catches an ACK failure only after its reader
retires. It does not replay an emptied batch. The outer timed-background facade is
not physical proof. Cold initializer `Promise.all`, alternate preparation
`operation.wait`, and timed flush outer ownership remain explicitly unqualified.

## Qualification boundaries

The test-only producer checkpoint reads the unchanged SQLite
`PolicyBindingIndexObject` default namespace `/initialize-all` response through
original 128-byte BYOB/EOF, exact `initialized`, body identity and unlock. That
hosted pass precedes implementation and is not final-head qualification.

The extended fixture submits a real additive `/grant-pools/record` mutation and
checks baseline plus one. Healthy ACKs use the original DO body. Labelled faults
occur after the single real commit and use a separate local HTTP stream, with no
replay or compensation. The pending-read case sends a prefix and withholds the
tail before the next original native read; cancellation comes from a continuation
registered in the originating request. FIRST actual cancel then waits on a barrier
and can reject, retaining the original lock until physical settlement. A late-fetch
case holds the original DO response and verifies zero body reads after abort.

The advisory case uses real canonical admission and a cached selection to produce
an actual pending counter. It observes the original exported flush promise, one
commit, held/rejected cleanup and no second empty-flush write. Header over-limit
HTTP cases are public overflow witnesses; exact field/byte boundaries are isolated
reader tests. Controlled empty reads start only after observed native EOF: they
qualify 8,192 owned calls, not 8,192 native pulls. Oversized backing and unknown
unlock are explicit fault injections. Runtime disposal is not retirement proof.

Final source reviews, fresh hosted Worker/Workerd, required CI/security and all 37
actual consumers remain required. No deployment or broader authority completion
claim follows from this boundary.
