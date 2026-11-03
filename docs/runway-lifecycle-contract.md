# Runway managed video contract

Frozen consumer: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/runway/index.ts`. The finite modes and IDs are:

| Mode | Endpoint | Frozen models |
| --- | --- | --- |
| Text | POST /v1/text_to_video | gen4.5, veo3.1, veo3.1_fast, veo3 |
| Image | POST /v1/image_to_video | gen4.5, gen4_turbo, gen3a_turbo, veo3.1, veo3.1_fast, veo3 |
| Video | POST /v1/video_to_video | gen4_aleph |

`worker/managed-runway.ts` exports `createRunwayManagedAdapter(mode)`,
`validateRunwayTaskId`, `runwayModels`, and `runwayApiVersion`.
It implements the shared `ManagedLifecycleAdapter` contract and remains
unregistered pending the manifest/schema and real Worker qualification.
Per-control `X-Runway-Version` is stable route identity; a version change must
invalidate an original job's route. It is never a transient diagnostic header.

## Wire and input qualification

Origin: `https://api.dev.runwayml.com`; original provider Bearer credential;
`X-Runway-Version: 2024-11-06` on create, retrieve, and cancel/delete.
Retrieve is GET `/v1/tasks/{id}`, no more frequently than every five seconds.
Controls accept only the scoped UUID and exact declared path/method.

Text/image requests preserve `promptText`, `ratio`, `duration` and
optional mode-required `promptImage`. Video edit uses `videoUri` and no
duration. Prompt admission is at most 1,000 UTF-16 code units. Frozen text ratios
are landscape/portrait; image/video use the frozen six dimensions.
Inline image/video data is bounded to 5,000,000 decoded bytes. HTTPS references
stay opaque. Raw `runway://` upload URIs are rejected pending scoped asset
ownership; provider resource IDs are not caller authorization.

Current primary docs qualify Veo 3.1 durations as 4, 6, or 8 seconds and only
landscape/portrait within this frozen size set. The frozen client applies a
generic five-second default and broad image ratio list. The adapter rejects
those incompatible Veo combinations before dispatch: the client owner must
correct model-specific selection instead of claiming that the five-second
request is supported.

Current create schemas no longer list `gen3a_turbo`, `gen4_aleph`, or `veo3`.
Their frozen request codecs remain implemented; live availability and legacy
constraints are unqualified. Absence from a current schema alone does not prove
endpoint removal. Do not replace them with later generations or advertise those
models as verified without explicit vendor/credential evidence.

## Lifecycle and cancellation

Create normally returns only an ID. The adapter requests a scoped retrieve.
PENDING, THROTTLED, and RUNNING stay pending, including partial output.
SUCCEEDED, FAILED, and CANCELLED are terminal independently of output or metrics.
Missing output after SUCCEEDED is a consumer deliverable error, not continued
execution. Native responses must be bounded 1 MiB JSON through valid UTF-8 EOF.
HTTP/API errors, mismatched IDs, and unknown statuses cannot settle a job.

DELETE `/v1/tasks/{id}` cancels active tasks or deletes other tasks. A qualified
204 acknowledgement is represented as
`observationUnavailable: "canceled_or_deleted"` with no fabricated native status
or terminal execution result. Deleted/aborted records cannot be retrieved again.
Do not follow the ACK with endless GETs or a new generation POST. Other HTTP
responses, including 404, do not prove successful cancellation.

The runtime owner must freeze this observation loss once, preserve a bodyless
204 response, and retain conservative policy-fixed settlement. Successful
cancellation does not guarantee that generation stops. Refund eligibility
depends on the server's concurrent execution state; a prior pending read does
not guarantee a refund. Deletion of completed output does not refund its charge.

Use the existing BackgroundStore caller/policy/provider/credential binding,
reservation, idempotency, and outbox, including restart and uncertain-create
handling. Never replay an uncertain POST. Native bodies remain transient.
Output URLs remain opaque and expire within 24–48 hours; asset transfer is
separate from job settlement. Task retention is unqualified.

## Cost and acceptance

Credits, estimated cost, actual debit/refund, and USD policy charges are separate.
An estimate returned after submission cannot provide pre-dispatch admission.
This adapter does not activate a model tariff or infer cost from status, missing
metrics, input byte size, or cancellation. Unknown upstream-dollar hard budgets
stay closed; explicit `policy_fixed` remains a distinct basis.

Seven dependency-free tests cover concrete wire/state behavior. The synthetic
fixture is `providers/_fixtures/runway/lifecycle.json`. Shared controller/types,
manifest/snapshot, actual frozen client consumption, and real Worker settlement
tests remain required before route qualification. No deployment or live call.

Primary evidence checked 2026-11-03:

- [Native API fields and version](https://docs.dev.runwayml.com/api.md)
- [Official task SDK cancellation contract](https://github.com/runwayml/sdk-node/blob/main/src/resources/tasks.ts)
- [Official image request schemas](https://github.com/runwayml/sdk-node/blob/main/src/resources/image-to-video.ts)
- [Output URL retention](https://docs.dev.runwayml.com/assets/outputs/)
- [Pricing](https://docs.dev.runwayml.com/guides/pricing/)
