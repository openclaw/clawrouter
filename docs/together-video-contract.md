# Together video lifecycle contract

E11 is pinned to OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/together/index.ts` and its video generation/provider-policy tests.
The finite models are `Wan-AI/wan2.7-t2v`, `Wan-AI/wan2.7-i2v`, and
`minimax/hailuo-02`. Current [Together create-video documentation](https://docs.together.ai/reference/create-videos)
and [Wan2.7 wire examples](https://docs.together.ai/docs/wan2.7-quickstart)
qualify `/v2/videos`, Bearer auth and the native fields. Later models, additional
reference modes and durations beyond the frozen ten-second ceiling are excluded.

## Exports and wiring

`worker/managed-together.ts` exports `togetherVideoManagedAdapter`,
`prepareTogetherVideoCreate`, `readTogetherVideo`, `togetherVideoOutput`,
`validateTogetherVideoId`, `togetherVideoModels` and `togetherVideoTiming`.

- Proposed protocol `together.video`, create format `together.video_create`.
  Use POST `/v2/videos`; retrieve is GET `/v2/videos/${video_id}`. No result or
  cancellation API is declared by this frozen slice.
- Reuse the existing M02 durable controller. Registry/common protocol activation
  remains with 11.5/11.1, existing Together YAML with 11.3, actual OpenClaw client
  with 11.2, and Worker/client integration proof with 11.6.
- The adapter returns only non-secret Content-Type. Runtime supplies the original
  Together account credential and approved origin for every call. Direct
  DashScope/Wan and MiniMax credentials are different products and cannot substitute.
  The frozen default is `https://api.together.xyz/v2`; current primary examples use
  `api.together.ai`. Pin the selected origin; never follow redirects or switch
  aliases after a failed call. Explicit configured proxy policy remains runtime-owned.
- Caller/job identity must bind principal, credential, model and selected endpoint.
  A raw upstream video ID never authorizes a control call. Response URLs cannot
  choose a polling endpoint. Retrieve rejects mismatched IDs and returned models.

## Request and response semantics

The native client already converts duration to string `seconds`, Wan size to
`resolution`/`ratio`, and Hailuo size to numeric `width`/`height`. The Worker consumes
that wire body; it does not repeat client option normalization. Frozen Wan duration
is 2–10 seconds; Hailuo preserves the source's 1–10 admission range without claiming
that every duration/dimension is supported upstream. Omitted duration stays omitted.
Wan I2V admits one first-frame image; T2V/Hailuo admit no reference inputs here.
No last-frame, video, audio, reference-to-video or callback field is activated.

Local prompt admission uses the Wan 5000-character limit and the generic API
32000-character envelope for Hailuo, without claiming a model-specific Hailuo limit.
Other bounds: inline PNG/JPEG/WebP base64 at most 20 MiB, canonical pad bits,
HTTPS image/output URLs at most 8192 characters, and Hailuo dimensions 1–8192.
These parsing bounds do not certify image dimensions, pixels or native model facts.
A completed job requires a usable output URL in the frozen object-or-array shape.
Selection prefers `video_url`, then `url`, in output order. Output cost hints remain
native payload data and never become a router tariff or token counter.

ID-only create acknowledgments and `in_progress` remain nonterminal. Only explicit
`completed`/`failed` determine execution outcome. Missing/unknown status, HTTP-200
API errors, malformed output, identity mismatch and observation loss cannot become
free failures or authorize create replay. The controller retains uncertainty and
its conservative reservation. No refund is inferred. Credentials, raw prompts,
errors and signed output URLs must not enter durable ownership or diagnostic logs.

JSON observation uses the shared 1 MiB bounded/fatal-UTF-8 reader. Frozen timing is
120 seconds per request, 20 minutes per operation, five-second polling and at most
240 attempts; the executor owns deadlines and cancellation. Completed output URLs
are opaque download data. The client downloader must enforce public-network/DNS/
redirect guards, media byte limits and binary content checks, and must never send
the Together API key to the output asset origin. The adapter performs no download.

## Proof

`providers/_fixtures/together/video.json` and `worker/test/managed-together.test.mjs`
exercise three model payloads, first-frame restrictions, original task identity,
completion/failure distinctions, output selection, control URL removal, fragmented
UTF-8 and bounded cancellation. No live paid job, entitlement check, deployment,
registry activation or end-to-end parity claim is made by these codec tests.
