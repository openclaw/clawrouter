# Frozen Kie Hailuo video contract

`kieHailuoModels` and `prepareKieHailuoWire` qualify the six Hailuo IDs from
frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/kie/video-generation-provider.ts`. The existing `prepareKieTask`
and registered `kieManagedAdapter` consume both text models before dispatch.
No separate controller, raw job-ID route or provider alias is introduced.

| Native ID | Mode | Duration input | Resolution input | Prompt limit |
| --- | --- | --- | --- | --- |
| hailuo/02-text-to-video-standard | text | required string 6 or 10 | absent | 1500 |
| hailuo/02-image-to-video-standard | image | required string 6 or 10 | required 512P or 768P | 1500 |
| hailuo/02-text-to-video-pro | text | absent | absent | 1500 |
| hailuo/02-image-to-video-pro | image | absent | absent | 1500 |
| hailuo/2-3-image-to-video-standard | image | required string 6 or 10 | required 768P or 1080P | 5000 |
| hailuo/2-3-image-to-video-pro | image | required string 6 or 10 | required 768P or 1080P | 5000 |

For both 2.3 models, 1080P requires six seconds. Numeric durations, lowercase
resolutions, silent rounding and missing required settings are rejected.
Prompt limits count Unicode code points and reject empty or malformed Unicode.
Pro 02 has no duration/resolution fields: advertised output characteristics do
not become a caller setting, measured duration or cost receipt. The frozen
client does not send prompt_optimizer, end_image_url, geometry, audio flags or
arbitrary extensions; those fields and callbacks remain outside this slice.

Native JSON POST uses `https://api.kie.ai/api/v1/jobs/createTask` with the
original server KIE_API_KEY as Bearer. Kie Hailuo is separate from direct MiniMax
and fal products; their accounts, credentials, model names and tariffs are not
interchangeable. Each image body contains one bounded HTTPS `image_url`, not an
array. This validates wire shape only. Actual image creates still throw
`kie_image_binding_required`. JPEG/PNG/WebP content, the native 10 MB limit and
original caller/model/credential asset ownership require runtime qualification.
The frozen separate `https://kieai.redpandaai.co/api/file-base64-upload` route
remains closed; no URL authorizes server fetching or credential forwarding.

Retrieval uses only GET `/api/v1/jobs/recordInfo?taskId=<original bound id>`
through the established scoped BackgroundStore, reservation, idempotency and
outbox machinery. Partial URLs do not complete a generating job. Native success
or fail ends polling even without results or metrics; lost visibility does not
prove failure or a refund. There is no cancellation or separate result endpoint.
An uncertain create or failed delivery never authorizes replaying POST. Output
URLs are transient descriptors, not authenticated download authority.

`providers/_fixtures/kie/hailuo-video.json` supplies synthetic native inputs,
partial/terminal/visibility-loss observations and unknown cost. Credits are
provider units, not a qualified dollar tariff. Hard upstream-dollar budgets stay
closed on unknown cost; policy_fixed remains a distinct charging basis.

Source1 owns durable asset binding and runtime/accounting proof, source2 actual
native consumers, source3 shared schema/pricing, and source6 snapshots/E2E.
The new Kie declaration and returned-model guard stay on
[PR580](https://github.com/openclaw/clawrouter/pull/580). This contract does not
claim image activation, full end-to-end parity or live cost proof.

Primary native schemas:
[02 Standard text](https://docs.kie.ai/market/hailuo/02-text-to-video-standard.md),
[02 Standard image](https://docs.kie.ai/market/hailuo/02-image-to-video-standard.md),
[02 Pro text](https://docs.kie.ai/market/hailuo/02-text-to-video-pro.md),
[02 Pro image](https://docs.kie.ai/market/hailuo/02-image-to-video-pro.md),
[2.3 Standard image](https://docs.kie.ai/market/hailuo/2-3-image-to-video-standard.md),
[2.3 Pro image](https://docs.kie.ai/market/hailuo/2-3-image-to-video-pro.md).
