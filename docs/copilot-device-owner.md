# Copilot device token acquisition

This internal admin flow acquires the original GitHub token into its existing
credential owner. It does not enable Copilot account discovery, models or
inference. No account identity, entitlement, token expiry or refresh capability
is inferred from acquisition.

## Admin contract

Use the existing policy- or tenant-scoped grant authorize endpoint with the
exact query `?flow=copilot-device.v1`. The query selects bounded intake before
the ordinary admin JSON reader. It is not authorization. Every operation
requires a current Cloudflare Access administrator and same-origin request;
admin tokens and proxy keys cannot onboard.

The body always contains `flow:"copilot-device.v1"` and
`provider:"github-copilot"`. Begin additionally supplies `operation:"begin"`,
`githubDomain`, an explicit `intentId` and `expectedGeneration`. The domain is
`github.com` or one selected tenant under `ghe.com`. An existing terminal attempt
requires its exact `replacesAttemptId` and a new intent. Poll, cancel and status
supply only their operation and the opaque `attemptId`.

Begin reserves a new owner generation and lineage before HTTP. The selected
domain, actor, original grant key and owner binding remain fixed for the
attempt. Poll starts only after the first native interval. Pending preserves
the interval; `slow_down` increases it by at least five seconds. Absolute expiry
and next-poll timestamps survive restarts. No background poll or exchange retry
is scheduled.

The response contains only the opaque attempt ID, sanitized status, absolute
expiry, next-poll timestamp and, while pending, the native user code and
canonical selected-domain verification URL. Responses are private/no-store.
Device codes, original tokens, owner bindings and raw vendor errors are private.

## Owner ordering and uncertainty

The owner persists a dispatch fence before each physical request. Reservation
and settlement use the existing ordering tail; the remote await does not.
Cancel, revoke and authorized replacement can therefore invalidate a held
exchange. Fresh Access authority is checked after awaited preflight and again
after complete response parsing and attachment admission. Late success cannot
install into a changed generation, lineage or domain.

A single durable write installs the private original GitHub token and committed
attempt. The generic `credential` and `accessToken` fields remain empty and the
owner remains `reauth_required`. Account qualification/materialization is a
separate missing boundary. Generic grant edits strip the acquired token and
attempt instead of inheriting them.

Transport failure, restart with a dispatch fence, or unpersisted success is
unknown and cannot replay that exchange. Status can recover a committed result
after lost publication acknowledgment. An explicitly cancelled terminal attempt
may start a new intent and generation; it never reuses the old device code.

## Allocation and retirement ledger

These are operational reservations and explicit allocation bounds, not a
measurement of V8 heap or another isolate's retained buffers. The existing
96 MiB pool and qualified Copilot transport reader are unchanged.

| Phase and owner | Simultaneous explicit data | Retirement |
| --- | --- | --- |
| Admin/owner intake | At most 8 KiB raw accumulator plus 8 KiB returned reader backing; at most 16 KiB decoded UTF-16 text | Original read, first cancellation and lock retirement complete before the reader returns |
| Preparse and input validation | Existing device guard: depth/containers/members/array entries at most 4096, values at most 8192, aggregate decoded keys and strings at most 8192 units; tokenizer feeds at most 1 KiB UTF-8 | Guard and parsed graph remain within the intake reservation; closed validation retains only bounded scalar fields |
| Device request and vendor response | One bounded form request; existing reader's 8 KiB accumulator and at most 8 KiB returned BYOB backing, decoded text and the same guarded parse limits | Actual fetch, late response disposal, original read, first cancellation and lock retirement; no tee or response archive |
| Owner settlement | Bounded scalar attempt/token graph; serialized private record at most 32 KiB, including the explicit validation encoding and durable-write input | Installation/publication finishes before the exchange result references are cleared |
| Public reply | At most 2 KiB encoded JSON per owner/admin reply, with its bounded parsed/scalar predecessor | That producer's EOF or cancellation, separately from physical input retirement |

Admin intake and each small owner control call reserve 2 MiB using the existing
`BodyLease.grow(1 MiB)`. Before begin/poll dispatch, the owner grows its reservation
to 64 MiB. It does not release/reacquire the original charge. The common
admin-plus-owner exchange therefore charges 66 MiB in a shared isolate.
Competing reservations can deny the exchange before any owner fence or vendor
request. A concurrent cancel normally needs two small reservations, not a second
64 MiB exchange reservation. These charges include structural/control headroom;
the table's node counts are not converted into an invented engine object size.

The exchange result and capacity have separate lifetimes. Public cancellation
can settle while the fetch or cleanup remains held. The owner retains its first
physical cleanup continuation through `waitUntil`, then joins settlement and
public-producer completion before releasing the charge once. Cleanup rejection
is not successful authorization. Failed lock retirement cannot release capacity.
An upstream terminal token is not downstream EOF.

No claim is made about a different DO's transport buffer, physical host
disconnect propagation or producer-side cleanup acknowledgment. Those are
separate boundaries. Account/catalog payloads are not admitted by this ledger.

## Qualification

Node cases exercise real admin authorization and the owner state machine with
synthetic Access keys and intercepted HTTP. The workerd fixture uses the actual
admin-to-owner transport and a held synthetic token socket. It checks concurrent
status/cancel and withheld late installation; it is not live GitHub consent or
account/inference proof. Exact-head hosted results determine qualification.
