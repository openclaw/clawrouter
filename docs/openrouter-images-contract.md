# OpenRouter native image requests

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/openrouter/image-generation-provider.ts`. This bounded native slice
preserves `google/gemini-3.1-flash-image-preview`,
`google/gemini-3-pro-image-preview`, and `openai/gpt-5.4-image-2`. The latter is
a distinct multimodal model; never silently replace it with `openai/gpt-image-2`.
The codec list does not advertise live endpoint availability or tariffs.

`prepareOpenRouterImage(model, body)` returns JSON `POST /api/v1/images` for the
original admitted OpenRouter grant. Each native call requires `n:1`. The frozen
consumer fans a 1–4-image batch into separate paid calls. Each dispatch needs its
own admission/settlement; if a sibling fails, the successful or uncertain calls
do not become free and must not be replayed. The codec does no fanout or I/O.

The frozen Gemini aspect ratios and 1K/2K/4K options are preserved. The frozen
OpenAI route omits those options; newer parameters are not added. Edits accept
1–5 ordered inline PNG/JPEG/WebP references, bounded to 14 MiB decoded total.
Remote inputs, arbitrary file IDs and provider passthrough are outside this
slice. Prompts are bounded to 32,768 UTF-16 units; JSON to 24 MiB.

`observeOpenRouterImage(body, request, complete)` and
`readOpenRouterImage(response, request, signal)` accept one complete native
base64 image. The shared strict JSON reader enforces HTTP/MIME/length/abort
boundaries. Decode is bounded to 16 MiB and checks PNG/JPEG/WebP signatures;
`media_type` and legacy `mime_type` must agree with detected bytes. Signature
checks are not a full image decoder. No SVG or arbitrary result-URL fetch is
enabled. Error, filtered/partial output, extra images or a conflicting returned
model reject successful delivery. A missing response model stays unknown; it
is not synthesized from the selected model.

Native `usage` including `usage.cost` remains transient evidence. It cannot
establish a qualified tariff or preflight maximum by itself. Dollar cost stays
unknown; hard upstream-dollar budgets remain closed until model, reference,
resolution, token and endpoint billing are qualified. Policy-fixed charging is
separate. Do not derive money from image count or a successful sibling.

Source3 owns existing OpenRouter YAML/model/pricing and a proposed dedicated
`openrouter.images` request/response declaration. This native shape is not
OpenAI `/images/generations`. Source1 owns actual dispatch, original credentials,
body limits, fresh admission and settlement. Source2 owns the actual native
consumer/fanout and source6 acceptance. The frozen custom-origin Chat image path
is a separate, configured origin/grant contract; this adapter does not reroute
those credentials to OpenRouter or claim that path is qualified. No live route
activation or complete image parity is claimed here.

Fixture: `providers/_fixtures/openrouter/images.json`.
Checks: `node --test worker/test/openrouter-images.test.mjs`.

Primary evidence checked 2026-11-03:

- [Native Image API and per-endpoint capability/billing](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
- [Frozen GPT-5.4 Image 2 identity](https://openrouter.ai/openai/gpt-5.4-image-2)
- [Frozen Gemini Pro image identity](https://openrouter.ai/google/gemini-3-pro-image-preview)
- [Frozen Gemini Flash image identity](https://openrouter.ai/google/gemini-3.1-flash-image-preview)
