# Credential mutation cold-import join

Credential mutations start the existing credentials, policies and users imports
in that order. Personal mutations also start bindings. All three or four imports
remain concurrent. Each promise receives a fulfillment-discarding and
rejection-observing wrapper immediately after it starts.

The join retains only void wrappers, a failure boolean and the first observed
original rejection reason. The boolean distinguishes rejection with `undefined`
from success. Later failures are observed without replacing the first reason.
No fulfilled list-result array or all-settled result archive is added.

The mutation handler awaits every started logical import before rethrowing a
failure or calling `/credentials/mutate`. Any failed import prevents that call.
Success retains complete cold hydration and final owner rereads before the one
mutation. Existing validation, authentication, actor provenance, collision,
holdings and quota checks remain unchanged. Safe `HttpError` identity remains
intact; the existing public handlers still sanitize ordinary errors.

## Scope and limits

This joins the **logical list/import promises**. It does not qualify physical
retirement of generic unselected authority replies, KV operations or Durable
Object calls. It does not bound the inherited error graph, imported collections
or the common request memory ledger.

A hung sibling can hold outward failure indefinitely. There is no new timeout,
signal, cancellation, retry, replay, rollback or refund. Imports already committed
before a failure can remain in SQL. An initializer acknowledgment failure after
the real commit does not establish that the import was unsent.

## Evidence

Focused Node tests reuse the SQLite credential fixture. They cover admin-three
and personal-four concurrency, a later-index first failure, `undefined`, a second
rejection while a sibling is held, original error identity and zero mutations.
Separate cases fail the initial owner list, KV list/get, initializer ACK after
commit and final owner reread. Success checks all rereads before one mutation.

The isolated Workerd fixture calls actual `POST /v1/admin/credentials` with a
synthetic bearer and `POST /v1/session/credentials` with a local session cookie
and matching Origin. Each case uses a real SQLite owner and isolated synthetic
KV seeds. Only the actor is initialized through `/users/initialize`; global
users remain cold. Invalid authentication and malformed mutation input start
zero imports.

HTTP barriers originate inside the public request's import calls, after
authentication and validation. The public response remains pending while one
import is held. Scalar observations and a test-only raw SQL endpoint inspect
state without triggering an import. Release/drain cleanup is registered before
clients; arrival waits race originating rejection and premature completion.
These tests do not claim network-reader or whole-heap qualification.

All authored cases require fresh hosted execution. Local dependency reuse may
be refused; code-only syntax checks are not semantic proof.
