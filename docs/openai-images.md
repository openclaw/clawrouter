# OpenAI image generation

ClawRouter supports **JSON Images API generation**, not edits or variations.
It uses normal proxy-key authentication, revocation, model allowlists,
Default-tier eligibility, grant selection, hard/soft policy and provider budgets,
fixed request tariff overrides, usage ledger and request-retention policy.
ChatGPT/Codex subscription grants remain Responses-only and cannot serve images.

## Routes and models

- `POST /v1/images/generations`: standard OpenAI `images.generate` SDK route.
- `POST /v1/native/openai/v1/images/generations`: native upstream model slugs.
- `POST /v1/proxy/openai/images_generations`: manifest envelope with `body`.

The model/route/provider catalogs expose `image.generation` and four models:

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

**Not supported:** Images SSE/partial-image streaming, edits, variations, Batch,
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

Before hard-budget dispatch, reserve UTF-8 prompt bytes plus 1024 framing tokens
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

Fixed policy tariffs (including zero) retain precedence. Known HTTP rejections
settle at zero. Ambiguous dispatched failures, incomplete delivery and missing
usage keep the image reservation estimate, including soft-budget settlement;
soft budgets still dispatch/check with their existing fail-open semantics.

The demand-driven JSON inspector parses bounded feeds and retains only bounded
scalar usage metadata, even after multi-megabyte base64 strings. It never
buffers/tees/drains an entire image for accounting. Original bytes, backpressure
and caller cancellation are preserved. Only input JSON is archived when request
retention is on; generated images are **never** archived. Prompts/images are not
added to usage events or logs. See [Content retention](content-retention.md).

## Official sources

Checked **2026-10-20**; no paid image call was made for qualification/tests:

- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/reference/resources/images/methods/generate
- https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
- https://developers.openai.com/api/docs/models/gpt-image-2.5-flare
- https://developers.openai.com/api/docs/pricing
- Guide's explicit 2.5 calculator bundle:
  https://developers.openai.com/_astro/GptImageTokenCalculator.react.BLizhTXM.js

The guide and live calculator qualify reservation; actual usage remains the
settlement authority. Upstream changes require requalification before extending
this contract.
