# Gemini Omni replacement video contract

The three Veo 3.1 Gemini API previews retired on 2026-10-22. Their codec fixtures
are historical proof only: no live offers, calls or silent aliases. This bounded
replacement admits only `gemini-omni-1.1-flash` through native Interactions.
It does not use OpenAI `/v1/videos`, Enterprise/Vertex credentials or provisioning.

Primary contracts checked 2026-11-03:

- [Retirement and replacement](https://aistudio.google.com/docs/veo)
- [Omni requests, native REST results and file delivery](https://aistudio.google.com/docs/omni)
- [Interaction resource, formats and usage](https://aistudio.google.com/api-reference/interactions-api)
- [Create](https://aistudio.google.com/api-reference/interactions-api/create-interaction),
  [get](https://aistudio.google.com/api-reference/interactions-api/get-interaction-by-id)
  and [background cancel](https://aistudio.google.com/api-reference/interactions-api/cancel-interaction-by-id)

## Create and controls

`worker/managed-google-omni.ts` exports `googleOmniVideoManagedAdapter`,
`prepareGoogleOmniVideoCreate`, `readGoogleOmniVideo`,
`validateGoogleOmniInteractionId`, `googleOmniUsage`, `googleOmniVideoModel`
and `GoogleOmniObservation`. Proposed protocol `google.omni_video` and format
`google.omni_video_create` use the M02 interface; registration is separate.

Native paths relative to the selected `/v1beta` API base:

| Action | Method | Path | Original-job prerequisite |
| --- | --- | --- | --- |
| Create | POST | `/interactions` | fresh admission, selected model and credential |
| Retrieve | GET | `/interactions/${interaction_id}` | stored interaction |
| Cancel | POST | `/interactions/${interaction_id}/cancel` | background interaction |

Create accepts native `input` text or content blocks for text plus one inline
image/video, restoring the audited text/image/video scope. Image PNG/JPEG/WebP
and video MP4/WebM bytes use `type`, `data`, `mime_type`. Explicit task selectors
are text-to-video, image-to-video, edit or extend with matching reference inputs.
No guessed Veo request conversion: `instances`, `durationSeconds` and SDK
`imageBytes`/`videoBytes` are not Interactions fields.

`response_format` uses `type:video`, documented delivery inline/uri, aspect
16:9/9:16 and resolution 360p/720p/1080p/4k. The API reference types `duration` as
a string without a numeric range/unit contract; preserve a bounded native string
without inferring seconds, Veo rounding or a price. Actual model acceptance remains
upstream. Local limits are 32,000 characters per text block, eight input blocks,
one media reference, and 16MiB decoded reference bytes; these are parser bounds.

Unary generation explicitly defaults `background:false`, `store:false`,
`stream:false` as recommended by the Omni guide. Callers can explicitly select
`background:true,store:true` for managed polling/cancellation. Original flags are
persisted as non-secret `pathParams` by M02. The codec never enables upstream
storage implicitly. Native streaming is not admitted by this unary/managed slice.
Raw `previous_interaction_id`, uploaded-file URIs, arbitrary histories, tools,
audio inputs and extra generation settings are rejected. Stateful/uploaded
references require a separately wired M02 same-owner, same-credential binding
before admission; accepting an arbitrary native ID is not an ownership check.

## Observation and accounting

Reads require the original interaction ID, model and `object:interaction`.
`in_progress` is pending; completed with a valid native video is succeeded;
`failed` and `cancelled` are distinct authoritative outcomes. A cancel response
can still be in progress or already completed: it does not imply a refund.
`requires_action`, `requires_continuation` and `incomplete` return
`observationUnavailable:"expired_or_unknown"`, no terminal verdict and no
follow-up. The exact native status is retained in `nativeStatus`; the shared
unknown-outcome category does not assert expiry. The controller
must stop automatic polling/continuation, retain conservative settlement and
never issue a new paid create to resolve uncertainty.

Video assets come only from native `steps` of type `model_output`, not user input,
thoughts or the SDK's convenience `output_video` getter. Initial creation with URI
delivery can return a file URI while a later GET returns inline base64. Both
shapes remain valid without requiring the URI to survive a GET. HTTP errors,
malformed JSON, invalid UTF-8, mismatched identities and missing output do not
produce terminal success. The JSON envelope is locally bounded to 16MiB.

`googleOmniUsage` preserves input/output totals, optional total/cache/thought
counters and text/image/audio/video/document modality breakdowns. Missing counters
stay unknown; malformed, contradictory or unsafe integers return null. These
counters do not establish a video tariff or measured duration. The shared runtime
owns accounting units, price evidence, policy-fixed settlement and outbox dedupe.
Native prompts, steps, thoughts and media remain transient and must not enter
job receipts or routine logs.

## Authenticated file delivery

`worker/provider-google-omni-files.ts` exports `googleOmniVideos`,
`googleOmniApiBase`, `prepareGoogleOmniFileControl`, `readGoogleOmniFileState`,
`readGoogleOmniFile`, `googleOmniFileName`, `googleOmniEnvelopeBytes` and
`googleOmniFilePollIntervalMs`. Bounded ProtoJSON/byte readers reuse pure utilities
from the historical Google codec; no retired model or endpoint is dispatched.

`prepareGoogleOmniFileControl("metadata", asset, trustedBase)` constructs
GET `/files/<id>`. File `PROCESSING` is pending; `ACTIVE` permits download;
`FAILED` is file-processing failure, not proof that generation was free or failed.
The documented poll interval is five seconds; runtime owns a single bounded
deadline, attempt budget and abort signal. Unknown/deleted state is uncertainty.

`prepareGoogleOmniFileControl("download", asset, trustedBase, observedState)`
requires the matching ACTIVE observation and constructs
GET `/files/<id>:download?alt=media`. Both descriptors are credential-free,
`redirect:error`, `credential:original_job`. Only the selected origin and API
prefix qualify; response-supplied keys, credentials, cross-origin URLs and
traversal are rejected. Metadata `uri`/`downloadUri` never redirect the target.
The runtime adds the original job's selected Google credential at dispatch.

Before either request, M02 must authorize the original caller/job/model/credential
version and bind the file descriptor from that interaction's output. Do not expose
a raw native file ID as an unscoped route. Preserve the initial URI descriptor when
needed; a later inline GET is not evidence that the file belongs to a different
job. The actual consumer enforces uploaded-video duration constraints and decodes
media; the dispatcher owns public-network DNS/SSRF checks, redirects, deadline,
revocation and configured byte caps. The file reader rejects partial HTTP 206,
redirects, empty/truncated/oversize bodies and JSON/HTML disguised as media. It
checks transport and MIME family, not video container authenticity.

## Activation ownership

Existing M02 owns job/credential/reservation/idempotency/outbox state; do not build
a second framework. Shared runtime must consume the original flags and
`observationUnavailable`, then add job-scoped file-state/download delivery.
The existing Google manifest/compiler owner qualifies protocol/model facts;
the media registry owner registers the adapter. The actual client owner converts
inputs, handles native steps and files and enforces media constraints. Integration
owns serialized snapshots and actual Worker plus consumer proof, including
cross-job denial, credential rotation, cancellation races and exactly-once
settlement. Live proof requires a qualified named consumer and entitlement.
This codec PR does not activate a live offer or claim end-to-end parity.
