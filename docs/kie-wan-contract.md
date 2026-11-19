# Frozen Kie Wan 2.6 contract

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/kie/video-generation-provider.ts`, declares exactly
`wan/2-6-text-to-video` and `wan/2-6-image-to-video`. The new `kieWanModels` and
`prepareKieWanWire` exports qualify their native bodies. Existing `prepareKieTask`
and registered `kieManagedAdapter` consume the text contract before dispatch;
there is no additional controller or job index.

Native JSON POST is `https://api.kie.ai/api/v1/jobs/createTask`, authenticated with
the original server KIE_API_KEY using Bearer. Kie Wan is a distinct product from
Alibaba/DashScope, hosted Qwen and fal Wan. No provider/model alias, origin or
credential interchange is inferred from the shared model family name.

Duration is the native string 5, 10 or 15; numeric values and rounding are rejected.
Resolution is lowercase 720p or 1080p. The text API explicitly asks callers to set
resolution, so omission is rejected before create. Omitted image resolution or
duration remains omitted and is not a measured or priced default. Prompts are
bounded to 5000 Unicode code points; image prompts require at least two code points after trimming edge whitespace. Ratio, size, audio flags, prompt extension, seed, callback
and arbitrary native extensions are outside this frozen client contract.

The image wire contains exactly one bounded HTTPS image_urls entry. A URL grants
no upload, fetch, MIME, dimensions or ownership authority. Actual image create
throws `kie_image_binding_required` until the shared runtime qualifies the
original caller/model/credential asset binding. Kie's image contract requires
JPEG/PNG/WebP, at most 10 MB and at least 256×256; those content properties cannot
be proven from an unowned URL. The frozen uploader's separate
`https://kieai.redpandaai.co/api/file-base64-upload` route remains closed here.

The existing scoped BackgroundStore/reservation/idempotency/outbox flow owns
credential lineage, uncertain create, deadlines, restart and one terminal
settlement. GET `/api/v1/jobs/recordInfo?taskId=<bound id>` is the only control;
cancellation and a separate result route are unsupported. Partial result URLs
do not complete execution. Native success/fail stops even without usable media
or metrics. Missing visibility is not failure or a refund, and failed delivery
never authorizes another POST. Output URLs remain transient descriptors without
download or credential authority.

`providers/_fixtures/kie/wan-video.json` contains synthetic native requests and
lifecycle observations. Its creditsConsumed value does not qualify a dollar
tariff. Duration and resolution affect the request but do not establish a
whole-job cost receipt. Unknown upstream cost stays closed under hard-dollar
budgets, separately from policy_fixed charging.

Source1 owns durable asset binding and shared runtime/accounting proof; source2
owns actual native consumers; source3 owns shared schema/model pricing; source6
owns snapshots/E2E. The existing source5 Kie declaration and returned-model guard
remain on [PR580](https://github.com/openclaw/clawrouter/pull/580). This slice
changes neither that manifest/guard nor common controller/types/schema. It does
not claim full activation, image parity, live generation or live cost proof.

Primary evidence: [Kie text schema](https://docs.kie.ai/market/wan/2-6-text-to-video.md)
and [Kie image schema](https://docs.kie.ai/market/wan/2-6-image-to-video.md).
