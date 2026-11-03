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
