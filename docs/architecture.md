# Architecture

ClawRouter keeps the request path small and provider-neutral. Provider manifests
compile into one immutable catalog; runtime modules enforce identity, access,
readiness, retention, budget, forwarding, and accounting in that order.

## Control plane

`ACCESS_CONTROL` is canonical for policies, proxy credentials, users, policy
bindings, provider connections, OAuth authorization state, upstream-grant pool
membership, and sanitized grant runtime state. Existing KV data is imported
once per resource family and recorded with a Durable Object migration marker.
After that marker, missing records remain missing; request paths never resurrect
stale KV state. The authority checks the marker when accepting an import, so
an already-running KV read cannot seed records after migration closes. Migration
callers return a fresh canonical read, never their local seed copy; concurrent
canonical updates take precedence. The authority also owns import precedence
and result ordering instead of duplicating those decisions in client-side maps.
Assignment rules, scoped upstream-grant secrets, and provider
health remain outside that global authority because they have separate lifecycle
and consistency needs. `GRANT_CREDENTIALS` is the canonical raw-secret owner,
sharded one Durable Object per grant. KV holds its redacted routing projection;
a legacy secret-bearing KV grant is imported and scrubbed on first use.

Public HTTP Responses affinity uses authorization-scoped `ACCESS_CONTROL`
objects with additive SQLite tables. They store hashed response/turn identities
and their immutable route and credential lineage, with fixed expiry and bounded
alarm cleanup. `GRANT_CREDENTIALS` issues lineage and preserves it during its own
refresh; explicit credential/account replacement invalidates it. The existing
response reader registers identity evidence before publication, retaining
backpressure, cancellation, and billable usage if storage fails. See the
[Responses continuation contract](api-reference.md#responses-continuation-contract).

Response-key rows also carry nullable retained-tool evidence, separate from the
six immutable routing fields. A worker-generated producer claims `pending` before
publishing an identity, then qualifies it once from captured ancestry, tagged
input declarations, and completely observed output. Legacy/null and pending facts
remain unknown. Turn-state aliases carry no pricing evidence. Another producer,
including an older claim-less writer, cannot reuse a row with non-null evidence.
The same authorization scope, 30-day expiry, capacity counter, and alarm own both
facts; no tool schemas, output, or opaque compaction payloads enter the index.

The existing streaming parser feeds independent scalar-usage and tool-inventory
projections in 4 KiB feeds. Qualification bounds nesting, scalar fields, 1,024 total
selected item/tool entries, and 1,024 output-item associations; exceeding a bound
loses qualification, not wire delivery. Retained input and each complete output
snapshot use one aggregate inventory bound. Streams count each associated item's
largest observed inventory, without counting repeated terminal output twice.
Explicit malformed added inventories stay unknown even after an empty completion;
an absent inventory or transient status can still receive a valid completion.
Item completion plus a matching sparse terminal supports Codex streams without
requiring repeated terminal output.
Known output positions must be contiguous, and every added or selector-referenced
item needs its matching `item.done`; anonymous done-only items remain supported.
Unknown declarations, opaque references, compaction, failed observation, and
incomplete inventories cannot
certify token-only history. Identity claim failures stop publication. A transient
final-proof failure after an acknowledged claim leaves pending/unknown or that
producer's committed proof, while delivery and accounting continue; semantic CAS
conflicts still fail publication.

This is a producer-only rollout. Pricing, budget admission, and receipts do not
consume these facts yet. A strict consumer requires separately reviewed handling
of opaque history and verified deployment of this producer; recording evidence
alone does not repair inherited-tool pricing enforcement or add compact routes.

The credential owner also sequences attachment changes in `ACCESS_CONTROL`.
An explicit grant write records a pending pool proposal before storing credentials;
the previous provider stays attached until that store commits. Active proposals
reserve one of the 32 active slots per scope/provider; inactive proposals use
`pending_inactive` and reserve no active capacity. Neither can be selected.
Paused and reauthorization-required rows retain attachment presence and free an
active slot. Revocation commits a secretless tombstone before detaching all of
that key's provider rows. Existing pool rows remain `legacy` and selectable.

Each credential generation records whether index publication is still pending.
The owner repairs that fact before materialization or maintenance can contact a
provider. The index retains a generation/revision fence after detachment; its
revision also identifies pre-commit admission and repair while owner generation
is unchanged. Index commits use synchronous SQLite transactions. An internal
owner `/reconcile` accepts only the grant key, rereads the owner, and uses an
exact index-revision comparison. A lost acknowledgement is recovered through a
fresh read, not a stale write or caller-supplied previous provider.
The explicit credential commit stores its admission revision as a receipt.
Pending rows retain their prior committed status, so failed account writes can
restore membership without a later refresh or raw import adopting the proposal.
Restoration and its new revision fence commit together, including no-op owner
publications. An identity-leading SQLite index bounds key-only attachment reads
and cleanup even when many inactive memberships are retained.

The authority's internal `/grant-pools/pending` lists at most 64 distinct full
grant keys per page with a keyset cursor. Reconciliation can cancel a failed
first admission only when the owner is strongly absent and the index generation
is zero; it removes only pending rows. Legacy evidence remains unresolved, and
a failed owner read or missing KV record never establishes absence. Raw-KV
import and ordinary refresh may update an existing attachment but cannot create
one without admission; they can return an explicit `unattached` result. Legacy
backfill is an explicit key-only command in the same credential-owner tail,
gated by an accepted baseline scan. It can admit only an existing canonical
owner, commits a new generation and admission receipt without changing secrets
or credential lineage, and leaves ordinary reconciliation semantics unchanged.
KV inventory contributes key names only; it cannot create an owner or receipt.

One fixed readiness row in the existing authority owns baseline acceptance,
bounded scan progress, unresolved outcomes and activation. Its global revision
fences a complete inventory against concurrent attachment changes; per-account
generation/revision still fence membership. Backfill changes that revision, so
the driver performs a subsequent unchanged verification scan. Cursor plus scan
revision rejects stale page acknowledgements. Overflow or unresolved owner
reads prevent activation. Neither a new readiness row nor an empty KV listing
proves storage is fresh: baseline acceptance is an explicit administrator act.

Before activation, only would-be environment fallback is denied. After it,
selection consumes attachment presence independently of available candidates:
paused and reauthorization-required owners block environment fallback, while a
final explicit revoke can permit it subject to policy and continuation rules.
Administrator authentication, recovery, health and existing scoped grant checks
do not depend on the activation gate.

This storage upgrade is forward-only. Reconstructing the current authority
preserves populated legacy rows, and the current credential owner retries dirty
publication after a failed commit or acknowledgement. Rolling back Worker code
is not qualified: older pool readers ignore status and can select pending or
inactive rows or exceed their discovery bounds. Recover with this version or a
forward fix; do not remove the generation/revision fences or restore an older
membership snapshot over newer credential state.

Authentication is read-only after an existing user receives versioned
`assignmentState`. Rule changes reconcile users from the admin mutation path;
verified GitHub evidence remains an explicit admin operation. Legacy KV
assignment retention state is imported once before the first canonical
reconciliation so unknown external membership does not revoke existing access.
Reconciliation evaluates and writes the current user inside `ACCESS_CONTROL`;
callers supply rules and evidence, never a replacement user snapshot. Automatic
login creation inserts only missing users. Both operations preserve intervening
administrator changes to enabled state, tenant, manual groups, and retention.

The browser loads immutable providers/routes once. Admin refreshes use
`GET /v1/admin/bootstrap` for one coherent authority/readiness snapshot. Usage is
loaded separately only on dashboard/usage surfaces. UI transport contracts live
in `shared/contracts.ts`; forms and view models remain frontend-local. Local demo
mode derives its catalog from the same generated provider snapshot to prevent
provider and model drift.

## Data plane

`proxy.ts` coordinates authentication, preflight, forwarding, and failover.
`proxy-auth.ts` owns proxy credential verification and key inspection, so
discovery does not depend on request execution. `proxy-selection.ts` owns
OpenAI, manifest, and native request translation. `proxy-accounting.ts` captures
one request's identity, correlation, pricing, and timing, then builds its final
usage event and delegates independent settlement and delivery to `accounting.ts`.

1. Authenticate the Access session or proxy credential against canonical state.
2. Resolve the selected policy and provider-scoped readiness. Tenant grants are
   visible only to policies in that tenant; policy grants are exact-scope.
3. Reserve the conservative budget before provider work.
4. Retain eligible LLM request content in R2 when policy requires it. Storage
   failure is fail-closed and prevents the upstream call.
5. Filter grants by the policy's provider allowlist, explicit grant eligibility,
   cooldown, stale-state rule, and lowest active priority tier. The access
   authority atomically applies priority, round-robin, least-used, quota-aware,
   or weighted selection and records only counters and privacy-safe sticky input.
6. Materialize the selected credential from its per-grant owner. Expiring OAuth
   tokens refresh through that same serialized owner, which commits each rotated
   access/refresh pair and generation together.
7. Sign and forward the provider request, then normalize manifest-declared quota
   response headers into provider-neutral windows.
8. On an upstream 401, 403, or 429, record sanitized grant state and, when the
   policy permits, try at most one same-provider alternate for an LLM or GET/HEAD
   route.
9. Settle budget and publish the single final usage event independently. Recovery
   for either task never masks the provider response or suppresses the other task.

`proxy-response.ts` owns shared response normalization and usage inspection. One
observer follows client consumption for JSON, SSE, and binary responses, without
cloning or draining ahead of the client. JSON inspection and each SSE frame are
bounded to 2 MiB; SSE history is discarded after extracting terminal facts and
cumulative counters, so a small late terminal remains observable on long streams.
An oversized frame leaves evidence unknown, rather than proving provider failure.
Recognized failed/error events and streams missing their required terminal record
a provider error; Responses `incomplete` remains successful. Delivery failure and
consumer cancellation are recorded independently, without rewriting HTTP status
or bytes. Authoritative terminal usage remains billable even after delivery fails
or is canceled; otherwise accounting retains the conservative reservation.
Settlement starts when delivery completes, fails, or is canceled. The canonical
Worker config enables `enable_request_signal`, preserved by Cloudflare and
self-host config rendering. A runtime-reported ingress abort settles the same
observer once even when workerd drops its response pump without invoking the
stream's `cancel` callback. A client-local abort does not guarantee prompt runtime notification
during idle delivery; the [strict diagnostic and observed limitation](api-reference.md#http-cancellation-diagnostics)
remain explicit. The operation distinguishes caller cancellation from an internal
Fusion adviser deadline. Endpoint timers retire after response normalization;
caller cancellation remains active through delivery. The observer detaches its
abort listener on completion and cancels its owned upstream reader.
Private alias
inference keeps its separate containment and continuation protocol.

Usage events are queued into a Durable Object shard named by tenant and policy.
If queue publication rejects, the Worker writes the same event directly to that
shard through the queue consumer's ingest path. The event ID remains unchanged:
an ID-targeted SQL conflict deduplicates a later delivery if the rejected send
was actually accepted. Successful queue acceptance or a validated direct-ingest
receipt completes publication; queue acceptance alone does not prove ingestion.
Failure of both remains an accounting failure, with no automatic direct retry.

The usage ledger's internal `/ingest` returns JSON `{ eventId, outcome }`, with
`stored`, `duplicate`, or `expired_by_retention`. It requires a nonempty event ID
and the supplied nonnegative safe-integer `occurred_at_ms`; it never replaces a
missing timestamp with the current time. Cleanup and admission share one captured
30-day cutoff: timestamps strictly before it expire, while a retained duplicate
keeps its first payload and timestamp. A new expired event is not inserted.
SQL and alarm scheduling must succeed before a receipt is returned. Direct and
queue consumers require the exact event ID and one of these three outcomes;
additive JSON fields are allowed. Empty, malformed or unrelated 2xx responses
fail ingestion and queue delivery retries. Retention expiry acknowledges only
usage disposition, never a financial settlement.

Existing installations, including self-hosted deployments, must deploy and verify
the receipt producer from `8c25f81` or later before enabling this strict consumer.
Fresh installations include the producer and consumer together.
[Worker and Durable Object code updates can overlap](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates).
Rollback below that producer or prolonged version skew can exhaust the configured
five retries and send usage messages to the DLQ; follow the [DLQ recovery procedure](deploy-cloudflare.md).
Deployment completion does not prove old writers drained or guarantee eventual
delivery. This change does not enable background accounting.

Session/admin reads aggregate each relevant tenant/policy shard once, even when
the input policy list repeats a scope. The former global ledger's migration
window ended on 2026-07-23; it is no longer queried. Stored data and Durable
Object bindings are unchanged.

## Failure boundaries

- Revocation, provider connection state, and budget preflight fail closed.
- Required request retention fails closed before upstream traffic.
- Rejected, nonbillable work releases reservations to zero. Received billable
  responses can still incur cost when generation or stream delivery fails:
  authoritative usage settles the charge; missing usage retains the qualified
  reservation. A dispatched HTTP fetch failure also retains that estimate because
  missing response headers do not prove free upstream work. Pre-dispatch failures
  remain zero. Audit outcome alone does not decide billability.
- Failed budget settlement retries through `USAGE_QUEUE`; rejected usage
  publication recovers through the policy's usage ledger independently.
- HTTP response delivery stays unchanged on accounting failure. A WebSocket
  session reports `accounting_unavailable` and closes if settlement recovery or
  both usage-publication destinations fail; successful recovery permits more work.
- Each reservation keeps only its reservation ID and exact ledger address.
  Immediate settlement and queued retries use that same address; neither
  reconstructs it from authentication or policy state. The queue consumer still
  accepts scope-addressed jobs left by earlier deployments.
- Both budget ledgers confirm dispatch before upstream work starts. Expiry
  releases only undispatched reservations; dispatched work becomes a conservative
  receipt that late actual usage can settle once. Final receipts remain for 45 days.
- Non-2xx or unconfirmed Durable Object settlements are retried and eventually reach the
  configured dead-letter queue.
- Raw requests live only in the retention archive; usage ledgers contain metadata
  and content references, never prompts or completions.
