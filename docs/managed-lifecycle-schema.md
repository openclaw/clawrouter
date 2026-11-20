# Managed lifecycle manifest contracts

The schema extends `endpoint.lifecycle` with the four protocols exported by
`worker/managed-lifecycle-types.ts`. It follows the concrete adapters in
`worker/managed-lifecycle-adapters.ts` and their portable
`providers/_fixtures/media/managed-routes.json` contract. This schema change adds
no provider rows, endpoints or generated payloads beyond its Replicate base.

| Protocol | Required links | Create request/response formats |
| --- | --- | --- |
| `replicate.predictions` | `retrieve`, `cancel` | `replicate.prediction_create` / `replicate.prediction` |
| `fal.queue` | `retrieve`, `result`, `cancel` | `fal.queue_submit` / `fal.queue_submission` |
| `kie.jobs` | `retrieve` | `kie.job_create` / `kie.job` |
| `vydra.jobs` | `retrieve`, `cancel` | `vydra.job_create` / `vydra.job` |

Links identify distinct endpoints in the same provider manifest. Create is POST
with `media.predict`. All routes are native, nonstreaming and use exact segment
parameters; lifecycle nesting, model passthrough, query overrides and method
broadening are rejected. Controls cannot advertise independent capabilities,
except Replicate's existing `media.prediction.read` compatibility declaration.
New managed wire formats require a lifecycle binding, including otherwise orphaned
control endpoints.

| Protocol/action | Method/path | Request/response format |
| --- | --- | --- |
| fal retrieve | GET `/${owner}/${app}/requests/${request_id}/status` | `fal.queue_status` |
| fal result | GET `/${owner}/${app}/requests/${request_id}` | `fal.queue_result` |
| fal cancel | PUT `/${owner}/${app}/requests/${request_id}/cancel` | `fal.queue_cancel` |
| Kie retrieve | GET `/api/v1/jobs/recordInfo` | `kie.job_get` / `kie.job` |
| Vydra retrieve | GET `/api/v1/jobs/${job_id}` | `vydra.job_get` / `vydra.job` |
| Vydra cancel | DELETE `/api/v1/jobs/${job_id}` | `vydra.job_cancel` |

fal submit uses `/${owner}/${app}` or `/${owner}/${app}/${variant}`. Controls
omit the variant; the controller must compare incoming owner/app with the frozen
original route. Each declared create chain owns its controls. Sharing control
links across multiple create declarations remains unqualified.

Kie's adapter identifies the job through exactly one incoming `taskId` query
parameter. The manifest does not bake an ID into `query` or add a path parameter.
Kie has no cancellation or separate result link. Its top-level `model` belongs
to the native job body: the managed create path must invoke the adapter before
ordinary router-model lookup/remapping, then freeze the adapter's requestedVersion.

The controller must resolve original scoped ownership before every control and
must preserve credential lineage, uncertain-create behavior, restart/expiry and
terminal/outbox settlement. No response-supplied URL chooses the destination.
The schema cannot supply those durable guarantees; wrapper tests cannot either.
Do not activate matching provider manifests until the bound controller exists,
M01 is ready and actual Worker/client fixtures pass. No tariff, modality badge or
upstream-dollar budget certification is inferred from these protocol links.
