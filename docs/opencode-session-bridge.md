# Scoped OpenCode session bridge

The client-to-router boundary is the existing `x-clawrouter-session-id` header.
The existing correlation parser validates its trimmed, nonempty ASCII value
with a maximum of 256 characters. Its existing precedence over legacy session
headers remains unchanged. Conversation IDs need not be UUIDs.

A native client resolves explicit `x-opencode-session` headers case-insensitively
before automatic conversation identity, then carries that effective identity
through the router header. Direct-provider behavior remains separate. Absence
of an effective conversation identity must remain absent; do not substitute a
shared value, proxy credential or caller request ID. A standalone call can use
its independently generated turn identity, but must not reuse it for unrelated
calls.

The runtime exports
`openCodeSessionHeader(request, auth, selection, upstream, destination)` from
`worker/opencode-session.ts`. Common dispatch calls it after original credential
materialization and final destination construction, before budget reservation
and dispatch. Only the `opencode` and `opencode-go` providers, canonical
`https://opencode.ai` origin, and matching HTTP POST Chat, Responses or Messages
formats qualify. Model eligibility, declared public routes and upstream path
validation remain independent. Google formats and WebSocket transport are not
activated by this helper.

The upstream `x-opencode-session` value is `crs_` plus a domain-separated SHA-256
handle over the existing authenticated continuation scope, selected provider,
destination origin, original grant key and credential lineage, and validated
conversation identity. Environment credentials use the existing materialized
credential fingerprint pattern. Static native session headers are excluded
from that fingerprint. Grant lineage is owner-issued; missing ownership denies
preparation rather than falling back to another credential.

Conversation identity excludes model, endpoint path, request ID, policy
generation, credential refresh generation and cache settings. The same caller
and original credential owner can therefore continue across qualified model
paths and cache-disabled turns. Another principal, caller credential, policy
scope, provider, grant owner or environment credential receives a distinct
handle. No raw conversation, email, upstream credential or proxy secret is
placed in this header.

Absent conversation identity receives a fresh random nonce held in a WeakMap
for that ingress Request only. Repeated preparation of that request can reuse
its nonce; a separate standalone call cannot. This handle grants no upstream
authority and creates no persistent session store. Existing admission,
revocation, grant priority and failover behavior remain unchanged.

Common dispatch deletes caller, endpoint and static-provider native session
header overrides and raw router session-attribution aliases before adding the
derived value. Non-generation operations
receive no derived session header. Worker fixtures cover real native/manifest
dispatch, multiple models and API paths, disabled caching, original grant and
environment credentials, reconnection, caller isolation, malformed IDs,
standalone calls, origin denial and zero-egress revocation.

Provider declarations and actual client composition remain separate activation
requirements. This change adds no model metadata field, provider snapshot or
generic header configuration system.
