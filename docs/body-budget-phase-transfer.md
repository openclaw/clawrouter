# Atomic body-budget phase transfer

`BodyLease.splitCharges(retainedInputChargeBytes, responseChargeBytes)` returns
`[retainedInputLease, responseLease]` or `null`. Both arguments are **exact charged
bytes**, not input sizes. In contrast, existing `grow(inputBytes)` charges twice
the input estimate once it reaches the existing minimum. All operations use the
same 96 MiB isolate pool.

The source must hold a positive charge and must not have transferred it before.
Both successor charges must be positive safe integers; their sum must fit the
pool together with every unrelated lease. Zero, negative, fractional, nonfinite
and excessive values are rejected. There is one synchronous capacity decision,
with no await and no release/reacquire interval. Failure returns `null`, creates
no successor lease and leaves source ownership and global charge unchanged.

On success the source is permanently transferred: `leased` is false, `release()`
is harmless and idempotent, and future `grow()`/`splitCharges()` cannot resurrect
it. Each successor owns exactly its requested charge and can release it
independently, in either order. A successor may transfer its own later phase.
Ordinary leases that have never transferred retain existing grow/release/reuse
behavior. The primitive does not subscribe to an AbortSignal; the caller must
move cleanup ownership synchronously to the returned leases.

For the approved future phase, a `grow(32 * MiB)` ingress lease charges 64 MiB.
`splitCharges(32 * MiB, 64 * MiB)` replaces that charge with 96 MiB total. An
unrelated 2 MiB charge makes the transfer fail with the original 64 MiB intact.
After the unrelated charge releases, the same source can retry successfully.

## Allocation preconditions and scope

Before transfer, the caller must explicitly retire every parser, raw-byte,
clone, string, Blob and transport owner not covered by the successor lifetimes.
The input charge must cover all retained input allocations; the response charge
must cover all overlapping response allocations. A lower charge is not evidence
that an allocation was retired, and garbage collection is not a precondition the
primitive can verify. No paid dispatch may rely on an unacknowledged transfer.

This foundation changes no route, body limit, parser, credential, asset authority,
provider schema or pool size. It does not activate reference images. Actual
ingress/clone retirement, response transport composition and original authority
still require their separate accepted implementation and runtime proof.
