# Frozen fal Seedance contract

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/fal/video-generation-provider.ts`, explicitly lists six Seedance 2.0
products: standard and Fast text-to-video, image-to-video and reference-to-video.
`worker/fal-seedance.ts` exports that finite `falSeedanceModels` list,
`isFalSeedanceModel` and `prepareFalSeedance`. Model/path identity and native
body fields are preserved; no later model or automatic mode switch is accepted.
The registered fal wrapper now consumes this codec for exactly these six IDs.
Provider activation and actual durable Worker proof remain separately qualified.

Native JSON POST goes to `https://queue.fal.run/<selected model>` with Key
authentication from the original server FAL_KEY. Existing fal queue machinery
owns submit, status, result and cancel. Controls share the original
`/bytedance/seedance-2.0/requests/<bound id>` root, dropping the create-mode/Fast
suffix. Caller/policy/model/credential binding, uncertain create, deadlines,
restart, outbox and exactly one settlement remain in the existing scoped
controller. A lost submit response never authorizes POST replay or raw-ID access.

Duration is a native string from 4–15; omission preserves native auto and does
not establish billable duration. Fast permits 480p/720p; standard also permits
1080p/4k. Six native ratios and boolean generate_audio retain their exact shapes.
The frozen client can forward size, but current schemas define no size field:
source2 must reject that override. Explicit auto is outside the frozen caller's
duration/ratio choices. The 32000-code-point prompt maximum is a local bound,
not a claimed upstream maximum.

Image-to-video requires one inline image; text-to-video rejects references.
Reference-to-video preserves ordered arrays with at most nine images, three
videos, three audios and twelve total files. Audio-only references fail; no
references remains a qualified prompt-only native request. PNG/JPEG/WebP, MP4
and MPEG/WAV data URIs require canonical base64, at most 8 MiB per file and
16 MiB aggregate decoded bytes. MIME labels do not prove duration, valid tracks
or successful media decoding. Unowned remote URLs/uploads stay closed until
durable original-credential asset binding is qualified.

`providers/_fixtures/fal/seedance.json` includes all six native input shapes and
sanitized submit/running/completed/result wires. Tiny inline signature bytes
are transport fixtures, not live generation or decoding proof. Existing fal
observations verify the bound ID and keep COMPLETED as result readiness;
terminal results do not instruct further polling. Cancellation and expired or
missing observations retain the existing conservative lifecycle behavior.
Requested duration, inference time, result URLs and local timeouts do not prove
final dollar cost or refunds. Hard-dollar budgets deny unknown cost separately
from policy_fixed charging.

Concrete source1/source3 handoff: `falManagedAdapter.prepare` now accepts the
six IDs through the landed three/four-segment schema from
[PR609](https://github.com/openclaw/clawrouter/pull/609). It retains every original
create parameter, including Fast/mode. `identify` accepts only the exact dotted
owner/app root for scoped lookup; it grants no authority to a raw job ID.
`control` still requires the full retained qualified create parameters. The
controller already owns original-create selection; no replacement index or
first-matching-route fallback is introduced.

Public rewriting permits only
`/v1/native/fal/bytedance/seedance-2.0/requests/<id>` and its `/status` and `/cancel`
suffixes as dotted exceptions. Other protocols retain `mediaPublicPath` unchanged.
Arbitrary dotted apps, extra segments, encoded traversal and remote references
remain rejected. Existing HeyGen/Wan preparation and controls remain covered.
The new compiler integration test composes actual schema, registered wrapper,
public paths and shared control declarations for all six fixtures. Wrapper
serialization tests are not real Worker restart or cross-caller proof.

Source1 owns the promised actual Worker original-owner/restart tests, canonical
FAL_KEY admission and shared runtime; source3 owns schema, source2 the actual
consumer, source6 snapshots/E2E. The pending fal declaration and durable asset
binding remain prerequisites where applicable. No shared types/controller,
existing YAML, snapshots or generic public-path grammar change here. Native
wrapper qualification alone does not establish complete provider parity.

Primary schemas:
[Fast text](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/fast/text-to-video),
[Fast image](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/fast/image-to-video),
[standard text](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/text-to-video),
[standard image](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/image-to-video),
[Fast reference](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/fast/reference-to-video)
and [standard reference](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/reference-to-video).
No paid request, deployment, secret or commercial-account change was used.
