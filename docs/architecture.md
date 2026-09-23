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
self-host config rendering. Ingress abort settles the same observer once even
when workerd drops its response pump without invoking the stream's `cancel`
callback. This is caller cancellation, including an internal Fusion adviser
deadline; it does not always mean a human disconnected. The observer detaches
its abort listener on completion and cancels its owned upstream reader.
Private alias
inference keeps its separate containment and continuation protocol.

Usage events are queued into a Durable Object shard named by tenant and policy.
If queue publication rejects, the Worker writes the same event directly to that
shard through the queue consumer's ingest path. The event ID remains unchanged:
SQL `INSERT OR IGNORE` deduplicates a later delivery if the rejected send was
actually accepted. Successful queue acceptance or direct ingestion completes
publication; failure of both remains an accounting failure.
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
  reservation. Pre-response HTTP fetch failures keep their existing zero-charge
  policy. Audit outcome alone does not decide billability.
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
