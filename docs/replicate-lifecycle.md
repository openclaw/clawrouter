# Replicate prediction lifecycle

`worker/replicate-lifecycle.ts` is a protocol adapter for runtime integration.
It does not register routes or authorize raw prediction IDs. The executable
fixture is `providers/_fixtures/replicate/prediction-lifecycle.json`; run
`node --test worker/test/replicate-lifecycle.test.mjs` without dependencies.
All fixture input, output, IDs, durations and policy charges are synthetic.

## Runtime handoff

1. Authenticate and admit through the existing runtime. Parse the request with
   its normal byte limit, then call `prepareReplicateCreate`. It rejects webhook
   and stream fields, defaults to asynchronous submission, and bounds
   `Cancel-After` to 600 seconds. Add only the selected grant's credentials after
   preparation. Persist the original accounting facts, requested version,
   credential lineage, scoped idempotency digest and dispatch fence before POST.
2. Submit to the manifest's `/v1/predictions`. Call `readReplicatePrediction` on
   the response. Atomically bind `observation.id` to the job's original scope
   before exposing any response bytes, including immediate terminal responses.
   A lost create response is `submission_unknown`: never replay the POST.
3. Resolve scoped ownership before GET or cancel POST. Supply the bound ID to
   `replicateControlPath` and `readReplicatePrediction`. Never choose a credential
   again or follow response URLs. Use the normal no-redirect transport and bounded
   attempts. The runtime also owns the response read deadline.
4. After binding, call `rewriteReplicatePredictionUrls` with trusted router paths.
   It drops upstream get/cancel/stream/web links. Media URLs remain opaque output;
   this adapter never fetches them or forwards credentials to them. Return native
   content transiently; persist only `observation` and existing accounting facts.

`starting` and `processing` remain open even when output exists. Only `succeeded`,
`failed`, `canceled` and `aborted` are terminal in this slice. Cancel HTTP acknowledgement,
client disconnect, missing output, 404 and malformed evidence are not termination.
After uncertain cancel, observe GET first. The runtime must freeze one terminal
receipt, preserve it through cancel/success races, and track settlement and usage
ACKs separately. Invalid evidence keeps conservative accounting.

The adapter accepts ASCII IDs up to 128 characters and JSON responses up to 1 MiB.
These are router limits. Oversized responses, unsupported statuses and incomplete
UTF-8/JSON fail closed. `aborted` means the deadline elapsed before execution
started and can omit metrics. Stop polling, but keep cost unknown unless qualified
model/billing evidence or the frozen policy-fixed tariff determines settlement.

## Retention and billing

API inputs, outputs, files and logs expire after one hour by default. The runtime
uses its existing one-hour observation window; content expiry must not turn an
owned ID into unscoped access. Ownership tombstones follow the runtime contract.
See [Replicate data retention](https://replicate.com/docs/topics/predictions/data-retention).

`metrics.predict_time` is seconds, not money. Cancellation can be chargeable;
private/deployment and official model tariffs differ. A timeout alone cannot prove
a whole-job dollar bound. Hard budgets need a frozen tariff/version/bound before
egress. The fixture uses an explicit 700-microdollar `policy_fixed` policy, with
actual upstream cost unknown. Missing evidence never invokes a one-micro fallback.
See [billing](https://replicate.com/docs/topics/billing) and
[prediction lifecycle](https://replicate.com/docs/topics/predictions/lifecycle).

The fixture's `acceptanceScenarios` are integration requirements, not proof of
durability or exactly-once settlement. The runtime owner must exercise them through
the real Worker, scoped stores and outbox. Model-specific tariff evidence and live
credits remain necessary for actual upstream cost qualification.

Native endpoints and header syntax follow the
[HTTP API](https://replicate.com/docs/reference/http), checked 2026-11-03.
