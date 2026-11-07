# Background registration custody

`tryRunInBackground(start)` returns whether registration was accepted, not
whether the task succeeded. It reserves one of 64 live identities before
invoking the thunk. At saturation the thunk is never invoked. An immediate
void observer discards fulfillment values and observes rejection, including
`undefined`; synchronous throws also retire their accepted registration.
Only actual original logical settlement releases an identity. No task results,
failure history, queue or retry backlog are retained by the registrar.

`backgroundMark()` is a scalar sequence boundary, not request identity.
`pendingBackgroundWork(mark)` remains nullable and awaitable. Each nonempty
facade snapshots scalar identities and monotonic visibility deadlines, then
polls with its own timers. Interleaved registrations after the mark are included;
registrations after the snapshot are not. A hard 10-second timer bounds the
facade independently of mutable wall time. The 25-second elapsed visibility
window may end the observation sooner. Completion clears that facade's timers.
Neither bound nor `clearHotCaches()` releases actual registrations. A hung task
can keep a slot indefinitely. Cache TTL clock injection is separate.

Overflow is checked before speculative side effects:

- Stale refresh leaves the original age, expiry and publication rights intact.
  Foreground loads still run under the existing cache publication rules.
- Credential prefetch does not materialize; colo publication does not hash,
  serialize, allocate a response or call `cache.put`.
- Projection repair records cooldown only inside an accepted thunk. An accepted
  failed repair keeps its cooldown; a refused repair does not consume it.
- A refused coalesced flush creates no timer and leaves its scheduling flag
  false. Unstarted selections, cursors and runtime feedback remain available to
  a later eligible request. Local feedback and cache-disabled writes retain
  their existing behavior.

Flush schedules carry an identity. Synchronous timer failure and an old
schedule's completion cannot clear a newer schedule. An explicit flush makes
an older unstarted timer inert. Existing conditional deletion of newer runtime
feedback is unchanged. Attempted additive counts are never reinserted or
replayed; no refund, rollback or producer completion claim is added.

## Evidence and limits

The Node suite covers 64/65 admission, reentrancy, original settlement,
synchronous throw/undefined, wall-clock rollback during a held facade,
interleaved snapshot cohorts, overflow side effects and flush generation rules.
Each test releases its own roots; clearing caches is not a registration reset.

The isolated Workerd fixture uses 63 labelled held fixture roots plus a real
cache-hit additive flush. The real SQLite commit precedes an explicitly labelled
HTTP acknowledgment fault. FIRST original cancellation settles before a held,
deliberately rejecting cleanup continuation; unlock and actual flush settlement
must precede slot reuse. SQL remains baseline plus one with no empty replay.
An unrelated public request enters before those registrations, then delivers,
accounts and performs same-context I/O while its interleaved facade expires.
Only the fixture's facade bound is shortened in memory; this is not a measurement
of the production 10-second duration. Original requests consume small ingress
and stay alive as explicit fixture lifetime support. Cross-request state is
scalar-only. Release and original client/background joins precede disposal.

These are logical registration and synthetic fixture claims. The registrar
does not guarantee platform execution, originating-request physical lifetime,
inner fetch/KV/DO retirement, whole-heap bounds or completion of a common memory
ledger. Existing facade consumers remain best effort; an actual operation such
as `flushSelections()` is distinct from its facade. Source and authored coverage
are not runtime qualification.
