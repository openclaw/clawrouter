# Selected assignment source admission

This foundation admits complete assignment sources and prospective evaluator
representations. It does not migrate legacy state, truncate rule lists, force
UNKNOWN evidence into reconciliation, or close the common-memory ledger.

## Private selection and compatibility

Only default `policy-bindings` `/users/reconcile-assignments` constructs
`x-clawrouter-assignment-materialization: v1`, after specialized transports.
The header is a private protocol selector, not authorization. Caller headers
are never forwarded. Marked unsupported versions, paths and methods own the
original body before rejecting. Unmarked routes, other object namespaces, the
seventeen ACK selectors and old synchronous evaluator APIs retain their behavior.

Operational failures use fixed `503 assignment_materialization_unavailable`
with `limit`, `protocol`, `transport` or `cleanup`. They never become absence,
partial rules, user creation or alternate-authority/authentication fallback.
Bounded business failures remain distinct: canonical absence propagates
`404 unknown_user`; bounded authority validation/status errors are preserved.
Selected error bodies are owned and bounded too; raw error/record text is not
included in retained operational failures.

## Closed phase profile

| Representation | Admission |
| --- | --- |
| Each original rule/legacy/SQL record and cumulative listing records | 2,097,152 original bytes and UTF-16 units |
| Assignment graph | Depth 16; 65,536 values; 16,384 containers; combined members plus array entries 32,768; decoded strings including keys 2,097,152 units; key 1,024; scalar 1,048,576; number token 64 |
| KV listing | Limit 64 per page; 128 pages including empty incomplete pages; 4,096 raw key occurrences including null/duplicate rows; incomplete cursor nonempty, at most 16,384 UTF-8 bytes and UTF-16 units |
| Complete outbound request and reply | Independently 2,097,152 serialized UTF-8 bytes and UTF-16 units, plus the assignment graph |
| Exact ordered legacy revision and complete stored record | Independently 1,048,576 serialized UTF-8 bytes and UTF-16 units, plus the assignment graph |
| Original stream | Reused whole backing at most 16 KiB; 8,192 reads including empty and EOF |
| Request/reply headers | 32 fields; 4 KiB aggregate name/value size |

All raw duplicate/discarded JSON occurrences count before `JSON.parse`. The
scanner adds a closed assignment profile without changing Access or user profiles.
Original wire and decoded text are separate; replacement decoding and BOM handling
do not recharge replacement expansion as original bytes. Native KV page creation
is outside this claim. The already-created page's complete data shape, including
ignored metadata and keys, is admitted before consumption and conservatively
charged to the cumulative listing budget. Every actual repeated record read
charges again. Separate legacy, outbound request, current SQL and output phases
do not imply earlier graphs have been freed or credited back.

Listing is sequential and has no partial-success path. Prospective rule entries
are measured before spreads and the complete list before sorting. One original
KV stream is consumed at a time. Actual list/get/fetch operations are registered
before invocation; late completion remains joined. Default readers cancel only.
Original reads, memoized FIRST cancellation including rejection, and unlock join
through unchanged `inputRetirement`. Rejected-but-unlocked cleanup denies; unknown
lock ownership holds the facade. No timer, new deadline, whole-auth abort promise
or cross-request native I/O ownership is introduced. A supplied reply signal is
checked again after awaited cleanup before successful publication.

## Revision, evaluation and write ownership

The admitted capture requires actual string arrays for both `groups` and
`policyIds` before copying. Strings cannot expand through spread into an
unadmitted array. Exact legacy JSON field order, omission, escaping and nonfinite
number behavior are measured before `capture.map`, nested copies, stringify,
TextEncoder or digest. `generatedGroup` is excluded from revision bytes but is
captured immutably for evaluation. The private Symbol/WeakMap capsules remain
opaque. Valid 1000-rule legacy revisions above 64 KiB remain supported.

The DO reserves one of four admitted operations before body acquisition. An
admitted operation holds through actual intake retirement, existing postparse
FIFO, hashing, current canonical read, synchronous evaluation and complete reply
serialization. A fifth request performs no semantic read/snapshot/hash, but still
owns original-body cancellation/unlock. This does not bound rejected cleanup,
native allocations, all concurrent requests or whole heap.

FIFO enrollment remains after parse. Snapshot failure, including an original
`undefined` failure at the direct-owner boundary, still joins its predecessor.
Hashing follows that join; the canonical SQL read follows hashing. SQL checks
stored byte length before loading/scanning the complete value. No await separates
the final canonical read, evaluation and write. Current profile changes and
deletion cannot be overwritten by the earlier request snapshot.

Before evaluator key/value arrays, flatMaps, sets, normalization arrays and
comparison stringify, plans count prospective ID and group multiplicity, retained
entries and normalization expansion. Each sequence/map has a closed assignment
profile; these are representation bounds, not measured object sizes. Full current
unknown fields count and survive the reply. No-op paths never normalize/write.
Changed storage uses the exact existing `normalizeUser` projection/defaults,
raw-group dedup before trim/lowercase, omission and unknown-field drop, once.
The evaluator captures `updatedAt` once. Both complete stored text and full reply
including changed/user/matched/retained IDs are admitted and prepared before SQL.
SQL-after-commit failure remains uncertain; no rollback, replay or compensation
is promised. Earlier administrative rule/binding commits may also remain.

## Authored proof and limits

Node cases cover cumulative/discarded occurrence guards, exact escaping/UTF-8,
revision bounds, both 300K malformed array fields, FIFO failure ordering, current
SQL reads, complete output overflow with zero writes, no-op bytes, missing-user
status, cancellation rejection, late response and labelled reader counter faults.
The new Workerd fixture first probes original KV, incoming DO request and selected
reply BYOB/whole-backing/EOF/unlock. Healthy bodies are not substituted. It then uses
real SQLite/KV and authenticated public admin reconciliation, multipage listing,
four held intake/FIFO operations, fifth-request cleanup and SQL-after-commit faults.
Existing writer coverage remains for 1000-rule legacy no-ops, UNKNOWN/empty evidence,
digest order, profile concurrency and original undefined hash failure.

The intake fixture holds a wrapper after native read settlement; the hash fixture
holds a continuation after real digest settlement. A separate real local HTTP
source withholds bytes to witness a genuinely pending native read, followed by
actual FIRST cancellation and held rejection. Unknown unlock is injected; its
labelled diagnostic returns with production ownership still unsettled. All finite
controls/bodies are joined before fixture disposal. Diagnostic EOF and disposal
are never retirement proof. Semantic execution remains UNRUN until fresh hosted
qualification. SQL-native work, upstream page/array creation, admin-all user
enumeration/results and common-memory/platform physical lifetime remain outside
this boundary. No deployment is included.
