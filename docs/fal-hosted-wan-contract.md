# Frozen fal Wan routes and Kling disposition

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/fal/video-generation-provider.ts`, explicitly lists
`fal-ai/wan/v2.2-a14b/text-to-video`, `fal-ai/wan/v2.2-a14b/image-to-video`
and `fal-ai/kling-video/v2.1/master/text-to-video`.

The current [fal Kling endpoint page](https://fal.ai/models/fal-ai/kling-video/v2.1/master/text-to-video/api)
marks that exact endpoint deprecated and no longer supported. It stays closed.
The sanitized fixture retains its historical native duration string, but there
is no live offer, replacement model, silent alias or live generation probe.
The available historical OpenAPI schema does not override that explicit notice.

`worker/fal-hosted-wan.ts` exports `falHostedWanModels`, `falRetiredKlingModel`,
`isFalHostedWanModel` and `prepareFalHostedWan`. The two Wan products are wired
into the existing registered fal queue adapter, which now validates their
native bodies before managed create. Requests remain fal products: JSON POST
`https://queue.fal.run/<selected model>`, Key authentication using the original
server FAL_KEY. Direct Alibaba/Qwen origin, model and credential contracts are
separate; no MODELSTUDIO_API_KEY or alias inheritance is introduced.

The frozen request intersection is prompt, resolution, aspect_ratio and one
image_url for image-to-video. Allowed resolution is 480p/580p/720p and ratio
16:9/9:16/1:1. Omitted image geometry preserves upstream auto; no default is
fabricated. The 32000-code-point prompt maximum is an adapter-local bound.
Inline PNG/JPEG/WebP images require canonical base64 and at most 8 MiB decoded
bytes. Remote input URLs/uploads stay closed pending original-credential asset
binding. No text route is silently switched to image-to-video.

Current native schemas do not define duration or size. The frozen client can
forward them; source2 must reject unsupported overrides. The codec does not
invent duration-to-num_frames conversion or expose extra frame/FPS/step knobs
that the frozen consumer never sends. Neither default frames nor inference
time prove an actual billable duration or dollar amount. Hard-dollar budgets
remain closed on unknown upstream cost, separately from policy_fixed charging.

The queue path helper permits bounded interior version dots, while rejecting
leading/trailing/repeated dots, traversal, encoded separators and empty parts.
The registered wrapper grants dotted input only to the two exact Wan products;
unknown four-segment routes and dotted Seedance apps remain closed. Native
controls are GET `/fal-ai/wan/requests/<bound id>/status`, GET the result at
the same root and PUT `/cancel`. Full original create model/parameters stay
in the job; the shared controller must resolve that original route when text
and image creates share the same control path, never the first matching offer.

The existing scoped controller retains caller/policy/credential binding,
idempotency, uncertainty, durable deadlines, restart/outbox and one terminal
settlement. No new controller, global job index or remote POST replay is added.
COMPLETED means retrieve the scoped result; queued cancel removal differs from
an in-progress acknowledgement, and missing/expired observations do not prove
failure or a refund. Result bodies remain transient; no output file receives
credentials or fetch authority from this codec.

`providers/_fixtures/fal/hosted-wan.json` supplies native request/lifecycle wires,
synthetic inline signature bytes and the historical Kling disposition. Tests
exercise the registered adapter plus queue/parameter boundaries, not live
decoding, paid cost proof or actual consumer acceptance.

Source3 handshake: use the four-segment create template
`/${owner}/${app}/${variant}/${subvariant}` with exact Wan model rows and existing
owner/app controls. Source1 owns original-create resolution and canonical FAL_KEY
admission; source2 owns consumer fixes; source5 retains new fal YAML additions;
source6 owns snapshots/E2E. This slice changes no shared controller/type/schema
or manifest. Activation requires those actual prerequisites; fixture coverage
alone does not establish full provider parity.

Primary schemas:
[Wan text](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/wan/v2.2-a14b/text-to-video),
[Wan image](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/wan/v2.2-a14b/image-to-video)
and [historical Kling](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/kling-video/v2.1/master/text-to-video).
No deployment, paid request, secret or commercial-account change was used.
