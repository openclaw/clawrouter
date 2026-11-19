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

## Qualified unary response wrapper

`prepareNativeGoogleImage(selection)` in `worker/native-google-images.ts` uses
the existing `ProxySelection.body` and `NativeResponse` ABI. It calls the actual
`prepareGoogleImage` and `observeGoogleImage` exports. The provider must be
`google-gemini`, with one of the two frozen upstream models, a matching model
path selector, `image.generate`, `google.image_generate` to `google.image`, and
the exact non-streaming GenerateContent path. No query, alternate dispatch path,
model passthrough or request tariff is accepted. The original selected credential
and `x-goog-api-key` dispatch remain runtime-owned; the wrapper pins only the
canonical `https://generativelanguage.googleapis.com` origin and selected path.

This initial wrapper is narrower than the pure codec: request and response JSON
are each capped at 8 MiB, and at most four output images share a 4 MiB decoded
limit. Only explicit PNG/JPEG/WebP MIME values with canonical base64 and matching
bounded container signatures qualify, for input and output. HEIC/HEIF input
remains codec-only. Missing output MIME always fails, even for PNG bytes: the
codec's compatibility default is not a production qualification. Signature checks
do not perform full image decoding, validate pixels or establish asset ownership.
No file reference or returned URL is fetched.

The existing response lease charges 64 MiB before dispatch (`nativeResponseLease`
with 32 MiB), alongside the existing request lease. Complete HTTP200 UTF-8 JSON,
valid matching lengths, no redirect/range/non-identity encoding, all STOP
candidates and every output image are required before publication. Thought parts
are removed because the frozen client otherwise consumes every inline image.
Other native response fields, including `usageMetadata`, are preserved. The
wrapper returns null normalized tokens and no tariff or invoice receipt; mixed
image/text/thinking usage is not flattened into text-only billing. Lost responses,
abort, timeout or invalid siblings cannot authorize partial results, replay or
refunds. Cancelling the local reader is not upstream generation cancellation.

Source1 owns selection, auth, original credentials, dispatch, shared image
classification and generic GenerateContent/stream bypass closure. Source3 owns
the declaration and explicit unpriced-image guard, later consuming source1's
single shared classifier. Upstream-dollar hard budgets remain closed separately
from explicit policy_fixed charges. Source6 owns actual Worker/client acceptance;
this leaf module does not activate a provider or change pricing.

Focused wrapper tests embed decoder-verified offline PNG/JPEG/WebP fixtures and
exercise the actual capacity lease, bounded complete delivery, original model and
destination, strict MIME, thought removal and uncertain failures. The earlier
codec fixture qualifies encoding behavior only; its PNG has an IDAT CRC error
and is not reused as valid-image evidence here.
