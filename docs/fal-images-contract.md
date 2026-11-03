# fal native image slice

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/fal/image-generation-provider.ts` and `http-config.ts`, use
synchronous JSON POSTs at `https://fal.run/<model>` with
`Authorization: Key <selected server FAL_KEY>`. This bounded slice covers
`fal-ai/flux/dev`, `fal-ai/flux/dev/image-to-image`,
`krea/v2/medium/text-to-image` and `krea/v2/large/text-to-image`.
Direct Black Forest Labs/Krea products and credentials remain separate.

`worker/fal-images.ts` exports `prepareFalImage`,
`assertFalImageDispatch`, `observeFalImage` and `readFalImage`.
The selected native model/path and validated body are preserved. Generation and
edit are explicit endpoint identities; the codec does not rewrite one to another.
The sanitized fixture is `providers/_fixtures/fal/images.json`.

FLUX generation supports count1–4, PNG/JPEG and qualified image_size. FLUX edit
requires one inline image and rejects geometry fields absent from its native
schema. Krea supports one image, native aspect_ratio/creativity and up to10
inline style references; it rejects count, output_format and image_size.
Inputs allow only bounded canonical PNG/JPEG/WebP data URIs, with8MiB each and
16MiB aggregate decoded bytes. The synthetic fixture proves wire handling,
not that its signature bytes form a decodable real image.

Complete HTTP200 JSON exposes bounded image URL descriptors. A shorter nonempty
batch is marked partial. Native per-image flags stay visible; neither partial
delivery nor a flagged result proves free generation. Missing output, queue ACKs,
foreign model identities, redirects, truncated/ranged bodies and local reader
cancellation fail closed. A local abort does not acknowledge remote cancellation.
No automatic paid POST replay or queue fallback is added.

Output URLs remain opaque and receive no credentials. Actual consumer delivery
requires output ownership, DNS/redirect policy, MIME and byte checks. No upload,
raw external input fetch, file authority store or authenticated download route
is added. Native prompts/results remain transient, not logs or durable receipts.

Source3 schema handshake: proposed `fal.image_create` / `fal.images` for
the exact four paths, capability `image.generate`, synchronous POST with no
lifecycle links. Source1 owns shared Worker dispatch, original credentials,
budget admission and settlement; source2 owns image consumer integration;
source6 owns snapshot and end-to-end proof. Source5 retains the new fal manifest
queue and later finite image slices. No common runtime, schema, existing provider
or generated snapshot is edited here. Registration/activation remains pending;
this source slice is not complete fal parity.

## Primary qualification

- [Synchronous HTTP](https://fal.ai/docs/api-reference/inference-api/sync/run)
  supplies Key authentication and HTTP200 output at fal.run, separate from queue
  IDs and controls. No retry hint establishes idempotent paid execution.
- [FLUX dev schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux/dev)
  qualifies count1–4, image dimensions1–14142 and PNG/JPEG.
- [FLUX edit schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux/dev/image-to-image)
  has image_url, prompt, count and format, but no image_size. Frozen OpenClaw
  can forward explicit size/resolution on edit; source2 must handle that mismatch.
- [Krea medium](https://fal.ai/models/krea/v2/medium/text-to-image/api) and
  [large](https://fal.ai/models/krea/v2/large/text-to-image/api) qualify the native
  ratios, creativity, prompt limit5000 and maximum10 style references.

No qualified dollar preflight bound or final tariff receipt is established.
Image count/geometry/flags are not measured upstream cost. Unknown tariffs stay
closed under hard upstream-dollar budgets; policy_fixed remains separate.
No live request, deployment, secret access or commercial-account change was used.
