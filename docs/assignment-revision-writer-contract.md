# Assignment revision writer

The authority writes `assignment-rules.v1:sha256:<64 lowercase hex digits>` for
an already-required assignment-state change. The digest input is exactly the
existing ordered `assignmentRulesRevision()` JSON serialization. Rule order,
nested array order and its selected fields are unchanged. `generatedGroup`
remains excluded from that serialization; it is still captured for evaluation.
This is a writer change, not a migration or response-size limit.

The original `evaluateUserAssignments()` API remains synchronous and retains its
legacy output behavior. The authority uses an additive private interface:
capture immutable copies of the ordered rules and nested arrays; hash that same
snapshot; evaluate through a genuine WeakMap-backed prepared capsule. Supplied
digests, copied capsules and extra RPC revision fields cannot select equality.
No bytes or caller-provided validation flag substitute for a genuine capsule.

Both evaluator no-op checks accept either the exact legacy text or its matching
compact digest. An ordinary generated-group-only change is therefore still a
legacy no-op. Forced evaluation with nonempty policy IDs can legitimately change
the generated assignment group, as before. Forced unchanged groups/assignments
retain the original revision bytes and timestamp. UNKNOWN evidence does not
force reconciliation or conversion. Legacy state is considered only under its
existing absence semantics.

## Owner-local reconciliation order

After the existing body parser completes, reconciliation captures its predecessor
and installs a separate void slot before snapshot work or any await. Snapshot
failures, including `undefined`, still join that predecessor before failing and
releasing their slot. Immediate void observers discard successful results and
observe every rejection; the tail does not archive result or cause graphs and
cannot be poisoned by a failed operation. Older completion never clears a newer
tail.

Each turn awaits its predecessor, hashes its captured rules, then reads the
current canonical user. Evaluation and any write run synchronously after that
read. Concurrent profile changes therefore remain authoritative, including
manual groups, disabled state, role, tenant, retention and budget overrides. A
missing canonical user returns 404 instead of being resurrected from a stale
caller snapshot. The route awaits the result before JSON serialization.

This orders reconciliation entry only, not HTTP arrival, all owner routes or
durable/global operations. Unrelated profile mutations remain concurrent. A
hung hash can hold this queue indefinitely. One tail does not bound queue length,
queued graphs, collection allocation, original error graphs or physical I/O
retirement. No whole-DO lock, cancellation, retry, rollback or refund is added.

## Authored evidence and boundaries

Focused Node cases compare synchronous and prepared behavior, forged capsules,
mutations after capture, both no-op forms and generated-group forced parity.
They measure a 1,000-rule legacy revision above 64 KiB. Direct-owner getter faults
are explicitly non-HTTP evidence. FIFO cases cover later snapshot/hash failure,
including undefined, current profile changes, successors and SQL deletion.

One isolated Workerd fixture uses authenticated public admin all/email
reconciliation and rule PUT, actual KV cold hydration/final SQLite rereads, and
byte comparisons for unchanged legacy SQL/KV records. Exact synthetic revision
bytes select test-only crypto continuations: the real digest completes before
its result is held or rejected. This is logical continuation evidence, not a
pending native crypto snapshot. Body-parse completion is observed without an
await before actual enrollment. Each invocation captures its own gate behavior.
Current-request handles, original-client/background joins and raw SQL inspection
precede disposal. Labelled SQL deletion is not a new public delete endpoint.

Semantics remain unrun until fresh hosted qualification. Existing bulk limits,
ACK ownership, generic transports, collection bounds, generated-group validation,
automatic conversion and common-memory closure remain separate work.
