# OpenRouter native video contract

Frozen consumer: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/openrouter/video-generation-provider.ts`, `video-http.ts`, and
`video-model-catalog.ts`. The finite model is `google/veo-3.1-fast`.
This OpenRouter product is distinct from the retired direct-Google Veo preview
IDs. No model discovery expansion, alias substitution, live request or paid proof
is part of these synthetic fixtures.

Primary evidence, checked 2026-11-03:

- [Native video API](https://openrouter.ai/docs/guides/overview/multimodal/video-generation):
  submit, poll, authenticated content, frame/reference precedence, temporary
  retention, cancellation/expiry observations and native usage fields.
- [Frozen model product](https://openrouter.ai/google/veo-3.1-fast): text/image
  input, first/last frames, audio and 4/6/8-second clips. Listed prices vary with
  resolution and audio; they are not a universal upper bound.

## Exports and wire contract

`worker/openrouter-video.ts` exports `openRouterVideoProtocol`,
`openRouterVideoModels`, `validateOpenRouterVideoId`, `prepareOpenRouterVideo`,
`prepareOpenRouterVideoControl`, `observeOpenRouterVideo`, `readOpenRouterVideo`,
`prepareOpenRouterVideoContent`, `readOpenRouterVideoContent`, and
`rewriteOpenRouterVideo`. Fixture: `providers/_fixtures/openrouter/video.json`.

| Operation | Native route | Boundary |
| --- | --- | --- |
| Create | `POST /api/v1/videos` | JSON; native 202 or 200; no replay after uncertain dispatch |
| Retrieve | `GET /api/v1/videos/{id}` | 200 JSON; original scoped ID; no response-directed fetch |
| Content | `GET /api/v1/videos/{id}/content?index=0` | Completed original job only; original selected credential; complete MP4/WebM |
| Cancel | None qualified | Unsupported, even though native `cancelled` is observable |

The codec preserves explicit duration, geometry, audio and safe-integer seed.
Frozen limits are 4/6/8 seconds, 720p/1080p and 16:9/9:16; conflicting size and
geometry fail. These limits are not price bounds. The 32,768 UTF-16 prompt limit,
24 MiB request limit, four-image/16 MiB aggregate decoded-image limit and 8 MiB
per-image limit are local admission bounds. Input HTTPS URLs are opaque upstream
data, never router fetch destinations. Upload IDs are closed.

First/last frame roles are unique. Reference inputs require a separate trusted
model-capability qualification; a frozen generic capability does not prove this
model accepts every reference mode. If both arrays are qualified and supplied,
frames determine the mode, matching the native API. Arbitrary callback URLs and
provider passthrough remain closed until owned receiver and parameter contracts
exist. No secret/header fields are accepted in the body.

`OpenRouterVideoPolicy` comes from trusted runtime admission. `retentionAllowed`
must be true; request or account ZDR enforcement cannot be bypassed. The provider
retains output temporarily and publishes no fixed retention guarantee here.

## Observation, delivery and accounting

IDs are bounded ASCII tokens; subsequent observations must match the original ID
and selected model when present. Early failures may have null model/generation
IDs. Active native/frozen states are pending, in_progress, queued, processing and
running. Completed maps to succeeded; failed and cancelled map to their execution
outcomes. Expired maps to `observationUnavailable: expired_or_unknown`, stops
automatic continuation, and does not invent an execution failure or refund.
Unknown states, error/success contradictions and premature outputs fail closed.

JSON is bounded to 1 MiB with complete UTF-8/HTTP checks and abort cancellation.
The shared `readNativeJson` is reused after validating the actual create status.
The 202 internal reader view does not change native status or invoke I/O.

Native polling/content URLs must match this original public OpenRouter job and
index. They never confer authority. Content control is derived from the bound job,
not a URL, and requires a succeeded observation. Original account, caller, model,
policy and credential binding remain runtime responsibilities. Custom origins
need a separate qualified origin/API-prefix grant before this slice can use them.
Public rewriting requires local retrieve/result paths and removes signed URLs and
their expiry. Signed URLs are bearer capabilities and must not enter logs or
durable receipts. The transient native body is not durable state.

Content reads accept only complete HTTP 200 MP4/WebM, at most 64 MiB, without
redirects, ranges, truncated length or silent aborts. Byte preservation does not
prove playable media. Download failure or retention loss does not undo generation.
No partial output is represented as a completed file.

Native `usage.cost` and `is_byok` are independent optional observations. The codec
always leaves `upstreamCostMicros` unknown; missing metrics, cancellation, failed
delivery and expiry never imply zero. Source3 must qualify audio/resolution/BYOK
tariffs and a preflight bound. Unknown upstream-dollar hard budgets stay closed;
`policy_fixed` remains a distinct charging basis.

## Integration ownership

- Source1: extend the actual managed protocol/types and original-job content
  dispatch using existing BackgroundStore, reservation, idempotency and outbox.
  No global job index, raw-ID pass-through or uncertain-create POST replay.
  Preserve restart/deadline/error behavior and one frozen terminal settlement.
  The frozen consumer polls every five seconds, at most 120 times within ten
  minutes, with 60-second HTTP bounds; runtime may apply tighter admitted limits.
- Source3: existing OpenRouter YAML and schema. Proposed protocol
  `openrouter.video`; proposed formats `openrouter.video_create`,
  `openrouter.video_get`, `openrouter.video_content`. These names are a handshake,
  not an already-exported shared type or activated endpoint.
- Source5: attach the concrete registry/file wrapper only after actual shared
  types and endpoint links qualify. Do not cast into `ManagedProtocol`.
- Source2: actual frozen video consumer, scoped job/content controls, byte output
  and error/expiry behavior. No direct upstream credential or arbitrary URL fallback.
- Source6: deterministic Worker/client proof and serialized snapshot integration.

This PR supplies executable codec and wire/result tests. It does not claim
provider-route activation, full E12 parity, cancellation support or live cost proof.
