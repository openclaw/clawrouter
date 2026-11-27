# Frozen Kie Grok video contract

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/kie/video-generation-provider.ts`, selects exactly
`grok-imagine/text-to-video` and `grok-imagine/image-to-video`.
`worker/kie-grok.ts` exports `kieGrokModels` and `prepareKieGrokWire`.
The existing `prepareKieTask` and registered `kieManagedAdapter` validate the
text request before managed create. No parallel controller or registry exists.

Native JSON POST is `https://api.kie.ai/api/v1/jobs/createTask`, using the
original server-selected KIE_API_KEY with Bearer authentication. Direct xAI and
fal Grok identities, accounts, aliases and prices are separate contracts.

The qualified input contains a nonempty prompt up to 5000 Unicode code points,
integer duration 6–30 and optional lowercase 480p/720p/1080p resolution. Text
duration is a JSON number; image duration is its canonical decimal string.
Both Kie's published OpenAPI schema and the frozen client use this distinction.
The text page's string-valued example conflicts with its schema; this adapter
does not infer acceptance of both types from that example. No rounding or
coercion occurs. Text ratios are 16:9, 2:3, 3:2, 1:1 and 9:16. Image mode accepts
one reference and no ratio override. Omitted options remain omitted, not known
duration/cost evidence. Audio control, mode, size, callback and arbitrary input
fields are outside the frozen consumer contract. Native text output includes
audio; a caller cannot request silent output by sending an unsupported flag.

Image wire qualification requires one bounded HTTPS URL, with no credentials,
private host, inline data, raw previous task ID or index. The current vendor API
also documents multiple image references and previous-task input; those are not
part of this frozen slice. Valid wire data grants no upload, asset fetch or
create authority. The registered image path throws `kie_image_binding_required`
until the shared runtime can bind input assets to the original caller, model
and credential. The frozen upload host `https://kieai.redpandaai.co` and path
`/api/file-base64-upload` remain separate from the job origin. No raw upload URL,
caller boolean or previous job ID bypasses this boundary.

Existing scoped BackgroundStore/reservation/idempotency/outbox machinery owns
original caller/policy/credential binding, dispatch uncertainty, deadlines,
restart and one terminal settlement. Only the original GET
`/api/v1/jobs/recordInfo?taskId=<bound id>` is a control. No cancellation or
separate result endpoint is claimed. Generating with partial URLs is nonterminal;
success/fail stops even without usable output or metrics. Observation loss or an
HTTP-200 API error does not prove execution failure or a refund. Missing media
cannot reopen polling or authorize replay of the paid POST. Returned URLs are
transient descriptors without download or credential authority.

`providers/_fixtures/kie/grok-video.json` supplies sanitized native text/image
requests, submit, partial, terminal and unavailable observations. Synthetic
creditsConsumed is not a dollar receipt. No qualified model tariff or whole-job
dollar bound is established; unknown upstream cost stays closed under hard-dollar
budgets, independently of policy_fixed charging. No live paid calls are required
for these deterministic contracts.

Source1 owns asset binding and shared Worker/accounting proof; source2 owns the
actual consumer and input asset selection; source3 owns shared schema/model
pricing; source6 owns snapshots/E2E. Source5's new Kie manifest and returned-model
guard remain on [PR580](https://github.com/openclaw/clawrouter/pull/580). This slice
does not edit that guard, shared types/controller/schema or snapshots. Qualified
text input does not establish complete provider activation or image parity.

Primary evidence: [Kie text schema](https://docs.kie.ai/market/grok-imagine/text-to-video.md)
and [Kie image schema](https://docs.kie.ai/market/grok-imagine/image-to-video.md).
