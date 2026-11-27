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

The landed schema and registered wrapper qualify bounded four-segment paths for
HeyGen, Wan and the six exact Seedance 2.0 products. This declaration still has
only the three-segment create template; it does not enable their deeper routes.
Future declaration additions must retain the original create parameters and
owner/app controls, including Seedance's exact dotted root. Do not encode slashes
inside `variant` or widen it to an arbitrary relative path.

The existing MiniMax default is prompt-only. Its registered validator rejects
images, duration, resolution, ratio and audio fields; the frozen consumer's
broader defaults cannot silently pass through. The retired
`fal-ai/kling-video/v2.1/master/text-to-video` stays outside the declared template.
`xai/grok-imagine-image/quality` is unqualified, not a proven retirement or alias:
the wrapper now explicitly denies its new queue creates as well as the separate
synchronous codec's denial. Original scoped controls remain available. Direct
xAI's alias and price do not qualify this fal product.

The [prompt-video](fal-prompt-video-contract.md),
[Wan/Kling](fal-hosted-wan-contract.md), [Seedance](fal-seedance-contract.md) and
[Grok image](fal-grok-images-contract.md) contracts retain model-specific limits.
Wan/Seedance codecs accept only qualified bounded inline inputs; remote URLs,
uploads and arbitrary model assets gain no ownership from this declaration.
The generic queue service is not evidence of model-specific input or price parity.

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

Canonical FAL_KEY runtime support and the scoped path contracts are landed.
Source 6 still owns script/key-mask and generated-snapshot integration; source 2
must preserve the native restrictions in its consumer. New synchronous image or
music formats still need source 1 runtime and source 3 schema qualification before
source 5 may declare them. No paid POST substitutes for a safe unresolved smoke.
