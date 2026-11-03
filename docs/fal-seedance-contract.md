# Frozen fal Seedance contract

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/fal/video-generation-provider.ts`, explicitly lists six Seedance 2.0
products: standard and Fast text-to-video, image-to-video and reference-to-video.
`worker/fal-seedance.ts` exports that finite `falSeedanceModels` list,
`isFalSeedanceModel` and `prepareFalSeedance`. Model/path identity and native
body fields are preserved; no later model or automatic mode switch is accepted.
This is deterministic codec qualification, not an activated provider route.

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

Concrete source1/source3 handoff: the current fal route-segment validator and
shared public-path validator reject the dot in `seedance-2.0`; Fast also needs
four create segments. Qualify these exact dotted app/control paths under the
existing scoped route machinery without admitting traversal, encoded path
injection or arbitrary first-matching create routes. Source5 will consume that
published contract in its fal wrapper; source3 owns schema links, source2 actual
client behavior, source6 snapshots/E2E. Canonical FAL_KEY runtime admission and
the pending fal declaration remain prerequisites. This slice does not alter
the registry, shared types/runtime/schema, existing YAML or snapshots, and
helper tests alone are not provider parity proof.

Primary schemas:
[Fast text](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/fast/text-to-video),
[Fast image](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/fast/image-to-video),
[standard text](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/text-to-video),
[standard image](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/image-to-video),
[Fast reference](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/fast/reference-to-video)
and [standard reference](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/reference-to-video).
No paid request, deployment, secret or commercial-account change was used.
