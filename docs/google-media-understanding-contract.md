# Frozen Gemini inline media understanding

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/google/media-understanding-provider.ts` and generation metadata.
This slice implements its concrete `transcribeGeminiAudio` and
`describeGeminiVideo` HTTP contracts, both defaulting to `gemini-3-flash-preview`.
Image understanding uses the common model consumer and is not reimplemented
as a provider-specific audio/video function here.

## Wire and limits

`worker/google-media-understanding.ts` exports `prepareGoogleUnderstanding`,
`observeGoogleUnderstanding`, `readGoogleUnderstanding`, and
`googleUnderstandingModel`.

- POST `/v1beta/models/gemini-3-flash-preview:generateContent`, one user
  content with a text part followed by one snake-case
  `inline_data: { mime_type, data }` part. Audio and video modes have separate
  MIME allowlists; neither can turn into image/music generation or tool use.
- Preserve the exact prompt and media bytes. The consumer chooses the default
  transcription/description prompt and MIME. The router does not normalize
  the request into a different model, camel-case SDK shorthand or Interactions.
- Request JSON is bounded to 24 MiB and decoded inline media to 16 MiB.
  Canonical standard base64 and text up to 65,536 code units are required.
  MIME/encoding validation is not container parsing or measured duration.
- File uploads, raw file IDs, URI references, cached content, tools, generation
  parameters and stateful histories are outside the frozen inline request.
  No provider credential is forwarded to a media URL and no URL is fetched.
- Require HTTP 200 JSON, complete valid UTF-8 EOF under 1 MiB, one STOP
  candidate and final nonempty text. Blocks, API errors, partial/continuation
  outcomes and mixed generated-media/tool output reject the result. Thought
  text is excluded; trimmed final text parts are joined as in the frozen client.
- The reader requires the existing caller/deadline AbortSignal and cancels on
  abort, invalid EOF or a byte-bound failure. It never replays a remote POST.

Native `body.usageMetadata` remains unchanged. Decoded bytes, MIME, inferred
frame rate or absent counters are not token/duration/price evidence. Approximate
vendor token-per-second guidance cannot provide a whole-request upper bound
without qualified duration and model/media settings. Unknown upstream-dollar
hard budgets remain closed; explicit `policy_fixed` charging is distinct.

## Integration handoff

Existing Google YAML belongs to its source owner. Proposed request formats are
`google.audio_understanding` and `google.video_understanding`, native response
`google.generate_content`, with audio transcription and video-understanding
capabilities. The native path overlaps ordinary inference: select the
model/capability and modality-specific accounting before dispatch, not after a
generic text route has admitted the request. Runtime owns credentials, request
memory reservations, revocation and delivery cancellation.

Client handoff: `providers/_fixtures/google/media-understanding.json` contains
the exact frozen request fields and result envelope. Binary samples prove byte
preservation only; they are not playable-media or duration proof. The client
still owns real audio/video loading, MIME detection and public result shaping.
The common image-understanding consumer requires its own existing-model proof;
this pair does not claim that coverage or a live API badge.

Five focused tests cover wire identity, modality and file boundaries, canonical
base64, complete text/usage and abort/EOF. Shared runtime and actual client
acceptance remain owner integrations. Current primary examples emphasize
Interactions; frozen GenerateContent compatibility requires actual consumer
qualification. No deployment, live request or future-model expansion occurred.

## Complete-response wrapper

`worker/native-google-media-understanding.ts` exports
`prepareNativeGoogleMediaUnderstanding(selection): NativeResponse | undefined`.
It uses the existing JSON body ABI, provider `google-gemini`, the exact frozen
upstream model and model path. Request formats remain
`google.audio_understanding` and `google.video_understanding`; response format
is `google.generate_content`. The leaf binds capabilities `audio.transcription`
and `video.understanding`, respectively, for the declaration owner's integration.
No query, passthrough, alias, stream, tool or request tariff is accepted.

The first wrapper qualification is intentionally narrower than the pure codec's
MIME allowlist: explicit `audio/wav` PCM16, mono/stereo at 8–96 kHz, and explicit
`video/mp4` with bounded MP4 boxes, a video track and nonempty media data. These
are container checks, not a complete media decoder or duration/billing proof.
Other MIME families remain codec-only until their byte contract is qualified.
Missing MIME, mislabeled bytes, unbounded/extended MP4 boxes, raw file IDs and
URI references are rejected before dispatch. The native prompt, snake-case body
and canonical media bytes remain unchanged.

Requests are bounded to 8 MiB JSON and 4 MiB decoded inline media. The 16 MiB
response lease charges 32 MiB before dispatch; an 8 MiB input reservation plus
that lease charges 48 MiB of the existing 96 MiB pool. Responses require complete
HTTP 200 UTF-8 JSON through EOF under 1 MiB, with exact lengths and no redirect,
range or encoded body. Every final part must be valid text and the candidate
must STOP before output. Thought parts are removed; native final text and usage
remain unchanged. No returned URL is fetched or upload authority created.

Normalized usage remains `{ tokens: null, outcome: "success" }` with no tariff
or invoice receipt. Invalid, missing or canceled output cannot prove free work,
publish a partial result or authorize POST replay. Source1 owns original grants,
model/capability-aware shared-path selection, request capacity, auth, admission,
dispatch and settlement. Source3 owns declaration/pricing, Source2 actual native
consumption and Source6 composed proof. Unknown upstream-dollar budgets remain
closed independently of `policy_fixed` charging.

Ten wrapper cases use an offline decoder-qualified H.264 MP4 and PCM16 WAV,
including malformed containers, exact bounds, native usage, thought exclusion,
capacity and canceled/incomplete delivery. The older four-byte codec samples
remain unchanged and are never treated as playable-media evidence. No live
provider call or route activation is claimed.

## Primary evidence

Checked 2026-11-03 using current unlocalized documentation:

- [Audio understanding and MIME types](https://ai.google.dev/gemini-api/docs/audio)
- [Video understanding and MIME types](https://ai.google.dev/gemini-api/docs/video-understanding)
- [GenerateContent API](https://ai.google.dev/api/generate-content)
- [Deprecation schedules](https://ai.google.dev/gemini-api/docs/deprecations)
