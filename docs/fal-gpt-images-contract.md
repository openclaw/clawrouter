# fal GPT Image 2.5 contract

This is a bounded continuation of the native fal image contract, using the
shared image-result reader from [PR588](https://github.com/openclaw/clawrouter/pull/588).
Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/fal/image-generation-provider.ts`, explicitly names four products:

- `openai/gpt-image-2.5/flare/text-to-image`
- `openai/gpt-image-2.5/flare/edit`
- `openai/gpt-image-2.5/sunburst/text-to-image`
- `openai/gpt-image-2.5/sunburst/edit`

All use JSON POST to `https://fal.run/<model>` and native
`Authorization: Key <selected server FAL_KEY>`. They are fal products, not
direct OpenAI endpoints or credential aliases.

`worker/fal-gpt-images.ts` exports `prepareFalGptImage`,
`assertFalGptImageDispatch`, `observeFalGptImage` and `readFalGptImage`.
The latter two reuse the qualified image reader, retaining partial batch,
native flag, strict HTTP, bounded URL and unknown-cost behavior. No duplicate
controller, download authority or result-parser framework is introduced.

The four exact model/path identities remain distinct. The caller selects edit
explicitly and supplies1–16 ordered inline PNG/JPEG/WebP references, with8MiB
per image and16MiB aggregate decoded bytes. Generation rejects references;
neither operation rewrites the selected model. Frozen output count remains1–4
although fal's current schema permits10. Native PNG/JPEG/WebP, six quality
settings and background flags remain unchanged. Explicit transparent JPEG is
rejected locally because it cannot preserve the requested transparency.
An omitted quality stays omitted; `auto` is not relabeled as high or low.

Concrete dimensions must be multiples of16, have edges at most3840, total area
655360–8294400 pixels and ratio at most3:1. Qualified native presets and auto
remain available. No invented4K override or geometry rescaling is applied.
The fixture `providers/_fixtures/fal/gpt-images.json` has synthetic inline
signature bytes; it proves transport/validation, not successful image decoding.

Source3 handshake: proposed `fal.gpt_image_create` / `fal.images`, exact
paths above, synchronous image generation with no lifecycle control links.
Source1 owns generic Worker dispatch, credential lineage, reservation and
settlement; source2 owns actual consumer path/format selection and safe output
delivery; source6 owns snapshots and end-to-end acceptance. Source5 retains new
fal manifest additions. The common runtime/schema and manifests stay unchanged
in this slice. Output URLs are descriptors, never credential destinations or
authority for arbitrary fetches. No paid retry or queue conversion is added.

Primary schemas:
[Flare generate](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/flare/text-to-image),
[Flare edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/flare/edit),
[Sunburst generate](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/sunburst/text-to-image),
[Sunburst edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/sunburst/edit).
The [synchronous API](https://fal.ai/docs/api-reference/inference-api/sync/run)
qualifies fal.run and Key authentication.

Quality, input references and output dimensions affect generation work; no
qualified dollar bound or final billing receipt is established here. Unknown
upstream costs remain closed under hard budgets, separately from policy_fixed.
Partial output, flags, local cancellation and download failure never prove free
generation. No live request, deployment, secret or account change was used.
