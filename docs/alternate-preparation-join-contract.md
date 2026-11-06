# Alternate preparation settlement

An eligible rejected provider request can prepare one alternate grant. The proxy
captures that single `prepareSelected` promise and immediately attaches a void
observer for both fulfillment and rejection. The original promise remains the
input to `HttpOperation.wait`; the observer does not replace it or retain its
fulfilled preparation result.

The local selection catch still discards a preparation failure. Its `finally`
now joins the observer. After that join, the original operation signal is checked
before retry eligibility, including when preparation rejected and no retry exists.
The existing checks around original-response cancellation remain unchanged.

## Preserved behavior

- Eligibility, arguments, excluded grant, selection recording, connection and
  the one-alternate ceiling are unchanged.
- A noncanceling preparation failure preserves the original provider rejection.
- Caller cancellation and the existing endpoint deadline retain their categories.
  No new timer, signal, retry, cancellation or compensation is introduced.
- Before alternate dispatch the original response is canceled and cleared.
  A thrown or rejected alternate fetch remains potentially paid; it cannot borrow
  the original rejection's nonbillable evidence.
- One usage event and the original reservation IDs own settlement.

## Qualification boundary

This joins logical preparation settlement only. A hung preparation can hold
outward completion indefinitely. It does not establish physical retirement of
inner fetches, response bodies, KV or Durable Object operations, nor of the
original provider response. Collection bounds, error-graph bounds, background
registration and the common memory ledger remain separate.

## Proof

Focused Node cases hold alternate admission after 401, 403 and 429 and cancel by
caller or existing deadline. Fulfilled and rejected late preparation must both
settle before outward failure, with one initial provider request and one event.

The isolated Workerd fixture uses the registered `/v1/responses` route, current
request bindings, real SQLite authority/grant/budget/usage owners and synthetic
subscription grants. A test-only case namespace keeps owner projection calls in
the same authority scope. Original-request HTTP barriers hold only excluded-key
alternate admission. The diagnostic client stays connected while the original
routed signal is aborted. Reservations and persisted usage are read after client
and background drains, before runtime disposal.

The final-await regression uses an ordinary, non-streaming 429 and rejecting
alternate preparation. A non-async fixture observer attaches to the original
`HttpOperation.wait` return and returns that same promise. Its rejection callback
queues one abort microtask while the signal is active. The proxy's final await
then yields before the outside check. The void observer may already be settled;
this is a final-await continuation interval, not a pending native-read claim.

Both final-await instances observe the actual registered public-route handler's
returned response in the originating request. The same diagnostic wrapper
captures its status, consumes that original small body once, distinguishes body
fulfillment/rejection and joins existing request-local background observers before
returning a bounded diagnostic envelope. Diagnostic transport is separate from
routed status; outer socket failures remain unexpected test failures.

The fixed handler must return actual 502 with a fulfilled `provider_unavailable`
body, one `client_error` event and original-ID settlement without alternate
dispatch. A separate fixture instance removes only the unique outside fence
through an in-memory bundler hook and must observe actual returned 429, recording
its body's outcome separately. This does not claim wire delivery of an aborted
429 body. Shared production source is never changed. Ordinary held, no-abort,
successful, disabled and uncertain cases retain direct HTTP responses and their
existing accounting assertions. The initial socket failure's specific instance
and cause remain unproven; amended evidence qualifies this new observation boundary.

Authored cases and syntax checks are not execution proof. Final-head hosted
Worker/Workerd, normal CI/security and all actual consumers must qualify before
landing. No deployment or vendor compatibility is claimed.
