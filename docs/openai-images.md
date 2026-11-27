# OpenAI image generation and edits

ClawRouter supports **JSON Images API generation and inline-reference edits**, not variations.
**Edit budget limitation:** hard-budget edits require an existing fixed policy
tariff; see [accounting](#accounting-and-bounded-delivery). No policy changes automatically.
It uses normal proxy-key authentication, revocation, model allowlists,
Default-tier eligibility, grant selection, hard/soft policy and provider budgets,
fixed request tariff overrides, usage ledger and request-retention policy.
ChatGPT/Codex subscription grants remain Responses-only and cannot serve images.

## Routes and models

All routes use POST; the manifest route wraps input in `body`.

| Route | Generation | Edits |
| --- | --- | --- |
| Unified | `/v1/images/generations` | `/v1/images/edits` |
| Native | `/v1/native/openai/v1/images/generations` | `/v1/native/openai/v1/images/edits` |
| Manifest | `/v1/proxy/openai/images_generations` | `/v1/proxy/openai/images_edits` |

Edits use request format `openai.images_edits` and the existing
`openai.images_generations` response format (image JSON and modality usage).

The model/route/provider catalogs expose `image.generation` and `image.edit` for four models:

- `openai/gpt-image-2.5-sunburst`
- `openai/gpt-image-2.5-sunburst-2026-09-08`
- `openai/gpt-image-2.5-flare`
- `openai/gpt-image-2.5-flare-2026-09-08`

The unified route uses registered IDs with the openai/ prefix. Native routes
accept upstream aliases and snapshots. No model is selected implicitly. Older GPT Image models and retired DALL-E models are not
registered by this feature. API organization verification may be required upstream.

~~~javascript
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: process.env.CLAWROUTER_KEY,
  baseURL: "https://router.example/v1",
});
const result = await client.images.generate({
  model: "openai/gpt-image-2.5-flare",
  prompt: "A watercolor lighthouse on a small island",
  n: 1,
  size: "1024x1024",
  quality: "medium",
});
// result.data[0].b64_json is the upstream's unchanged base64 image.
~~~

## Qualified options

Prompt is required, nonempty and at most 32,000 Unicode code points. Image count
n is an integer 1–10 (default 1). Quality supports low, medium, high, xhigh, max and
auto (default). Size supports auto (default) or WIDTHxHEIGHT: multiples of 16,
edges at most 3840, aspect ratio at most 3:1, 655,360–8,294,400 total pixels.
Resolutions above 2560x1440 are experimental upstream.

Other options: background (auto/opaque/transparent), output_format
(png/jpeg/webp; default png), output_compression (integer 0–100 with explicit
jpeg/webp), moderation (auto/low), safety_identifier and deprecated user
(strings at most 128 code points). Transparent JPEG is rejected. Omit optional
values rather than sending null. stream:false is accepted; stream:true,
partial_images (even zero), legacy response_format, service tiers, unknown
options, caller query parameters and multipart bodies are rejected before any paid dispatch.

### Uploaded-reference edits

Send JSON, not multipart. In addition to the options above, edits require
`images: [{ image_url: "data:image/png;base64,..." }]`. Each object must contain
only `image_url`. References must be canonical standard-base64 PNG, JPEG, or
WebP data URLs with matching file signatures. Limits: **1–16 references, 4 MiB
decoded per reference, 8 MiB total UTF-8 JSON request** (including all options
and any manifest envelope). Pixel decoding remains upstream; these transport
limits do not establish billable-token bounds.

HTTP(S) URLs, File IDs, masks, markup, `input_fidelity`, and unknown fields are
rejected before dispatch. The router never fetches a reference URL. Generation
still rejects references and uses its unchanged generation route.

**Not supported:** Images SSE/partial-image streaming, variations, Batch,
or the Responses API image_generation tool. The latter has a distinct billing
contract and remains subject to the existing unpriced-hosted-tool guards.

## Accounting and bounded delivery

The provider manifest owns qualified limits, output-token envelope and three
Standard direct-Images tariffs: **$5/M text input tokens, $8/M image input tokens,
$30/M image output tokens**. These are not chat token prices or a flat per-image
fee. Settlement requires consistent usage.input_tokens,
input_tokens_details.text_tokens/image_tokens, output_tokens and total_tokens.
When supplied, output_tokens_details splits image output from unbilled text
output. Missing or malformed usage cannot discount the reservation.

OpenAI's guide explicitly says cached-input pricing for these models applies
only to the Responses image tool, **not direct Images requests**. Direct Images
receives no cache discount, even if a cached counter appears. Published cached
text/image prices ($1.25/M and $2/M) are not misapplied to this endpoint.

For **generation**, before hard-budget dispatch, reserve UTF-8 prompt bytes plus 1024 framing tokens
per image and a conservative output envelope for every requested image. The
current official guide embeds a calculator with an **explicit GPT Image 2.5
(Sunburst and Flare) mode**. Its quality factors are 16/24/48/64/96, not the older
GPT Image 2 factors 16/48/96. The calculator uses a rounded short-axis factor and
ceil(longFactor * shortFactor * (2,000,000 + pixels) / 4,000,000) tokens. Each axis
factor is at most the chosen quality factor; its square and maximum pixel count
cover every accepted resolution, including auto. Auto quality reserves max.
This intentionally over-reserves smaller images; valid terminal usage releases
the difference. These are admission envelopes, never synthetic actual counts
or a promise about cost per image. The model-page warning about the older GPT
Image 2 calculator is not permission to reuse that model's coefficients.

For **edits**, no source-qualified GPT Image 2.5 reference-input ceiling is
published. `opaque_input_bound` makes hard policy monthly/daily/weekly and
provider monthly budgets fail closed with `pricing_required` unless a fixed
policy tariff already applies. Fixed tariffs, including zero, are policy charges,
not measured provider costs. Soft/unmetered policies retain existing admission
and settle consistent usage at the modality rates above; missing/inconsistent
usage remains `unpriced_usage`, not free work or a generation-only reservation.
The vision calculator excludes GPT Image; its historical GPT Image 1 input
rules do not qualify a 2.5 bound.

For **generation**, fixed policy tariffs (including zero) retain precedence. Known HTTP rejections
settle at zero. Ambiguous dispatched failures, incomplete delivery and missing
usage keep the image reservation estimate, including soft-budget settlement;
soft budgets still dispatch/check with their existing fail-open semantics.

The demand-driven JSON inspector parses bounded feeds and retains only bounded
scalar usage metadata, even after multi-megabyte base64 strings. It never
buffers/tees/drains an entire image for accounting. Original bytes, backpressure
and caller cancellation are preserved. Edits keep the 600-second upstream
operation deadline through response EOF/cancellation and never retry a paid POST
or follow redirects. Edit input (including references and prompt) is not archived.
For generation, input JSON is archived when request retention is on; generated images are **never** archived. Prompts/images are not
added to usage events or logs. See [Content retention](content-retention.md).

## Official sources

Generation checked **2026-10-20**; edits rechecked **2026-11-12**.
No paid image call was made for qualification/tests:

- https://developers.openai.com/api/reference/resources/images/methods/edit
- https://developers.openai.com/api/docs/guides/images-vision#gpt-image-model-inputs
- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/reference/resources/images/methods/generate
- https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
- https://developers.openai.com/api/docs/models/gpt-image-2.5-flare
- https://developers.openai.com/api/docs/pricing
- Guide's explicit 2.5 calculator bundle:
  https://developers.openai.com/_astro/GptImageTokenCalculator.react.BLizhTXM.js

The guide and live calculator qualify generation reservation, not reference-input
reservation for edits; actual usage remains the settlement authority. Upstream changes require requalification before extending
this contract.
