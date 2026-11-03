# Vydra Models API contract

Frozen OpenClaw revision `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`
uses four products through `extensions/vydra/{index,shared,speech-provider}.ts`:
`grok-imagine` text-to-image, `veo3` video, `kling` motion video and
`elevenlabs/tts` speech. These send JSON to `/api/v1/models/<model>` at
`https://www.vydra.ai` with the selected server VYDRA_API_KEY as Bearer auth.
They are distinct from the canonical workflow-body `POST /api/v1/jobs` route.
No upstream xAI, Google, fal or ElevenLabs account/credential interchange applies.

`worker/vydra-models.ts` exports `prepareVydraModel`, `observeVydraModel`
and `readVydraModel`. The native body stays unchanged after bounded validation.
Image requires `model: text-to-image`; speech retains `text` and `voice_id`.
No callback, newer model, image editing, video option expansion or raw file
reference is added. Unary image/audio may complete with URLs and no job ID;
the codec does not invent an ID to force those calls into an async controller.

The concrete `vydraModelVideoAdapter` in `worker/managed-vydra-models.ts`
implements the actual ManagedLifecycleAdapter for `vydra.jobs`, proposed create
format `vydra.model_video_create`. The create template is
`/api/v1/models/${model}`, with model restricted to veo3/kling. Its returned
`requestedVersion` and original model path parameter must stay bound to the job.
HTTP202 create uses top-level `jobId`; GET `/api/v1/jobs/${job_id}` uses
`id`. Both are bounded and must agree if both occur. External IDs and native
links never authorize a control. Only GET retrieval is qualified here; no cancel,
separate result, upload or authenticated file route is advertised.

Source3 owns the new Models format qualification in the central schema. Source1
owns shared dispatch, reservation, idempotency, uncertain-create handling and
original create-route resolution. Source5 will register this wrapper only after
those contracts support coexistence with the existing Jobs create adapter.
Their shared native GET path must resolve the original caller/job/create route,
not the first matching endpoint. Never replay a remote POST after uncertainty.
Source2 owns the actual client mapping, and source6 owns Worker/client acceptance.
The existing manifest, registry and shared controller are unchanged in this slice.

Pending/running output URLs are partial data, not terminal success. Completed,
failed and cancelled observations stop polling; a completed video without a
usable asset is still a terminal job, with a separate delivery failure. Missing
job/unknown status, malformed data, redirects, partial HTTP responses, truncation
or cancellation of the local reader do not prove an upstream failure or refund.
Original bounded retention, deadline and outbox rules remain the shared runtime's
responsibility. No automatic create replay or new job index is introduced.

URLs are bounded opaque output descriptors. No code here fetches them or attaches
credentials. Consumer delivery still requires original-job output binding, DNS/
redirect policy, MIME and byte limits. Even an HTTPS URL is not authority for a
credential-bearing request. Native bodies remain transient.

The sanitized fixture is `providers/_fixtures/vydra/models.json`. Its ledger
numbers are synthetic. Credits/refunds stay separate from terminal state;
missing values remain unknown, and zero ledger evidence does not become a
qualified dollar cost. The [billing contract](https://www.vydra.ai/docs/billing)
uses 50 API ledger units per customer credit, with offer-dependent dollar value.
Historical model-page prices are not tariff evidence. Hard upstream-dollar
budgets remain closed without a qualified bound; policy_fixed is separate.

## Evidence and remaining qualification

- [Vydra native OpenClaw documentation](https://www.vydra.ai/docs/mcp) confirms
  the four frozen product identities, canonical origin and server key. The frozen
  source specifies the speech Models endpoint/body; current workflow speech docs
  describe a different Jobs endpoint. Do not silently migrate or alias it.
- [Veo3](https://www.vydra.ai/docs/models/veo3) qualifies the Models POST,
  HTTP202 jobId and subsequent Jobs GET.
- [Grok Imagine](https://www.vydra.ai/docs/models/grok-imagine) qualifies the
  synchronous text-to-image mode and URL response.
- [Kling](https://www.vydra.ai/docs/models/kling) requires an image AND a motion
  video. Frozen OpenClaw puts its image URL in both fields. The codec rejects
  identical references; source2 must resolve that concrete mismatch before Kling
  activation. Different references still require runtime input ownership/policy.
- [Jobs](https://www.vydra.ai/docs/jobs) qualifies terminal statuses and refund
  evidence. Its canonical201 workflow create is not the Models202 contract.

These deterministic codecs and the concrete wrapper are not live provider or
full parity proof. No paid request, deployment, account change or secret access
was used.
