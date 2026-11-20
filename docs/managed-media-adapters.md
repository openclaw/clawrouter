# Managed media protocol adapters

`worker/managed-lifecycle-adapters.ts` implements the published
`ManagedLifecycleAdapter` contract. `managedLifecycleAdapter(protocol)` selects
one explicit protocol; `managedCreateAdapter(protocol, requestFormat)` also
requires its supported submit format. Unknown protocols and format mismatches
return undefined. No registry lookup by provider name or a generic API badge.

These are concrete adapters for the scoped controller, not replacement job
infrastructure. They perform no fetches, credential selection, storage,
idempotency replay or settlement. The controller must invoke them through the
existing BackgroundStore/ResponsesScopeStore admission, binding and outbox path.
Bundled manifests and the controller remain separate source-owner integration.

## Manifest and controller handoff

| Protocol | Submit format and route inputs | Controls | Separate result |
| --- | --- | --- | --- |
| Replicate | `replicate.prediction_create`; body version/input | GET/POST `/v1/predictions/${prediction_id}[/cancel]` | No |
| fal | `fal.queue_submit`; path `owner`, `app`, optional `variant` | GET status/result and PUT cancel under `/${owner}/${app}/requests/${request_id}` | Yes |
| Kie Market | `kie.job_create`; body model/input | GET `/api/v1/jobs/recordInfo?taskId=…` | No |
| Vydra Jobs | `vydra.job_create`; body workflow/input | GET/DELETE `/api/v1/jobs/${job_id}` | No |

fal's first native submit slice accepts two or three validated path segments.
Its control templates omit the variant. Kie accepts exactly one `taskId` query
field and has **no qualified cancellation endpoint**. Vydra's canonical Jobs API
is distinct from Studio workflows. Do not route other products by alias.

1. Select a declared lifecycle and matching adapter before upstream dispatch.
2. Prepare native body/headers and freeze its returned requestedVersion and route
   parameters with original caller, policy and credential lineage. Credentials
   are absent from adapter headers. Retain existing canonical-digest/idempotency
   and uncertain-create behavior; never replay an uncertain remote POST.
3. Read the bounded create envelope, atomically bind the validated ID, then expose
   rewritten controls. Control identity must be scoped by protocol/provider/caller.
4. Resolve an incoming control ID to the original binding before constructing the
   upstream request. For fal, also compare incoming owner/app against the stored
   route. `identify()` returns only the ID and cannot perform that comparison.
   `control()` validates the stored manifest method/path and produces a relative
   path/query; response URLs never select an origin or destination.
5. Honor at most the controller's bounded retrieve/result follow-up chain.
   Cancellation acknowledgements cannot request another cancel. Never persist
   `ManagedObservation.body`, prompts, media, logs or raw error text.
6. Freeze one terminal receipt and retain independent settlement/usage ACKs.
   Disconnect, read failure, expiry and restart retain the existing conservative
   accounting semantics. Neither helper metrics nor credits establish dollars.

## Terminal and result boundaries

Replicate preserves starting/processing as open and succeeded/failed/canceled/
aborted as terminal; aborted can omit metrics.

fal create can return only an ID. Queue COMPLETED without error needs a result
read before successful terminal classification. A documented queue error is
terminal failed. Result HTTP 422 with native error detail is a model failure;
401/404/429/5xx retrieval failures remain unknown. Queued cancel removal is
terminal canceled; in-progress cancellation, already-completed and not-found
acknowledgements require observation. Result payloads may have no request ID and
inherit identity only from the authorized original request.

Kie HTTP/body API errors are not terminal job evidence. waiting/queuing/generating
remain open; success/fail terminate even if metrics or output are absent.
Vydra create always follows with GET, including immediate completion. DELETE
refund acknowledgement is nonterminal and can race successful completion.
Completed/failed/cancelled GET states are terminal. No output URL is fetched.

All readers enforce a one-MiB byte limit, JSON content type and valid UTF-8;
redirects, incomplete bodies and mismatched IDs fail closed. Rewriting removes
native control links and preserves opaque output data. Only trusted router-relative
controls may be exposed.

## Proof and remaining activation gates

`providers/_fixtures/media/managed-routes.json` declares sanitized route contracts
and references each portable native lifecycle fixture. The focused tests execute
the actual wrappers, including bounded stream cancellation and result/cancel races.
They do not simulate durable settlement and claim that as Worker proof.

11.1 owns controller calls/types and durable state; 11.3 owns lifecycle/schema
activation; 11.2 owns actual client adapters; 11.6 owns Worker/client acceptance.
M01's failed checks must be resolved before M02 activation. Required acceptance
includes original-credential isolation, uncertain create without replay, restart,
expiry, duplicate terminal delivery and lost settlement/outbox ACKs. Explicit
`policy_fixed` remains a router charge, not qualified upstream-dollar parity.
