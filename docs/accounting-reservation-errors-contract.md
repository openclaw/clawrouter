# Accounting reservation error preservation

`reserveBudget` starts the existing policy, daily, weekly and provider reserve
legs concurrently. It joins every started reserve operation before returning a
reservation or starting failure cleanup. The first rejected leg in plan order
selects the original reason, independent of completion order. A rejection with
`undefined` is still a rejection.

## Acknowledged reservations and cleanup

Only fulfilled reserve operations contribute acknowledged reservations. On a
reserve failure, each acknowledged reservation is settled to zero using its
original reservation ID and ledger object name. A rejected operation whose
commit acknowledgment was lost does not become an acknowledged success. This
change adds no reserve replay, extra settlement attempt, compensation or refund
inference.

The existing ledger settlement is attempted once. If it fails, its existing
durable queue fallback is attempted once. Successful queue recovery counts as
successful cleanup. Generic cleanup remains concurrent; Search cleanup remains
serial and continues after a failure. Both paths join all started operations.
A held sibling or cleanup therefore holds outward completion.

If no reservations were acknowledged, or all cleanup succeeds, `reserveBudget`
throws the identical original reservation reason. It does not wrap or replace
that reason, including when the reason is `undefined`.

## Terminal cleanup failures

If any cleanup fails at both ledger and queue boundaries, the existing outer
`HttpError` remains `503 accounting_unavailable`, with this unchanged message:

> Budget reservation rollback could not finish; retry after accounting recovers.

The error carries a private, nonenumerable, nonwritable symbol property. Its
frozen diagnostic record retains the original reservation reason and a frozen
array of every terminal cleanup failure in original reservation order. Each
failure retains the original reservation ID, ledger object name, ledger reason
and queue reason. Both reason properties remain present when their values are
`undefined`. Distinct failures are not deduplicated by reason identity.

Diagnostics preserve original references. They are not enumerable error fields,
public JSON, log payloads or an exported inspection API. HTTP and WebSocket
consumers continue to see the existing outer classification and precedence.
No caller or helper API changes.

The shared private implementation also serves exported `settleBudget`. That
function still throws its first terminal queue failure in reservation order
after joining cleanup; it does not expose the private collector or introduce a
new wrapper or aggregate exception for its callers.

## Verification and limits

Focused Node coverage holds each reserve leg and successful cleanup siblings,
reorders rejection completion, retains literal `undefined`, checks all ordered
ledger/queue pairs and successful queue recovery, and checks public error JSON.
It also checks exported settlement concurrency and models the existing Search
call interface to verify serial ordering. That model is not physical Search
retirement evidence. Existing successful reservation observations remain covered.
Test roots are immediately outcome-observed; cleanup releases gates and joins
all roots while preserving the primary and independent failures.

This contract covers logical promise settlement and error identity. It does not
establish physical fetch/body/KV/DO retirement, platform lifetime, bounded error
graphs, measured heap or completion of a common 32 MiB memory budget. Arbitrary
original error graphs remain retained references with no size qualification.
