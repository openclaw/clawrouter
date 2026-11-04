# MiniMax device onboarding

MiniMax device onboarding uses the existing credential owner. It requires a current verified Cloudflare Access administrator and an explicit same-origin browser request on every operation. Admin tokens, local sessions and proxy keys cannot start or manage this flow. No live consent, provider account or credential is provisioned by the implementation tests.

Use `POST /v1/admin/upstream-grants/policies/<policy>/<tokenRef>/authorize` (or the existing `tenants` scope). Requests use the closed `flow: "minimax-device.v1"`, `provider: "minimax"` discriminator.

- `begin`: `region` (`global` or `cn`), a fresh bounded `intentId`, and `expectedGeneration` from the current admin grant record (zero for a new grant). Optional `priority` and `weight` retain the existing bounds. To replace a terminal attempt, also supply its exact `replacesAttemptId` and a new intent. An UNKNOWN attempt cannot restart at the same credential generation; explicit administrator revocation or replacement is required first.
- `poll`, `cancel`, `status`: the returned `attemptId`. No caller token URL, resource URL, actor, credential, PKCE state or polling interval is accepted.

`begin` returns the approved native user code and verification URI only after complete bounded decoding. Present that code to the administrator before sending a separate `poll` request. There is no automatic polling. Polling continues only after a codec-decoded pending response, no earlier than the native interval in milliseconds, with a 2,000 ms default/minimum. Absolute native expiry applies; the router additionally bounds one attempt to fifteen minutes. No `slow_down` interpretation or transport retry is added.

Responses are private/no-store and contain only the opaque attempt ID, sanitized status, expiry, next-poll time, and (while pending) the approved user code and URI. Tokens, PKCE verifier/state, issuer errors and private owner records are never returned or logged. The administrator identity is stored as an origin-bound digest, not an Access assertion.

## Owner lifecycle

One private attempt lives on the existing credential row. Starting a new explicit lifecycle advances owner generation and lineage, retires the previous credential, and reserves the existing grant attachment. A durable `begin_unknown` or `poll_unknown` fence precedes each physical POST. Reservation and settlement use the existing serialized credential tail; the remote response is awaited outside that tail. Cancellation, revocation and replacement can therefore invalidate the attempt and abort an in-flight exchange. Current admin authority is checked again after remote work and before installation.

The native global/CN codecs own S256, fixed issuer endpoints, approved verification origins, state validation, `expired_in`, status and regional Anthropic resource validation. Network work has a 30-second deadline, manual redirects and the existing 8 KiB/8,192-chunk complete UTF-8 JSON reader. No environment, other grant, speech binding or cross-region substitution is used.

Successful token decoding does not install through generic grant PUT. One owner write commits both the new credential and terminal attempt; existing token ownership and attachment admission precede that write. Existing attachment/projection publication follows it. A publication failure or lost commit ACK can recover the committed result through `status`, without another token exchange. A failed credential commit, malformed/ambiguous response or abandoned dispatch fence stays UNKNOWN. Revocation is authoritative when checked; it cannot retroactively retract an exchange already authorized and sent.

Terminal attempts discard private session/authorization data. Duplicate begin/poll operations return the same current attempt and do not send a second exchange. An old intent/generation cannot restart a replaced lifecycle. No new store, queue, alarm loop, background recovery or device-poll session in the one-shot OAuth nonce store is introduced.

## Qualification

Synthetic tests exercise the real admin handler, signed Access assertions, credential owner and SQLite attachment authority. They cover regional success, closed input/authentication, PKCE, intervals/expiry, concurrency, cancellation/revocation/replacement during remote waits, foreign scope, late success, restart fences, malformed native output, atomic persistence and lost ACK/publication recovery. Hosted TypeScript, Worker, manifest and native consumer gates qualify the exact published head. Live consent and account entitlement remain separate from these deterministic proofs.
