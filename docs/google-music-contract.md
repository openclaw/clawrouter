# Frozen Lyria unary music

Frozen consumer: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/google/music-generation-provider.ts` and its generation metadata.
This slice contains `lyria-3-clip-preview` and `lyria-3-pro-preview` only.
Current unlocalized deprecation documentation lists no announced shutdown date
for either. The current music guide emphasizes Interactions and a newer model;
neither is silently substituted for the frozen client's native SDK request.

## Concrete wire

`worker/google-music.ts` exports `prepareGoogleMusic`, `observeGoogleMusic`,
`readGoogleMusic`, and `googleMusicModels`.

- POST `/v1beta/models/{model}:generateContent`. Input is the SDK's serialized
  native JSON: one user content with one prompt and up to ten inline images,
  `generationConfig.responseModalities: ["AUDIO", "TEXT"]`.
- Prompt, lyrics and instrumental instructions remain exactly client-composed.
  No router prompt rewriting, conversation replay, tools, URL/file references,
  audio inputs or inferred format field is added.
- Native request JSON is bounded to 20 MiB, images to 14 MiB decoded in total,
  and text to 65,536 UTF-16 code units. Runtime applies byte and memory admission
  before parsing. PNG/JPEG/WebP/HEIC/HEIF inline image MIME types qualify.
- One completed STOP candidate must contain exactly one final track. Lyrics
  remain separate text. Thought content, if present, is excluded. Missing,
  partial, blocked, duplicate or malformed audio rejects the entire result.
- Clip accepts MP3; Pro accepts MP3 or WAV. The actual MIME determines delivery.
  The frozen client's `format` option is validated locally but not serialized
  into its SDK generation request; do not claim it forces native WAV output.
- Standard or URL-safe base64 is normalized with canonical padding checks.
  Output is bounded to 16 MiB decoded under 24 MiB complete UTF-8 JSON. Encoding
  validation does not certify playable MP3/WAV framing, duration or sample rate.
  The fixture's short binary sample is explicitly not playback evidence.

`readGoogleMusic` consumes HTTP 200 JSON to EOF under the supplied deadline/caller
AbortSignal. It cancels the reader on abort or malformed/oversized delivery and
never fetches media URLs. Runtime retains its existing memory reservation for
body strings and parsed output. No full decoded audio copy is allocated here.

## Accounting and consumer handoff

Native usage stays in `body.usageMetadata`. Bytes, lyrics, missing metrics or a
terminal response cannot establish seconds, billable tokens, USD cost or a free
request. Model-specific music price and whole-request admission remain
unqualified; upstream-dollar hard budgets stay closed. Explicit `policy_fixed`
charging remains a separate basis.

The frozen client retries an unblocked text-only result once. This codec returns
an error and never authorizes a remote POST replay. A new intentional request
requires fresh admission; timeout, abort and unknown create results must not be
replayed automatically. No successful track prefix escapes a later error.

Existing Google manifest and common runtime stay source-owned. Proposed format
is `google.music_generate`, response `google.music`, capability `audio.generate`.
The shared model path needs model/capability classification so generic text
inference cannot bypass music bounds/accounting. Original server credentials,
actual native client transport and result delivery remain owner integrations.

`providers/_fixtures/google/music.json` is the sanitized request/result handoff.
Six focused tests qualify deterministic model/input/output/abort behavior.
They do not certify activated runtime routes, live compatibility or playback.
No deployment or live music generation occurred.

## Primary evidence

Checked 2026-11-03 using current unlocalized pages:

- [Music generation](https://ai.google.dev/gemini-api/docs/music-generation)
- [Lyria deprecation schedules](https://ai.google.dev/gemini-api/docs/deprecations)
- [Native GenerateContent API](https://ai.google.dev/api/generate-content)

## Qualified unary response wrapper

`prepareNativeGoogleMusic(selection)` in `worker/native-google-music.ts` uses
the existing JSON `ProxySelection.body` and `NativeResponse`. It calls the actual
`prepareGoogleMusic` and `observeGoogleMusic` exports. Only the two frozen models,
their matching model path selector, canonical Google origin, `audio.generate`
and `google.music_generate` to `google.music` qualify. Queries, alternate paths,
streaming, model passthrough and request tariffs are rejected. Original selected
credentials and `x-goog-api-key` remain runtime-owned.

The first wrapper caps request and response JSON at 8 MiB and the one final track
at 4 MiB decoded. Its existing response lease charges 64 MiB before dispatch,
alongside the original request lease. Inline image inputs require canonical
base64, explicit PNG/JPEG/WebP MIME and matching bounded container signatures;
HEIC/HEIF remain codec-only. No URL/file references, asset authority or prompt,
lyrics, instrumental or output-format rewrite is introduced.

Audio needs an explicit MIME, canonical bytes and complete container framing.
Both models accept `audio/mpeg` with complete MPEG Layer III frames and bounded
optional ID3 tags. Pro additionally accepts explicit `audio/wav` only for a
consistent RIFF/WAVE PCM16 container with one nonempty aligned data chunk.
This validates framing, not decoded samples, duration or a promised native
output format. Missing MIME never inherits the codec's MP3 compatibility default.
The current music guide's newer-model WAV examples are not proof of what the
frozen Pro endpoint will return; the wrapper does not request or force WAV.

Complete HTTP200 UTF-8 EOF, matching lengths, no redirect/range/non-identity
encoding, one STOP candidate and exactly one valid final track are required
before delivery. Thought parts are removed; native final lyrics, audio bytes and
`usageMetadata` are preserved. Tokens remain null, with no tariff, invoice or
duration conversion. Partial, lost, timed-out, aborted or text-only output cannot
authorize replay, partial success, upstream cancellation or refunds. A canceled
local reader does not establish stopped generation.

Source1 owns common selection, original grants, dispatch and capability-aware
resolution of the shared GenerateContent path, including generic/stream bypass
closure. Source3 owns the native declaration and music-cost guard; text pricing
cannot establish an image-conditioned/audio/thinking bill. Hard upstream-dollar
budgets remain closed independently of explicit policy_fixed. Source2 owns the
actual client, including removal of its automatic text-only retry, and source6
owns composed Worker/consumer proof. This module alone does not activate a route.

Focused wrapper tests use real offline MP3 frames and synthetic valid PCM16 WAV
containers instead of the original encoding-only sample. They verify the actual
capacity lease, explicit MIME, original model/destination, input ownership
boundaries, whole-result validation, byte limits and interrupted delivery.
