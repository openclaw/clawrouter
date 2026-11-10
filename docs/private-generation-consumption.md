# Private generation consumption — local implementation checkpoint

This inactive slice starts at PR976's qualified retained-generation foundation.
It does not activate ordinary proxy, HTTP, Access, direct, provider or credential
cache callers. The ordinary entrypoints remain unchanged. This checkpoint is
**not a publication candidate**: the cross-request flush completion contract and
complete CONTROL/factory closure below remain open. Local semantics are
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
- Accepted background registration, the closed prefetch permit, original load,
  scalar publication polling, and void completion settlement. Rejected registration must start nothing.

No pending/hint callback, arbitrary reason graph or native controller is charged
as passive collection data. No quota/profile change is authorized by this table.

## Closed owned prefetch receipt

The seventh-file boundary adds `prefetchOwnedGrantCredentials` beside the
unchanged ordinary void API. `prepareCredentialGenerationPrefetch` validates a
real hint and actual authority binding, reserves positive common-arena backing,
and acquires a separate hint child before any registration. It copies only the
required credential binding and scalar cache configuration. It exposes no grant,
materializer callback, loader or result graph.

The cache module alone mints a nonescaping permit. The preflight module's named
materialization command requires that permit and the genuine single-use cap.
Only the existing credential-cache loader receives the independently parsed
reply. The public receipt contains `accepted` and, on acceptance, only
`completed: Promise<void>`.

OFF, HIT and rejected background registration start no materialization. They
unwind only the provisional child. Accepted work immediately observes both
outcomes of the actual `credentials.load` promise, including synchronous throws
from the start boundary. The child survives publication/hint eviction, an own
request's scalar publication wait, and becoming the loader after that wait.
The original load includes publication-finally and the existing materialization
fetch/read/FIRSTcancel/unlock joins. UNKNOWN holds the original promise, receipt,
child and backing. Cleanup clears command, binding, original-work and hint
aliases before releasing the child and settling the void receipt. Independent
registration and cleanup failures remain separate origins, including shared
reason objects and literal undefined.

This receipt owns the OLD hint alias only. It does not retire the independent
credential-cache entry or remote DO reply, and does not claim native producer
retirement, a physical ACK or a heap bound.

The current implementation reserves a 32 MiB temporary component for the new
materialization chain, plus separately backed lazy registries. ID conversion,
configuration normalization and retained ID occurrences are checked before their
factories. This reservation is **not yet a complete numerical fit proof**: the
full materialization/loader/source/terminal overlap must be reconciled with the
complete operation table. No unused slots from PR976 are treated as credit.

## Concrete unresolved flush completion contract

The current local implementation stores `slot.scheduled.completion`, the original
flush owner promise. A later request's explicit
`flushCredentialGenerationRuntime` can await that promise. This is a real source
boundary gap: HotCache deliberately uses scalar polling in the joining request
because Workerd does not permit foreign-request I/O ownership to move with a
shared Promise. The new prefetch receipt uses that existing cache path; the
new explicit flush currently does not.

Two narrowly different contracts are possible within the same production scope:

- Explicit flush returns only the calling request's original cohort receipt;
  already accepted foreign cohorts remain held by their own children.
- Explicit flush also waits for foreign cohorts via a separately funded scalar
  status boundary, while each original owner alone joins and retires its roots.

The second option must separately specify terminal failure delivery and must not
turn a timeout, scalar disappearance or publication into retirement credit. The
first must not be described as a drain of all foreign originals. This choice is
pending ROOT disposition. No runtime failure has been attributed to it. The
shared-promise path is local-only and publication remains held.

## Authored qualification

The new Node fixture covers real SQLite and byte-KV generation hydration,
preverification/facet denial, lifecycle status/code, common pressure, child/hint
retention, all six strategies with 129 candidates, authoritative successor state,
conditional feedback replacement across a held original ACK, opaque refresh,
ordinary runtime-merge parity and detached account/snapshot aliases. New prefetch
witnesses cover OFF/HIT/saturation, accepted synchronous undefined failure,
held original work, publication joining and independent shared-reason failures. The Workerd
fixture authors real native KV/SQLite/RPC cases for owned authentication, coverage
denial, revocation and capacity. It also authors actual GrantCredentialObject
materialization with original BYOB/EOF/unlock and explicitly labelled post-native
read/FIRSTcancel holds. These fixture holds are not new native ACK claims.

Only syntax, embedded syntax, diff formatting and source/privacy inspection have
run locally. Full source/factory closure, the cross-request flush decision and all authored
native semantics remain pending. Nothing here claims
publication readiness, default activation, deployment or a heap bound.
