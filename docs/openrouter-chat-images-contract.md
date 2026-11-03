# Frozen custom-host Chat image compatibility

OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/openrouter/image-generation-provider.ts`, uses a dedicated `/images`
request on the canonical OpenRouter origin, and a Chat request on custom base
URLs. This codec implements the latter contract for the same three frozen image
models. It does not assume an arbitrary host serves those models.

The current [OpenRouter image documentation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation),
checked 2026-11-03, describes the dedicated API. It does not qualify every custom
host's legacy Chat image behavior, billing or cancellation. Live-host qualification
remains necessary before activation; deterministic implementation does not wait
for a commercial account or credential.

`worker/openrouter-chat-images.ts` exports `prepareOpenRouterChatImages`,
`observeOpenRouterChatImages`, and `readOpenRouterChatImages`. The sanitized
fixture is `providers/_fixtures/openrouter/chat-images.json`.

## Request and result

The trusted server grant supplies `selectedBaseUrl` and `chatImagesQualified`.
Only qualified HTTPS custom origins are accepted. Public OpenRouter is excluded
from this compatibility route; there is no automatic retry/fallback after a native
image request fails. Runtime must select and pin origin/API prefix and credential
together. Client secret, origin, URL override and provider passthrough are closed.

Native request: `POST <selected-prefix>/chat/completions`, one user message,
`modalities: [image, text]`, `n: 1..4`, optional Gemini `image_config`, and optional
inline image parts after the prompt. The entire count is one paid Chat request;
do not fan it out into dedicated image calls. `prepareOpenRouterImage` reuses the
finite model, prompt, geometry and inline-reference checks. Its returned
`imageContract` is validation metadata only, never an alternate dispatch request.

The reader accepts bounded complete HTTP 200 JSON. Frozen response forms include
`message.images`, image URL parts, base64 parts, camel/snake-case inline image
parts, and inline data URLs in text. All images pass the landed native image
byte/signature/MIME checks. No remote output fetch or arbitrary result credential
destination exists. Conflicting metadata, errors, filtered/unfinished choices,
wrong models, duplicate choice indexes and excess output count fail closed.
Encrypted reasoning remains transient native payload, never image output.

Response limit is 64 MiB including reasoning; decoded output totals at most
32 MiB, each image at most 16 MiB. These are local caps. Image-header recognition
does not prove full decoder validity. Fewer images than requested remain explicit
`delivery: partial`, matching the frozen consumer's acceptance of returned images
without falsely promising the full requested count. No partial fee or refund is
invented. Native usage is optional and upstream cost remains unknown.

## Owner handoff

- Source1 owns selected custom-host grant, credential lineage, JSON admission,
  original dispatch uncertainty and settlement; no paid request replay on abort.
- Source3 owns existing OpenRouter schema/YAML and qualified host tariff. Reuse
  `openai.chat_completions` only with an explicit `image.generate` qualification
  and this codec; ordinary text Chat capability does not grant image output.
- Source2 owns the actual custom-base consumer and its count/error behavior.
- Source6 owns deterministic Worker/client proof and any snapshot integration.

Five focused tests cover host qualification, frozen request conversion, response
variants, partial/error states and aborts. No shared sources or provider manifests
changed. Native route activation, host availability and live cost are unproven;
upstream-dollar hard budgets stay closed without a qualified bound.
