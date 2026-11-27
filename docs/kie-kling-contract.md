# Frozen Kie Kling 2.6 contract

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/kie/video-generation-provider.ts`, explicitly maps
`kling-2.6/text-to-video` and `kling-2.6/image-to-video` to native Market jobs.
`worker/kie-kling.ts` exports `kieKlingModels` and `prepareKieKlingWire`.
The existing `prepareKieTask` and registered `kieManagedAdapter` now validate
the text product before managed create; no new controller or registry is added.

Native JSON POST is `https://api.kie.ai/api/v1/jobs/createTask` with model/input
and Bearer authentication from the original server KIE_API_KEY. The exact model
stays selected; fal Kling and direct Kling accounts/models are separate. The
body admits a bounded prompt, native duration string 5/10, boolean sound and
text ratios 16:9/1:1/9:16. No rounding, scalar coercion, resolution, size, callback
or credential fields are accepted. Omitted duration/sound stay omitted and
unknown, not free or default-price evidence. Prompt maximum is 1000 characters
for this frozen contract.

Image wire validation requires one bounded HTTPS image_urls entry, with no
geometry override, credentials in the URL, inline data or private host. This
does not authorize an upload, asset fetch or create. The actual managed image
path fails with `kie_image_binding_required` until source1 publishes a durable
original-caller/model/credential asset contract. The frozen client uploads local
images at the separate `https://kieai.redpandaai.co/api/file-base64-upload` host;
that host and its returned downloadUrl must not silently inherit job authority.
No upload or image job is activated here, and no caller boolean can bypass it.

Existing scoped BackgroundStore/reservation/idempotency/outbox behavior owns
dispatch uncertainty, caller/policy/original credential binding, deadlines,
restart and one frozen terminal settlement. Controls are only the original
GET `/api/v1/jobs/recordInfo?taskId=<bound id>`. Cancellation/result endpoints
are unsupported. HTTP-200 API errors are not terminal failure/refund evidence.
Generating with partial resultUrls stays nonterminal; native success/fail stops
even when media or metrics are absent. Unusable output cannot reopen polling
or authorize another POST. Result URLs remain transient descriptors without
credential or download authority.

`providers/_fixtures/kie/kling-video.json` supplies sanitized text/image native
wires and lifecycle observations. Its creditsConsumed value is synthetic,
not a dollar receipt. Kie's primary docs say sound changes pricing; no frozen
dollar tariff or whole-job billing bound is established. Unknown cost remains
closed under hard-dollar budgets, independently of policy_fixed charging.

Source1 owns asset/upload binding and actual shared runtime proof; source2
owns the native consumer and server-selected image reference; source3 owns any
shared schema/model pricing; source6 owns snapshots/E2E. Source5 retains the new
Kie declaration at [PR580](https://github.com/openclaw/clawrouter/pull/580), including
its existing returned-model guard. This PR does not edit that manifest or guard,
shared types/controller/schema, or snapshots. Image activation and full provider
parity remain open beyond this qualified text-route input.

Primary protocol evidence:
[Kie text](https://docs.kie.ai/market/kling/text-to-video) and
[Kie image](https://docs.kie.ai/market/kling/image-to-video).
No live paid request, deployment, secret or commercial-account change was used.
