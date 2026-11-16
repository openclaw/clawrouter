# Runway lifecycle declaration

The closed `runway.tasks` discriminator requires distinct `retrieve` and `cancel`
endpoint links on each create endpoint. It qualifies the three frozen native
mode formats against `createRunwayManagedAdapter(mode)`; no provider YAML, model,
registry entry or generated snapshot is activated by this schema slice.

| Action | Method and path | Request format | Response format |
| --- | --- | --- | --- |
| Text create | POST `/v1/text_to_video` | `runway.text_video` | `runway.task` |
| Image create | POST `/v1/image_to_video` | `runway.image_video` | `runway.task` |
| Video create | POST `/v1/video_to_video` | `runway.video_video` | `runway.task` |
| Retrieve | GET `/v1/tasks/${id}` | `runway.task_get` | `runway.task` |
| Cancel/delete | DELETE `/v1/tasks/${id}` | `runway.task_cancel` | `runway.task_cancel` |

Each create format is paired with its exact path; formats cannot be exchanged.
The qualified origin is `https://api.dev.runwayml.com`, using the original Bearer
API credential. The adapter generates `X-Runway-Version: 2024-11-06` on every
request. That header is stable route identity, never a transient trace value.
Create may declare the matching version/JSON content type; controls cannot
override headers. Caller-forwarded headers, queries, standalone controls,
streaming, passthrough, orphan formats and raw upload routes are rejected.

A 204 DELETE acknowledgment remains bodyless and produces
`observationUnavailable: canceled_or_deleted`, not a native terminal execution
result or a refund. Shared runtime already preserves this bodyless loss response.
Do not automatically poll or recreate a task to resolve deletion uncertainty.
Preliminary credit estimates do not qualify upstream-dollar admission.

Mode fixtures are qualified independently. Multiple modes share native task
paths: combined activation requires the shared native controller to resolve the
original create route from scoped durable ownership rather than selecting the
first matching endpoint. Preserve original caller/policy/provider/credential,
version, deadline, no uncertain-create replay and exactly-once settlement. Raw
`runway://` uploads remain rejected pending asset ownership. Existing HTTPS
references remain opaque data, not router fetch destinations.

The frozen client needs model-specific Veo durations of 4/6/8 seconds instead of
its generic five-second default. Historical gen3a_turbo/gen4_aleph/veo3 codecs do
not establish current vendor availability. Source qualification never substitutes
new generations or activates those models from fixture presence. See
[the source contract](runway-lifecycle-contract.md) for primary evidence and
availability limits. Actual Worker/client route tests and serialized snapshots
are still required before bundled activation.
