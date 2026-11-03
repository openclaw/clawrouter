# fal queue provider declaration

`providers/fal.provider.yaml` declares the existing `fal.queue` managed protocol
at `https://queue.fal.run`. Server configuration uses `FAL_KEY`; the native header
is `Authorization: Key …`, not Bearer. The frozen OpenClaw plugin also names
`FAL_API_KEY` as a setup alias; it requires explicit server configuration and is
not a client upstream-secret fallback. No other account or regional product is
selected automatically.

The [native queue documentation](https://fal.ai/docs/documentation/model-apis/inference/queue)
qualifies POST submission and status/result/cancel under the original owner/app.
The declaration exposes only `media.predict` on the three-segment submit route.
It links GET status, GET result and PUT cancel through the actual managed registry
and BackgroundStore controller. It does not advertise an independently authorized
raw-ID control capability. Native queue completion requests a separate result;
cancel acknowledgement is not automatically terminal or evidence of a refund.

No model rows, dollar tariffs or synchronous image/music endpoints are fabricated.
Native payloads remain model-specific and the complete endpoint path is retained
as the requested version. Admission uses the established explicit `policy_fixed`
charge, separate from unknown upstream dollars. Upstream-dollar hard budgets must
remain closed without a qualified bound. The provider service grant is queue scope;
this declaration does not claim per-model catalog filtering or model-specific facts.
Output assets remain opaque transient data; neither response URLs nor remote job
IDs provide credentials or authorize a fetch.

## Frozen scope and remaining contracts

OpenClaw source is `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/fal/video-generation-provider.ts`. Its default
`fal-ai/minimax/video-01-live` fits this three-segment submit route. The native
queue itself is a generic service; this slice declares that service rather than
publishing a vendor model inventory. It does not claim all frozen fal media modes.

The schema and wrapper currently reject submit IDs deeper than three segments.
Frozen HeyGen, Seedance fast and Kling/Wan paths need a bounded deeper-path contract
from schema/runtime owners before declaration. Multiple create templates sharing
native owner/app controls also need original-create-route resolution, not a first
matching endpoint. Do not encode slashes inside `variant` or widen it to an arbitrary
relative path. The present declaration has one create template.

Frozen image/music clients use synchronous `fal.run` responses. They need their own
qualified native formats and consumer bridge; silently converting those requests
to async jobs is not parity. Webhooks, caller-controlled queue retries, logs, result
storage policy, arbitrary output fetching and file uploads remain unavailable here.
Existing [queue lifecycle fixtures](../providers/_fixtures/fal/queue-lifecycle.json)
and [protocol contract](fal-queue.md) qualify retention/cancel/state limits.

## Integration proof

`worker/test/fal-manifest.test.mjs` compiles the actual YAML and resolves its routes
through the actual shared registry. It checks server auth, no priced model claims,
original owner/app controls, compiler rejection of unbound reads, and native
result/cancellation uncertainty. Existing queue/managed-adapter tests cover the
bounded wire behavior. All bundled manifests and native gates run in hosted CI.

Source 6 owns committed snapshot regeneration, strict smoke qualification and
actual Worker/client acceptance. Source 2 owns the native consumer. No live paid
call, deployment, provisioned secret or production integration is claimed by this
declaration. Source 1 retains durable caller/policy/credential binding, no replay
after uncertain creation, restart/expiry and one terminal settlement/outbox.
