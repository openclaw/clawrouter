# fal Nano Banana image contract

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/fal/image-generation-provider.ts`, qualifies this finite slice:

- `fal-ai/nano-banana` and `fal-ai/nano-banana/edit`
- `fal-ai/nano-banana-2` and `fal-ai/nano-banana-2/edit`
- `google/nano-banana-2-lite` and `google/nano-banana-2-lite/edit`

These are fal products. JSON POST goes to `https://fal.run/<selected model>`
with native `Authorization: Key <selected server FAL_KEY>`. Direct Google
credentials, Gemini model names and queue endpoints are separate contracts.
The adapter never substitutes a product or automatically chooses an edit path.

`worker/fal-nano-images.ts` exports `falNanoImageModels`, `prepareFalNanoImage`,
`assertFalNanoImageDispatch`, `observeFalNanoImage` and `readFalNanoImage`.
The last two reuse the native image-result reader introduced in
[PR588](https://github.com/openclaw/clawrouter/pull/588). Outputs retain partial
batch and safety-flag evidence, selected identity and unknown upstream cost.
Returned URLs carry no credential headers or authority to fetch arbitrary files.

Native prompts contain 3–50000 Unicode code points. Output count is 1–4 and
the frozen output formats are PNG/JPEG. Legacy Nano Banana permits ten native
ratios; Nano Banana 2 and Lite add 4:1, 1:4, 8:1 and 1:8. Only Nano Banana 2
accepts the frozen 1K/2K/4K resolution override. Legacy and Lite reject it;
none accepts an invented image_size field. Omitted geometry stays omitted,
preserving native defaults (including auto on edit/new models). Explicit auto,
null, 0.5K, WebP output and newer audio/video/PDF references are outside this
frozen consumer surface and are rejected rather than silently discarded.

Edits require 1–3 ordered inline images on legacy and 1–14 on Nano Banana 2
and Lite. PNG/JPEG/WebP data URIs are validated as canonical base64 with
8 MiB per image and 16 MiB total decoded bytes. Remote references and uploads
remain closed until the caller's original credential/asset binding is qualified.
Fixture `providers/_fixtures/fal/nano-images.json` is sanitized synthetic wire
evidence; its inline signature bytes do not prove successful image decoding.

Source3 handshake: proposed `fal.nano_image_create` request format and
`fal.images` response format, synchronous image generation at the six exact
paths. Source1 owns actual Worker dispatch, policy admission, credential
lineage, reservation and settlement. Source2 owns native consumer selection
and output delivery. Source6 owns snapshot and end-to-end acceptance. This
codec does not activate a manifest endpoint or establish production parity.
It introduces no lifecycle controller or global job IDs.

The shared reader requires complete HTTP 200 JSON, rejects queue envelopes,
redirects, truncation and foreign model identity, and respects local abort.
Neither abort nor a partial/flagged result proves free generation or authorizes
a second POST. Output resolution and requested count are not a billing receipt.
No qualified final dollar tariff/bound is established; hard upstream-dollar
budgets must deny unknown cost, separately from policy_fixed charging.

Primary evidence is the current fal API/schema for
[legacy generate](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/nano-banana),
[legacy edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/nano-banana/edit),
[Nano Banana 2 generate](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/nano-banana-2),
[Nano Banana 2 edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/nano-banana-2/edit),
[Lite generate](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=google/nano-banana-2-lite)
and [Lite edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=google/nano-banana-2-lite/edit),
plus the [synchronous run contract](https://fal.ai/docs/api-reference/inference-api/sync/run).
No live generation, secret, account change or deployment was used.
