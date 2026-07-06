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
health remain in KV because they have separate lifecycle and consistency needs.

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

1. Authenticate the Access session or proxy credential against canonical state.
2. Resolve the selected policy and provider-scoped readiness. Tenant grants are
   visible only to policies in that tenant; policy grants are exact-scope.
3. Reserve the conservative budget before provider work.
4. Retain eligible LLM request content in R2 when policy requires it. Storage
   failure is fail-closed and prevents the upstream call.
5. Select a non-cooled grant by configured priority, current provider-reported
   quota ratio, and stable key; then sign and forward the provider request.
6. On an upstream 401, 403, or 429, record sanitized grant state and try at most
   one same-provider alternate for an LLM or GET/HEAD route.
7. Settle budget and enqueue the single final usage event independently. Either failure is
   retried without masking the provider response or suppressing the other task.

Usage events are queued into a Durable Object shard named by tenant and policy.
Session/admin reads aggregate only their relevant shards. A bounded legacy read
bridge includes the former global ledger through 2026-07-23; it performs one
filtered global read per aggregate and can then be removed.

## Failure boundaries

- Revocation, provider connection state, and budget preflight fail closed.
- Required request retention fails closed before upstream traffic.
- Provider failures release a reservation to zero and emit audit metadata.
- Settlement and usage delivery retry independently through `USAGE_QUEUE`.
- Non-2xx Durable Object queue writes are retried and eventually reach the
  configured dead-letter queue.
- Raw requests live only in the retention archive; usage ledgers contain metadata
  and content references, never prompts or completions.
