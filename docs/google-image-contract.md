# Google frozen image generation

Frozen consumer: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/google/image-generation-provider.ts` and
`extensions/google/generation-provider-metadata.ts`.
Only `gemini-3.1-flash-image` and `gemini-3-pro-image` are in this slice.
The current unlocalized image guide lists both identities and prefers the
Interactions API in its examples. This codec preserves the frozen consumer's
`generateContent` request; it neither aliases a newer image model nor claims
live backwards compatibility from a synthetic fixture.

## Wire and consumer contract

`worker/google-images.ts` exports `prepareGoogleImage`, `observeGoogleImage`,
`readGoogleImage`, `googleImageModels`, and `googleImageLimits`.

- POST `/v1beta/models/{model}:generateContent`, JSON with one user content,
  one text prompt and at most five inline images; the native body is unchanged.
- `generationConfig.responseModalities` is `["TEXT", "IMAGE"]`. Optional
  `imageConfig` preserves the frozen ten aspect ratios and `1K`/`2K`/`4K` sizes.
  Client size-to-geometry mapping remains client-owned. No invented native
  `count` or `candidateCount` is sent; four images is an output bound, not a
  guarantee that one call returns four results.
- The request is bounded to 20 MiB of JSON and 14 MiB decoded input images.
  PNG/JPEG/WebP/HEIC/HEIF input MIME types are accepted. Raw file IDs, remote
  file URLs, conversation state, grounding tools and cached content are outside
  this frozen request contract.
- Response JSON must reach valid UTF-8 EOF under 24 MiB, with HTTP 200, no
  redirect, no API error and completed STOP candidates. All final images must
  validate before publication; a malformed or incomplete sibling rejects the
  result. Thought images are never exposed as generated assets.
- Up to four PNG/JPEG/WebP outputs share a 16 MiB decoded bound. Native camel
  and snake-case inline fields are accepted separately; ambiguous aliases and
  noncanonical base64 padding fail closed. Missing output MIME inherits the
  frozen client's PNG default. These checks qualify encoding and bounded
  delivery, not full image decoding, pixel dimensions or compressed-file safety.
- `readGoogleImage` requires the caller/deadline AbortSignal and cancels the
  response reader on abort, invalid EOF or a byte-bound failure. It performs
  no fetch and never replays the remote generation POST.

## Ownership and accounting

Runtime owns credentials, admission and the existing body-memory reservation.
Apply the JSON byte limit before parsing, and reserve memory for the request,
response text, parsed JSON and delivered image strings. The observer alone is
not a safe unbounded network reader. Avoid whole-image decoded copies in the
router; the codec validates base64 padding without decoding the full output.

Native usage stays unchanged in `body.usageMetadata`, including modality and
thinking counters. The codec does not turn output count, resolution, bytes or
an absent counter into token usage, a dollar charge or a free result. Existing
text-only Google price cards cannot qualify image generation admission.
Unknown upstream-dollar hard budgets remain closed; `policy_fixed` is distinct.

Existing Google YAML belongs to its source owner. Proposed qualified format is
`google.image_generate` with response `google.image` and `image.generate`.
It shares the native model path with ordinary Gemini generation, so runtime
must select the model/capability-specific codec before dispatch; an overlapping
unrestricted text route must not bypass image admission or response handling.

Client handoff: `providers/_fixtures/google/images.json` preserves the request,
native image result and usage envelope. Use the normalized `images` only after
complete observation. Client download/decoding remains bounded; no URL is fetched
and no credential is forwarded to a result origin. Missing images, blocked
results and interrupted delivery cannot become a successful prefix.

Six dependency-free tests cover deterministic protocol behavior. Existing YAML,
runtime dispatch/accounting, actual frozen client consumption and live model
availability remain integration gates. No deployment or live call occurred.

## Primary evidence

Checked 2026-11-03 using current unlocalized pages:

- [Image generation](https://ai.google.dev/gemini-api/docs/image-generation)
- [Gemini 3 Pro Image model](https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image)
- [GenerateContent API and native usage](https://ai.google.dev/api/generate-content)
- [Deprecation schedules](https://ai.google.dev/gemini-api/docs/deprecations)
