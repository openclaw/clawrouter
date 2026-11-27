# Refresh ownership and settlement

A cloud-owned refreshable grant must use a **fresh dedicated login**. Never copy
an active Claude Code login or a refresh token retained by another program.
ClawRouter cannot fence an external client, recognize already-diverged members
of an upstream token family, or promise an unlimited session lifetime.
Keep-warm remains quota-aware inference maintenance, not a lifetime cure.

## Import guard and provenance

All imports, ticket submissions, replacements, legacy materializations and
rotations reserve refresh-token ownership before committing credentials. One
reserved object in the existing `GRANT_CREDENTIALS` binding serializes claims
across **all policies and tenants**. It uses a randomly generated, durably stored
256-bit HMAC key and domain-separated HMAC-SHA-256 fingerprints. The index stores
only the full fingerprint, owning grant key and a sent-to-provider bit, never
token text or a fragment.
The HMAC key, fingerprints and raw tokens never enter grant projections, admin
responses, diagnosis records or logs. No new binding or deployment secret is
required. The existing private credential binding is the trust boundary.

An unseen fingerprint checks pre-index grants discovered through KV, reading the
current credential owner rather than trusting stale token projections. New
credentials reserve first, including when KV publication later fails. Disabled
grants still own their refresh authority. Concurrent claims admit one owner.
Supported KV-only raw access tokens have no refresh authority and do not block
unrelated imports/rotations. Malformed object-shaped legacy data and unavailable
discovery/owners fail the import closed. A conflict returns a generic
`409 refresh_token_already_owned` without disclosing the other tenant/grant.
Independent logins for the same account are allowed; account identity is not a
refresh-family identifier.

Reservations, including those preceding a failed credential write, remain with
the original owner. Old fingerprints are retained across rotation/revocation to
prevent transferring a stale ancestor to a second owner. A sent fingerprint
also prevents removing/revoking an at-risk token and importing it again at the
same grant key; only continuation of the current owner-held generation is allowed. Retry a failed import
at its original grant key; otherwise use a new dedicated login. The private
index grows by one small record per distinct token and is not a token backup.
Do not delete the registry or rotate its private key independently of its index.
Pre-index discovery relies on existing KV discovery, as the current grant catalog
does; this is not an inventory of unknown external credential copies.

`credentialProvenance` is owner-issued: `clawrouter_oauth` only for the trusted
OAuth callback, `imported` for manual/ticket intake and legacy refreshable grants.
An admin payload cannot assert OAuth minting. Metadata edits and rotations retain
provenance; replacing refresh authority records its new source. Cards and the
Access inspector warn that imported refreshable tokens may also be refreshed by
another program. This is a warning, not proof that external custody was exclusive.
No new OAuth login flow, Keychain reader, 1Password rescue, or enrollment action
is added.

## Durable outcomes

Before token egress, the owner commits an attempt ID and exact credential
generation. The DO retains completion with `waitUntil`, independently of the
observing caller. The existing serialized owner tail remains in place. Both
success and failure settlement re-read the current generation/attempt; a newer
credential wins. A successful pair is persisted together before success is
published. A stranded attempt after restart becomes an at-risk diagnosis.

The secretless diagnosis from `grant-refresh-health.md` now distinguishes:

| `failureClass` | Meaning / next action |
|---|---|
| `permanent` | Existing allowlisted 400/401 invalid-grant/token/reuse rejection; reauthorization required. |
| `retry_after` | Explicit throttling or provider retry deadline; wait at least that long. |
| `transient` | Trustworthy rejection or pre-send configuration failure; bounded retries. |
| `ambiguous` | Request may have consumed the token, with no trustworthy successful pair (transport/body loss, invalid success, abandoned attempt). No automatic or forced replay. |
| `provider_ok_persist_failed` | A successful pair was received but durable settlement failed. No replay of the old token. |

At-risk grants retain their existing status/access credential, but all refresh
entry points refuse replay. Dashboard incidents remain visible even alongside
healthy fallback. The next attempted refresh re-reads authority. Replacing only
metadata/access fields or resubmitting the same refresh token cannot clear the
fence; removing the refresh token while retaining the same primary credentials
also retains the uncertainty block or permanent rejection. A fresh dedicated authorization or fresh
access-only credential is needed; either full replacement or an incremental
access-only update can supply that fresh credential. If all storage writes fail,
the pre-egress marker remains the durable protection; a later owner read reports
an unknown outcome rather than claiming persistence succeeded. Provider rotation
and local storage cannot form a distributed atomic transaction.

## Retry budget and alarms

Safe retries use equal-jitter exponential delay: 15–30 seconds initially,
30–60 seconds next, capped at 120 seconds. Within the remaining access lifetime,
the delay is shortened to leave another attempt when possible (minimum one
second). Numeric and HTTP-date `Retry-After` values are a **floor**, even beyond
access expiry; forced refresh and quota recovery cannot bypass it. Same-token replacement and
access-only edits preserve this floor, as well as terminal/at-risk diagnosis. No retry can
guarantee availability when the provider requests a long hold.

Idle alarms and keep-warm remain. The shared alarm can service quota/keep-warm
without replaying a fenced generation or bypassing a refresh retry deadline.
Success clears the failure episode and resumes the normal pre-expiry alarm.
Session-expiry tracking is a separate change. Alerts remain dashboard-only.

## Pool availability and known-unsent failover

A non-permanent refresh failure does not become `reauth_required`. Its owner
publishes a separate secretless refresh block to both routing projections: an
immediate indefinite block for uncertain settlement, or the retry deadline for a
safe retry. A safe retry hold is evaluated against the current clock and the
same five-minute access-token margin used by materialization: an otherwise valid
access token remains usable before that margin. Uncertain settlement cannot
establish that the old access token is still usable, even with a future expiry. Successful refresh or fresh replacement clears
the block. The stored diagnosis/dashboard incident remains visible.

A race or stale projection can still select a credential whose owner then
refuses materialization. Before dispatch, the five credential errors
`grant_refresh_failed`, `grant_refresh_at_risk`, `grant_refresh_persist_failed`,
`grant_reauthorization_required`, and `grant_credential_missing` permit one
reselection with that grant excluded when policy failover is enabled. If no
alternate can prepare, the original error is returned. This consumes the same
single failover allowance as a later upstream 401/403/429; it does not add a
second retry, including across Fusion reservation and final preparation. No failed
preparation dispatches an inference request.

Previously diagnosed owners lazily republish both routing indexes once on an
owner read. Publication remains pending until both indexes acknowledge it,
including newly diagnosed abandoned attempts and recovered credentials. A stale
projection may reach the owner once, but cannot keep selecting it indefinitely.

Pinned requests and continuations never switch owners. At-risk and settlement
failures use the existing continuation-restart response, requiring full input
rather than retrying an unrecoverable pinned credential. Threshold/most-remaining
ranking, hysteresis, stickiness, quota cooldown and environment-fallback policy
are unchanged. A temporarily blocked configured pool remains a configured pool;
it cannot implicitly reopen environment credentials.
