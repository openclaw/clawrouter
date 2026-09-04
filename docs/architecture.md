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
stale KV state. Assignment rules, scoped upstream-grant secrets, and provider
health remain outside that global authority because they have separate lifecycle
and consistency needs. `GRANT_CREDENTIALS` is the canonical raw-secret owner,
sharded one Durable Object per grant. KV holds its redacted routing projection;
a legacy secret-bearing KV grant is imported and scrubbed on first use.

Authentication is read-only after an existing user receives versioned
`assignmentState`. Rule changes reconcile users from the admin mutation path;
verified GitHub evidence remains an explicit admin operation. Legacy KV
assignment retention state is imported once before the first canonical
reconciliation so unknown external membership does not revoke existing access.

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
9. Settle budget and enqueue the single final usage event independently. Either failure is
   retried without masking the provider response or suppressing the other task.

`proxy-response.ts` owns shared response normalization and usage inspection. One
observer follows client consumption for JSON, SSE, and binary responses, without
cloning or draining ahead of the client. It inspects at most 2 MiB for usage;
oversized, canceled, or broken bodies retain the conservative reservation.
Settlement starts when delivery completes, fails, or is canceled. Private alias
inference keeps its separate containment and continuation protocol.

Usage events are queued into a Durable Object shard named by tenant and policy.
Session/admin reads aggregate each relevant tenant/policy shard once, even when
the input policy list repeats a scope. The former global ledger's migration
window ended on 2026-07-23; it is no longer queried. Stored data and Durable
Object bindings are unchanged.

## Failure boundaries

- Revocation, provider connection state, and budget preflight fail closed.
- Required request retention fails closed before upstream traffic.
- Provider failures release a reservation to zero and emit audit metadata.
- Settlement and usage delivery retry independently through `USAGE_QUEUE`.
- Each reservation keeps only its reservation ID and exact ledger address.
  Immediate settlement and queued retries use that same address; neither
  reconstructs it from authentication or policy state. The queue consumer still
  accepts scope-addressed jobs left by earlier deployments.
- Non-2xx Durable Object queue writes are retried and eventually reach the
  configured dead-letter queue.
- Raw requests live only in the retention archive; usage ledgers contain metadata
  and content references, never prompts or completions.
