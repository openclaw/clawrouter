# fal prompt-only video routes

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/fal/video-generation-provider.ts`, selects
`fal-ai/minimax/video-01-live` by default and explicitly lists
`fal-ai/heygen/v2/video-agent`. This slice connects exact prompt validation to
the existing registered `falManagedAdapter`, retaining protocol `fal.queue`
and request format `fal.queue_submit`. It adds no controller, queue or job index.

`worker/fal-prompt-video.ts` exports `falPromptVideoModels`,
`isFalPromptVideoModel`, `prepareFalPromptVideo` and
`observeFalPromptVideoOutput`. The registered wrapper now validates these two
products before create dispatch. Existing two/three-segment products retain
their prior behavior. A fourth segment is admitted only for the exact frozen
HeyGen path, using `{ owner: "fal-ai", app: "heygen", variant: "v2",
subvariant: "video-agent" }`; gaps, extra fields and other four-segment products
are rejected. `requestedVersion` preserves the full selected path and original
parameters remain attached to the job for all controls.

Both current primary schemas define prompt input but no image_url. The frozen
client can forward an image and claims image-to-video capability for these paths;
source2 must reject that unsupported input instead of silently dropping it.
This codec accepts prompt only: MiniMax's native maximum is 2000 Unicode code
points; HeyGen has a local adapter bound of 32000 (not a claimed vendor limit).
Unsupported duration, aspect ratio, resolution, audio, image, config and callback
fields fail before create. This finite slice does not expand into other products.

Create is POST `https://queue.fal.run/<full model>`, native Key authentication
using the selected server FAL_KEY. The wrapper keeps X-Fal-No-Retry and the
600-second queue-start timeout, which does not cap inference duration or cost.
Controls use only the original `/<owner>/<app>/requests/<id>` root: GET status,
GET result and PUT cancel. The scoped controller owns caller/policy/grant binding,
idempotency, uncertain-create handling, deadlines, restart recovery, outbox and
one frozen settlement. A lost submit response never authorizes another POST.
No returned URL chooses a credential destination or overrides that binding.

An early video URL during IN_PROGRESS does not make the job terminal.
COMPLETED requests one original-job result read. Result success/failure and
asset usability are separate: a complete terminal result with a missing or
unusable video stays terminal, and output validation cannot reopen polling,
replay create or imply a refund. `observeFalPromptVideoOutput` runs on that
result after lifecycle observation. It returns one bounded HTTPS MP4 descriptor,
with no credential or fetch authority, or rejects unusable media. The local
256 MiB descriptor limit does not prove the fetched file's size or MIME.

Cancel 200/OK records queued removal; 202/CANCELLATION_REQUESTED is an
acknowledgement that can race success. 400/ALREADY_COMPLETED and 404/NOT_FOUND
remain observation cases, not free-execution proof. Missing/auth/server reads
do not fabricate terminal failure; the existing controller's attempt/deadline
rules bound continuation. Vendor retention (default request history 90 days,
separate media expiry) never supplies router ownership or restart authority.

`providers/_fixtures/fal/prompt-video.json` contains sanitized submit, partial,
complete, result, error and cancellation wires. Focused tests use the registered
adapter and prove native state/control behavior; they do not replace actual
Worker durable-state or consumer acceptance tests owned by sources1/2/6.

Source3 handshake: add the exact four-segment HeyGen create template
`/${owner}/${app}/${variant}/${subvariant}` under the existing lifecycle format,
with the same owner/app retrieve/result/cancel links. No schema is changed here.
Source1 must qualify original-route selection and canonical FAL_KEY admission;
source5 owns eventual new fal YAML/model additions and source6 snapshots/E2E.
The three-segment MiniMax route can reuse the existing typed route. Activation
still requires the actual manifest, credentials, runtime and consumer gates.

Primary evidence:
[MiniMax schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/minimax/video-01-live),
[HeyGen schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/heygen/v2/video-agent),
[native queue](https://fal.ai/docs/documentation/model-apis/inference/queue),
[retention](https://fal.ai/docs/documentation/model-apis/media-expiration).
The [HeyGen API page](https://fal.ai/models/fal-ai/heygen/v2/video-agent/api)
advertises output-second billing, but the qualified prompt-only request has no
enforceable output duration bound and the returned file has no cost receipt.
Inference time is not billable output duration. Upstream cost therefore stays
unknown and hard-dollar budgets must deny it, independently of policy_fixed.
No paid request, deployment, secret or commercial-account change was used.
