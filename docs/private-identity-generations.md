# Inactive private retained generations

This local foundation adds private generation custody to the qualified private
admission bridge. It does not activate proxy authentication, Access, direct
consumers, the seven cache cores, providers, generation selection, Music or
Images. No default caller invokes the new APIs. Deployment is none.

The contract is normative application accounting. It is not a JavaScript
`sizeof`, physical heap, native allocation, GC, or whole-isolate concurrency
proof. Source closure must precede publication. Actual Node and Workerd
qualification is required after an authorized draft publication and before
landing. Local dependency-backed semantics remain `UNRUN_CODE_ONLY_HOSTED`.

## Closed ownership path

The APIs live in `worker/credential-preflight.ts`. The private owner WeakMaps
remain the only authority over proofs, continuations, full results and borrowers.
`worker/identity-generations.ts` supplies bounded representation helpers and the
factory/layout inventory; those helpers cannot register an arbitrary graph.

1. `preflightCredential` retains its existing secret-only result. Unknown and
   wrong secrets finish before generation reservation. Correct preliminary
   matching is not authentication. Preflight's own source admission still applies.
2. `prepareCredentialGeneration` accepts only a registered genuine proof. The
   binding, namespace, key and digest come from its private owner. It funds lazy
   registries, binding partition, stable entry, slot and initial borrower products
   before creating them. It reserves a slot and expands the same temporary
   ticket before consuming the proof. Failure unwinds only provisional products;
   the proof remains registered and releasable.
3. The stable index is the actual authority binding, closed `policy-bindings`
   namespace, closed proxy-key auth kind and stable key ID. Digest, provider,
   request and generation are not index keys. Two slots include constructing,
   published and borrowed predecessors, also when caching is OFF or refused.
4. `completeCredentialGeneration` calls the existing complete-admission bridge.
   It derives identity from the private continuation and retains all cumulative
   source counters. Complete current credential, policy, owner, pool and
   projection checks stay in the authority. No admission is replayed.
5. Readiness follows fulfillment of the **entire** complete-admission promise,
   including its `finally`, original acquisition/read/FIRSTcancel/unlock joins,
   and phase-lease retirement. An early graph assignment is insufficient. The
   caller signal is checked after joins. Request/signal aliases then clear.
6. Under the still-funded temporary ticket, a bounded traversal measures exact
   escaped JSON wire bytes and retained graph occurrences. A separate traversal
   deep-freezes the same parsed ordinary JSON tree. It creates no JSON roundtrip,
   key array, descriptor-value carrier or graph clone. Unknown string fields and
   own `__proto__` remain data. The genuine parsed tree has no shared subgraphs,
   accessors, hooks, Symbols, proxies, byte views or arbitrary prototypes.
7. The original dispose-only handle is removed from its WeakMap exactly once.
   Its empty frozen carrier no longer reaches the graph. The new frozen borrower
   also exposes only `dispose`; there is no raw getter, callback or serializer.
8. Optional promotion first obtains the complete shared-vector verdict while
   source backing remains exclusively owned. A provenance-checked Worker ticket
   then uses `ExactBodyCharge.replace(D)` synchronously. The successor belongs
   only to the retained receipt, never to the old temporary ticket. No await,
   source release/reacquire, independently spendable double credit or fallback
   RPC occurs. The old ticket can no longer release the retained debit.
9. If optional coordinates refuse promotion, the same graph remains uncached
   under its original full temporary ticket and slot until its last borrower.
   This does not deny a fully admitted caller solely for cache pressure.

A permitted hit verifies the stored digest, credential lifecycle, current
snapshot policy generation/availability and acquisition-age bound, then returns
another funded opaque borrow with zero RPC. This is snapshot borrowing, not a
new authentication result. Future adapters must separately establish coverage
of their requested query and carry a borrow through every use, background task
and hint. None of those adapters are activated here.

A later construction cannot be replaced by an older delayed publication. A
stable-entry sequence is a publication fence, not an index key. A failed newer
construction leaves the old publication intact. Eviction removes publication
only: borrowers retain the graph, charge, slot and all needed index owners.

## Common-arena and optional vector

Worker backing uses the existing 96 MiB counter through `ExactBodyCharge`.
Small positive safe-integer charges have no 1 MiB floor or doubling. Each DO
retains its independent 96 MiB arena. The handoff checks an actual private
Worker provenance field and rejects DO-backed tickets, despite their compatible
charge interface.

The one optional shared vector is:

| Coordinate | Limit |
| --- | ---: |
| Serialized eligibility per value | 2,097,152 bytes |
| Aggregate serialized eligibility | 8,388,608 bytes |
| Aggregate application payload | 8,388,608 bytes |
| Aggregate containers/members/elements/explicit owner and control fields | 524,288 |

Graph payload charges two bytes per retained UTF-16 key/value occurrence, eight
per number and one per boolean/null. The JSON result has no owned byte backing;
any future backing-bearing representation requires its entire backing in the
vector. No serialized text or encoded copy is retained. Escaped wire is measured
before either could be materialized. Borrowing the same immutable tree charges
that tree once; each new borrower has its own funded metadata and optional-vector
claim. Equal strings receive no interning or equality credit.

`PrivateCacheReservation` is a receipt, unlike ordinary `HotCache.publish`'s
boolean. Its scalar ledger check, exact backing transition and commit are
synchronous. Metadata receipts adopt already-funded small charges; adoption
changes only the optional coordinates, not common-arena ownership. A second
adoption is rejected. Refusal preserves existing funding. Metadata coordinates
remain claimed until their actual index/slot/borrower owners retire.

A full common arena does not force an additional destination allocation: replacing
this operation's 32 MiB with its smaller retained charge works in place. The
initial borrower is funded before hydration for this case. Additional borrowers
reserve their complete metadata before construction. Failure creates no borrow
and changes no old owner. Optional shared coordinates are never a prerequisite
for the initial temporary reservation or full hydration.

## Data phase inventory

The existing source profiles remain complete 2 MiB / record 1 MiB with all seven
counters, repeated-read charging, duplicate/unknown source metering and no reset.
The new metadata is also an explicit simultaneous component of the **same**
32 MiB temporary payload, rather than extra free CONTROL or passive scratch.
`reserveAdmissionScratch` includes that component for new generation owners;
ordinary tickets have zero and preserve their existing behavior.

Fixed metadata reservations precharge the closed layout and its possible receipt
fields. They are logical named cells, not guessed object weights. The source table
counts property-name strings, numeric/boolean cells, charge wrappers, retained
source counters, old invalidated ticket, handoff vector, retained successor and
receipt. Unused precharged transition fields are not reused for another purpose.

| Owner | Fixed payload before funding layout | Structure before funding layout |
| --- | ---: | ---: |
| Registry: three WeakMaps and ownership | 104 | 16 |
| Actual binding partition | 52 | 10 |
| Stable entry | 108 + 4K | 18 |
| Slot, source owner and handoff products | 911 + 2(K + 64 + 15) | 77 |
| Each borrower | 46 | 10 |
| Funding/receipt layout added to each row | 184 | 18 |

`K` is the actual key-ID length, at most 4,077 under the unchanged protocol.
A new isolated stable entry plus first slot/borrower therefore reserves
`2299 + 6K`, at most **26,761 bytes**, and **221 structure units**. Existing
partitions/entries retain their own funding; a new slot never releases another
slot's share. Subsequent borrowers reserve **230 bytes / 28 units** each.
The index Map's key and entry's key field are separate string occurrences.

| Worker phase | Complete simultaneous component |
| --- | --- |
| Preflight proof / prepare | Existing genuine proof plus prospectively funded metadata; full ticket expansion before proof consumption |
| Request copy and original RPC | Existing 21,020,672-byte Worker component + actual copied string fields + retained generation metadata; prospective sum must fit 33,554,432 |
| Measure/freeze after original joins | 21,020,672 + at most 26,761 metadata + 49,928 traversal scratch = **21,097,361** |
| Provisional promotion | Same temporary graph and metadata; optional coordinates earmarked, no independently spendable successor |
| Atomic replacement/publication | Exact measured graph payload replaces full source charge; metadata and handoff products remain funded independently |
| Uncached fallback | Original 33,554,432-byte ticket plus its funded metadata/slot until actual last borrower |
| Published/borrowed | One immutable graph receipt plus all live metadata receipts; no full ticket remains for a promoted value |

The 49,928 traversal bound is `8*(1+80) + 2*(24*1024+64)`: fixed counters,
current number representation, bounded active property keys and 24-level frames.
Measurement and freezing are sequential; no retained full-key index exists.
The source tree's owner remains funded throughout both traversals. New metadata
can reduce available copy scratch, but never lowers a JSON/source profile.

## CONTROL and factory inventory

The four 128-slot windows and 512 synchronous slots remain unchanged. This is an
actual Worker phase inventory, not `1024 - 965` borrowed from the DO journal.
All listed products are included before their factories. The source table names
each group in `generationFactoryCharges`.

| Group | Slots | Products |
| --- | ---: | --- |
| Persistent across RPC | 33 | Three registry WeakMaps, owners, index Map/cells, two slot fields, charge products, preparation/continuation capabilities and WeakMap entries, source owner/counter/ticket/windows |
| Prepare | 24 | Prior proof/entry, reservation/transfer frames, table arithmetic, rollback/unwind |
| RPC operation | 48 | Both entry/run/observer promises and callbacks/awaits, prospective plan/closures, original binding/id/stub/init/header/carrier, result handle and failure/unwind |
| Source | 112 | Acquisition followers, original source owner, consume/awaits, headers, reader/retirement products, decoder/wire, signal registration, grammar/descriptors, terminal continuation |
| Read | 24 | Original/propagated followers, pending/finally products, pull/await, backing views and bounded failure state |
| Terminal | 35 | Finish/FIRSTcancel, original joins, unlock/listener, UNKNOWN promise, fixed failure and unwind |
| Handoff | 168 | Measurement record/two visitors, bounded traversal/enumeration frames, conversions, receipts/weak entries/transfer/rollback, borrower products, scratch guard and publication frames |

Operation maximum is `33 + max(24,48) = 81 <= 128`; source/read/terminal
are each <=128. Synchronous handoff is `33 + 168 = 201 <= 512`.
Conservatively reserving all four full windows plus that synchronous inventory
uses **713 of 1024 slots**. The measured helper graph is DATA, while every
promise, follower, callback, execution frame, listener, receipt and ownership
index remains CONTROL. No source counter is converted into a control credit.

## Retirement and failure

No original root is replaced with a timeout, fake ACK or successful follower.
The existing private bridge preserves bounded primary presence (including literal
undefined) and independent read/FIRSTcancel/unlock origins before returning a
failure. The new wrapper leaves that error/metadata intact. New operations receive
immediate observers. Source ownership holds through original late acquisition.
UNKNOWN never becomes ready, releases a slot, shrinks or frees relevant funding.

On last-borrower retirement, graph and source-owner aliases clear before graph
credit releases. The slot leaves both fixed slot fields, then empty entries,
partitions and registry roots are removed before their funding releases. Shared
metadata-index ownership remains prepaid by each live receipt until its last
owner clears it. Invalidated opaque carriers do not retain the graph through a
WeakMap. GC is not a release mechanism.

## Authored verification

`worker/test/identity-generations.test.mjs` covers same-object freezing, opaque
promotion, exact small charges, independent vector boundaries, full-arena atomic
replacement, optional pressure fallback, two slots across OFF/rotation, wrong and
unknown preverification, forged/double consume, failure preserving old publication,
last-read abort, held/rejected FIRSTcancel and unlock with undefined/shared reasons,
late original acquisition, own `__proto__`, RPC-free borrowing and ordinary bridge
nonactivation. Cleanup is installed before work, observes every original promise,
releases finite gates first, joins all enrolled roots and preserves independent
cleanup failures without reason-value deduplication.

`worker/test/identity-generations-workerd.test.mjs` uses real Workerd DO dispatch,
SQLite, original native KV BYOB bodies and the complete private RPC path. Seven
cases cover promotion, full arena, optional cache pressure, OFF, rotation,
preverification and UNKNOWN retention. Native observations require original
read/EOF/unlock and <=16 KiB backing. The final deliberate UNKNOWN ticket remains
charged until fixture-isolate disposal; this is an accounting-hold witness, not
an original producer retirement or physical reclamation claim.

Syntax, conflict-marker, diff-format, scope and privacy checks are local/static
only. All Node and Workerd semantic witnesses are authored but unrun locally.
Before landing, the exact published head requires the native Worker suite,
both CodeQL analyses, all nine CI jobs, and all 37 actual clients plus aggregate.
