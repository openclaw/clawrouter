# Private generation consumption — local implementation checkpoint

This inactive slice starts at PR976's qualified retained-generation foundation.
It does not activate ordinary proxy, HTTP, Access, direct, provider or credential
cache callers. The ordinary entrypoints remain unchanged. This checkpoint is
**not a publication candidate**: background/prefetch integration and the complete
CONTROL/factory closure below remain open. Local semantics are
`UNRUN_CODE_ONLY_HOSTED`.

## Closed ownership

`completeConsumableCredentialGeneration` records explicit provider/token-reference,
all-connections, snapshot, selection and session facets before hydration. The
record has positive independent common-arena backing and a frozen private copy.
Only the real generation slot binds that coverage to the admitted graph. The old
`completeCredentialGeneration` API gains no inferred coverage.

Coverage follows the slot through optional promotion and actual retirement.
Promotion accounts its metadata in the existing shared vector. Refusal retains
the original admitted temporary owner. Neither a stable key nor missing result
fields establish coverage.

`authenticateCredentialGeneration` verifies the genuine borrower and actual
binding, compares explicit facets, then applies the credential/digest/expiry,
policy-generation and owner rules. Its capability exposes only status/code and
disposal. The identity, effective policy and full admission remain private. A
preverification proof, forged handle, old coverage-free borrower or mismatched
facet cannot authenticate. Business denials retain their private owner until
explicit disposal; unavailable resolution still throws.

A separate parent borrow funds every authentication lifetime. A selection holds
its authentication owner independently of the public authentication capability.
A hint holds the detached selection independently of its public selection
capability. Disposing a public handle clears that handle's WeakMap association;
only the last actual child clears the graph aliases and releases credit. A
publication eviction has no authority to release these children.

## Local planning and advisory state

The base admission stays frozen. A separate owned overlay stores mutable counts,
cursors and runtime observations. A successor starts with an empty overlay and
its own authoritative snapshot. There is no full-admission clone.

The new selector uses the ordinary accepted candidate range and existing strategy
helpers, including random draws, ordering, priorities, pin/exclusion, retry and
configured-pool behavior. It does not call the private bridge's 98-choice-limited
selector. Configuration probes acquire the existing bounded preparation owner;
capacity escapes ordinary configuration-error suppression.

Selection first plans a complete result, validates the logical whole admission
with overlay substitutions, funds and copies the complete selected record, and
funds pending/advisory metadata. Only then can counts or cursors change. Unknown
selected-record fields survive the detached copy. The new copy has its own owner;
it is not described as another reference to the retained base graph.

Runtime merging calls the unchanged `mergeGrantRuntimeState`. Its detached
output and pending feedback copy have separate backing. Account, extra-usage and
snapshot aliases cannot borrow already-retired input credit. Pending records
hold genuine parent borrowers through original ACK settlement. Flushes delete
only the exact pending object that they sent. A replacement arriving during a
write remains pending; attempted records are not replayed. Counter cursor writes
use the latest accepted record for that pool.

Explicit flush uses the existing bounded authority ACK reader. Its original
read, FIRSTcancel, unlock and late-body joins remain authoritative. UNKNOWN leaves
that promise pending and retains the parent and all backing. No timer or response
publication is retirement evidence.

## Current prospective payload calculations

All new leases use real positive `ExactBodyCharge` backing in the existing Worker
96 MiB counter. A promoted ticket's zero balance is never reused as scratch.
The DO arena remains independent. A lease replacement admits the complete next
amount before changing its debit; failure preserves the old debit. These are
normative application charges, not object sizes or physical-heap guarantees.

The implementation currently uses the following prospective expressions. Their
complete simultaneous overlap and every fixed metadata coefficient still require
source closure; these expressions alone are **not** a fit certificate.

| Component | Actual input to prospective reservation | Lifetime |
| --- | --- | --- |
| Coverage | Closed field-name/string occurrences, provider rows, exclusion entries, owner and vector-receipt fields | Slot retirement |
| Authentication | `4096 + 8(C + 2M + E + V) + 2U` from the complete admitted graph | Last authentication child |
| Selection working vectors | Candidate/key/history/state/exclusion counts, normalized routing output and model/lowercase occurrences | Synchronous planning and result admission |
| Per-candidate inspection | Maximum complete grant inspection vector, reserved before filtering | Last filter consumer |
| Configuration | Existing `privatePreparationScratch` vector, acquired before the preparation owner | Last configuration consumer |
| Detached selection | `4096 + 8(C + 2M + E + V) + 2U` from its admitted record | Last selection/hint child |
| Overlay update | Complete retained rows plus old/new overlap before replacement | Slot retirement, shrink only after replaced aliases clear |
| Runtime merge | Four simultaneous record-vector allowances for the two actual inputs | Detached output admission |
| Runtime/pending copies | Independent merge-sized backing and key/owner cells | Replacement or original flush settlement |
| Pending count | `4096 + 8*poolKeyUnits + 6*grantKeyUnits + 2*cursorUnits` | Original flush settlement |
| ACK flush | 32768 bytes, distinct from retained request records | Original ACK acquisition/read/cancel/unlock settlement |
| Hint | 1024 bytes plus a lazy 512-byte registry owner | Replacement/disposal |

`C`, `M`, `E`, `V`, and `U` above are the actual admitted container, member, array
entry, value and string-unit counts. No source-counter credit funds new copies.

## CONTROL/factory closure still required

The prior 715-slot table is not spare credit. This checkpoint has not claimed a
complete replacement table. The remaining audit must include, by actual phase:

- Existing retained index/slot/proof metadata while the new coverage owner lives
  across original hydration and promotion.
- Coverage planning/copy/freeze visitors and receipt rollback products.
- Authentication registry, parent borrower, lease, identity/effective-policy
  factories, business-error products, and cleanup frames.
- Selection planner closures and nested complete-profile visitors; passive
  vectors are DATA but their guards and execution frames are CONTROL.
- Selection/hint capabilities, WeakMap entries, parent/child ownership fields and
  final retirement frames.
- Mutable overlay ownership indexes; pending count/runtime execution records and
  latest-cursor indexes. Execution records are not passive DATA by relabeling.
- Original flush promises, immediate observers, bounded cohort iterators, ACK
  acquisition/read/FIRSTcancel/unlock products, conditional deletion and terminal
  failure handling.
- Accepted background registration and actual prefetch settlement, once the
  closed API seam below is resolved. Rejected registration must start nothing.

No pending/hint callback, arbitrary reason graph or native controller is charged
as passive collection data. No quota/profile change is authorized by this table.

## Concrete unresolved prefetch seam

`worker/credential-cache.ts:prefetchGrantCredentials` returns `void`. Internally it
calls `tryRunInBackground(() => credentials.load(...))`, exposing neither the
registration decision nor the original load promise. `pendingBackgroundWork`
provides an age-bounded observation, not that original completion.

Therefore an owner that calls the existing prefetch API cannot prove when its
hint child may retire. Returning from the function, response publication, cache
publication, a polling bound or elapsed time cannot release it. The local code
has not wired that unsafe route.

The minimum choices are a closed funded handoff held for the later credential
adapter, or a separately authorized private receipt in `credential-cache.ts`
that exposes accepted registration and the exact original completion without
exposing a grant graph. No seventh production file has been edited.

## Authored qualification

The new Node fixture covers real SQLite and byte-KV generation hydration,
preverification/facet denial, lifecycle status/code, common pressure, child/hint
retention, all six strategies with 129 candidates, authoritative successor state,
and conditional feedback replacement across a held original ACK. The Workerd
fixture authors real native KV/SQLite/RPC cases for owned authentication, coverage
denial, revocation and capacity with original BYOB/EOF/unlock observations.

Only syntax, embedded syntax, diff formatting and source/privacy inspection have
run locally. Full entry/refresh parity, background acceptance, the final factory
inventory and all authored native semantics remain pending. Nothing here claims
publication readiness, default activation, deployment or a heap bound.
