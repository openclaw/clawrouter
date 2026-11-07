# Selected policy collection admission

This is a private consumer/producer materialization profile for the default
`policy-bindings` object. It is not a cache, public endpoint, authorization token,
whole-auth cancellation contract, measured heap bound, or common-memory closure.

## Selection and compatibility

The caller constructs `x-clawrouter-policy-collection: v1` literally, only for
`/resolve`, `/initialize`, `/policies/resolve`, and `/policies/initialize`, after
existing specialized authority branches. Caller headers are never forwarded.
The owner acquires the original body before rejecting marked unsupported
methods, paths or versions. Unmarked flows, other namespaces, global bulk
initialization and the existing specialized operations are unchanged.

Access creates one collection context before its groups map or principal
objects. There are at most 1024 raw principals, including the user and duplicate
groups; 1024 groups plus a user is an intentional whole-operation denial. IDs
are at most 1024 UTF16 units at actual protocol positions. Unknown policy and
override fields with the same names retain the generic scalar limit.

The collection admits 4096 raw bindings, including disabled and duplicate
records, and 2048 distinct referenced policy IDs. Genuine discarded/duplicate
protocol occurrences count before parse. A nested unknown array named
`bindings` consumes the general graph budget, not the actual binding count.
The existing stable comparator, priority ties, enabled filter and first-ID
ordering remain. Referenced principal overrides keep own-field zero and null;
only referenced overrides are inspected, including their complete unknown graph.

## Independent phases and representations

One caller context shares a 4 MiB original KV-byte and UTF16 allowance across
all binding prefixes, policy reads and nullish legacy fallback. A raw record
is at most 2 MiB. Page, key and graph counters do not reset between helpers.
KV listing requests 64 keys per page, with at most 4096 pages and 4096 raw key
occurrences, including duplicate/null keys and empty incomplete pages. A bad
key shape is terminal after charging the full page. Incomplete cursors must
be nonempty strings of at most 16 KiB original UTF8 bytes and UTF16 units.
Full page metadata/key shape is conservatively charged before traversal;
platform page creation is outside the claim.

Each selected DO operation has a separate 2 MiB original request budget and
one 2 MiB cumulative SQL-source budget. Count/byte metadata precedes stored
value materialization. Repeated reads charge again. A canonical reread starts
a new phase; that does not retire earlier retained graphs or grant GC credit.

All source graphs use depth 16, 65536 values, 16384 containers, 32768 combined
members and array entries, 2 MiB decoded string units including keys, keys of
1024 units, scalar strings of 1 MiB and number tokens of 64 characters. The
scanner counts discarded duplicate occurrences before JSON.parse. Existing
Access, user and assignment profiles are unchanged.

Complete initialization batches, query replies and effective-policy results
are each admitted at 2 MiB serialized UTF8 bytes and UTF16 units with the same
graph profile. These are representation budgets, not object-to-heap estimates.
Original wire bytes and replacement-decoded text are counted independently.

## Canonical initialization and projected copies

Cold policy seeds remain raw until the selected owner checks current canonical
rows and ordered first wins. The caller supplies its resolved retention-default
boolean explicitly. Invalid normalization data in a seed ignored by a current
winner is not normalized. Existing malformed canonical JSON still fails.

A prospective visitor accounts for the complete normalized candidate batch
before any candidate calls the unchanged policy normalizer. It visits defaults,
filtered provider/model projection, first-1024 unique models, pricing, retention,
routing and publication fields without constructing those projected arrays or
calling the allocating normalizer to measure them. Bounded visitor selection
state retains at most 1024 model or 32 grant references at a time. Sorting the
same retained values changes order, not representation totals.

Publication admission is deliberately conservative: every structurally valid
potential permission branch (at most two entries) is counted with canonical
24-character ISO timestamps, even if currently expired. The visitor never reads
Date.now. This can deny an expired near-limit batch that would fit if the field
were omitted. The unchanged normalizer alone decides actual current expiry and
permissions; a clock rollback cannot introduce an unreserved optional branch.
No clock freeze or permission extension is introduced.

All candidate validation, prospective batch checks and prepared serialization
finish before the first insert or marker. Binding initialization preserves raw
principal matching, marker precedence, original duplicate-key write order and
its existing normalizer projection. Scalar `bindings: "x"` retains the existing
for-of behavior: ignored characters and an empty principal marker. No new array
shape restriction is claimed. Unknown binding fields count before that existing
projection; complete canonical policy fields remain in query replies.

SQL failure can occur after earlier writes. There is no new transaction,
rollback, replay, refund or compensation promise. Global bulk and other legacy
readers retain their old behavior. Legacy fallback is only nullish: false and
zero do not select a fallback, and operational errors never become absence.

## Original ownership and errors

Actual list/get/fetch promises are registered before invocation. One original
KV stream is read at a time. New KV/request/query readers reuse one whole
16 KiB backing, allow 8192 reads including empty/EOF, and bound applicable
response/request headers to 32 fields and 4 KiB aggregate. A default reader is
cancellation-only. Actual pending reads, the memoized FIRST cancellation including
rejection, and unlock are joined. An unknown locked owner retains its facade.
Supplied signals add no timer; successful query publication has a final signal
fence after physical joins. No whole-auth abort guarantee follows.

Initialization keeps the existing `initialized` ACK branch and its original
signal/uncertainty contract. The private marker is inside its existing fetch
thunk. `authority_ack_failed` has no HTTP status and maps publicly to generic
500, including uncertain failures after invocation. Ordinary query business
non-success also keeps a sanitized generic-500 mapping. Local resource/protocol/
transport/cleanup failures use fixed `policy_collection_unavailable` 503 errors.
Thus local preflight and producer/ACK denial need not have the same public code.
No stored record, raw response text or cause is retained in these errors.

## Qualification limits

Hosted qualification must first prove ORIGINAL KV, incoming DO request and
query-reply BYOB/whole backing/EOF/unlock with unwrapped healthy producers.
Node byte fixtures and labelled HTTP faults do not establish that prerequisite.
Actual public Access, SQLite/KV, phase/canonical/limit and retirement cases remain
separate from capability probes. A diagnostic response or runtime disposal does
not prove an intentionally unknown owner's retirement. Source review and authored
coverage are not executed proof. No deployment or vendor-compatibility claim follows.
