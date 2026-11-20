# Managed upstream-retention admission

Router `retainRequestContent` controls router logging. It never permits vendor
retention. The new admission defaults to denied and intersects two explicit
operator-controlled facts. This change provisions neither fact and performs no
live account-policy or consent changes.

## Caller policy

The optional `upstreamRetention` field is preserved and validated through the
existing policy normalization and admin API:

```json
{
  "version": "clawrouter.upstream-retention.v1",
  "allow": [{ "providerId": "openrouter", "protocol": "openrouter.video" }]
}
```

Missing, null, malformed, unknown-version or nonmatching policy permission denies
admission. Provider/protocol entries are exact, unique and bounded to 64; no
wildcards. An explicit null clears permission. Updating unrelated policy fields
preserves the existing permission. Existing caller model/provider restrictions
still apply; this field supplies no price, model support or asset ownership.

## Original credential/server qualification

`CLAWROUTER_UPSTREAM_RETENTION_BINDINGS` is a bounded server JSON configuration:

```json
{
  "version": "clawrouter.upstream-retention-bindings.v1",
  "bindings": [{
    "providerId": "openrouter",
    "protocol": "openrouter.video",
    "grantKey": null,
    "routeSha256": "<original 64-character route digest>",
    "retention": "allow",
    "expiresAt": "<qualified UTC expiry>"
  }]
}
```

These are illustrative placeholders, not a usable permission. Configure a binding
only after qualifying the selected original account's retention/ZDR settings.
The runtime does not probe or change that account. A pooled binding names the
exact original grant key; null means the configured environment credential.
Neither can borrow the other's receipt. No upstream secret belongs in this JSON.

The existing continuation route digest binds the materialized original credential
identity, approved origin/API prefix, create endpoint and control paths. It also
pins the new admission mode. Runtime checks require exactly one unexpired matching
receipt, an enabled caller policy, the original policy generation, and an exact
policy provider/protocol permission. Missing ownership, credential/configuration
rotation, route changes, expiry and ambiguous/malformed receipts fail closed.
No caller field, header, budget, model name or logging flag provides permission.

## Exact adapter ABI

`worker/upstream-retention-admission.ts` exports:

- `ManagedCreateAdmission`: readonly `{ upstreamRetention: "allowed" | "denied" }`.
- `managedCreateAdmission(policy, env, originalOwner, protocol, now?)`.
- `requireManagedCreateAdmission(policy, env, originalOwner, protocol)`; denied
  admission throws sanitized `403 upstream_retention_unqualified`.
- `upstreamRetentionBindingAllowed(env, originalOwner, protocol, now?)` for the
  existing control dispatch boundary.

`ManagedLifecycleAdapter` gains this optional synchronous, pure method:

```ts
prepareAdmitted(body, headers, pathParams, query, admission): ManagedCreate
```

Adapters without this method keep the existing prepare/dispatch path and digest.
For an opted-in adapter, the shared controller first selects its original
credential and derives the frozen admission value. It invokes `prepareAdmitted`
only after permission qualifies. This separate method is necessary because the
existing `prepare` executes before original credential selection. Source-owned
`prepare` may remain denied when invoked without runtime admission.

The first slice supports body-only create routes with no route parameters,
retained parameters, SigV4 signing or adapter-created headers. The codec may
canonicalize the bounded JSON body; the controller serializes that body into the
already selected original request without credential reselection. Changing route
parameters or adding headers is rejected. No output from this hook changes the
original origin, credential, pricing, continuation owner or idempotency authority.

Source5 can call the published OpenRouter codec from `prepareAdmitted`, deriving
its `retentionAllowed` value from `admission.upstreamRetention === "allowed"`.
It must not hardcode permission or enable remote/reference inputs from this fact.
The OpenRouter protocol is accepted by the existing scoped durable store; registry
and declaration activation remain source-owned and independently qualified.

## Dispatch and state

Qualification is checked before reservation and again at original create egress.
Public controls retain fresh caller authorization and also recheck current policy
permission. Every original control/file dispatch, including the existing collector,
checks its expiring server binding while retaining the original grant owner.
Collectors continue only the previously admitted job; they cannot admit a new
caller or replay create. Lost qualification never proves free generation and does
not refund an already dispatched job. The existing state/outbox owns uncertainty,
recovery and exactly-once terminal settlement.

Fixtures cover both permission halves, malformed/expired/mismatched bindings,
caller spoofing, logging independence, environment versus pooled credentials,
real Worker zero-egress denial, original-job controls after restart, permission
removal and conservative frozen charges. They use a synthetic adapter seam and
make no live account, deployment, provider activation or retained-asset claim.
