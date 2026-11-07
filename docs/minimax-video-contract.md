# MiniMax frozen video and generated-file protocol

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/minimax/video-generation-provider.ts`. The six finite models are
MiniMax-Hailuo-2.3, MiniMax-Hailuo-2.3-Fast, MiniMax-Hailuo-02,
I2V-01-Director, I2V-01-live and I2V-01. No H3/V2 route or cancellation alias.

## Concrete request and lifecycle

`worker/minimax-video.ts` exports `miniMaxVideoProtocol`,
`miniMaxVideoModels`, `miniMaxVideoOrigins`, `validateMiniMaxMediaId`,
`prepareMiniMaxVideo`, `prepareMiniMaxVideoControl`, `observeMiniMaxVideo`,
`readMiniMaxVideo`, `miniMaxVideoFiles`, `prepareMiniMaxVideoFile`,
`readMiniMaxVideoFileState`, `readMiniMaxVideoFile` and
`parseMiniMaxMediaJson`.

POST `/v1/video_generation` returns `task_id`; authenticated GET
`/v1/query/video_generation?task_id=...` reads the original task. Preparing,
Queueing and Processing are nonterminal; Success and Fail are terminal.
Every read must match the durable original task ID. HTTP/API errors without
qualified terminal evidence cannot invent a failed/free job. Fail with native
safety codes 1026/1027 is accepted only alongside the matching task and Fail
state; authentication errors are not terminal job evidence.

Legacy cancellation is not documented. Reject cancel/delete/result controls;
do not borrow the newer H3 V2 cancellation route. No documented task-retention
bound was found. A 404, missing task or exhausted caller deadline remains an
uncertain observation, not a refund. Common runtime owns bounded polling,
uncertain-create handling without POST replay, original policy/grant binding,
reservation/idempotency/outbox and exactly-once terminal settlement.

Text creation supports frozen Hailuo-2.3/02; Fast and I2V models require an image.
Production permission for the four required-frame models requires separate
GLOBAL V3 administrator attestation; V1/V2 retain their two-model permissions.
See [inline authority](minimax-video-inline-contract.md).
Hailuo 768P supports 6/10 seconds, 1080P only 6. Legacy I2V uses 6 seconds and
720P. No nearest-value rounding or silent resolution rewrite. The frozen client
needs these model/mode combinations; source 11.2 owns that correction. The newer
512P Hailuo-02 option is outside the frozen surface. Image data encoding is
bounded to 8MiB, below the primary limit; actual dimensions, aspect and media
validity remain client/runtime asset qualification. HTTPS references are opaque
upstream inputs, never router downloads or credential destinations.

### Inactive first-frame qualification

`worker/minimax-video-first-frame.ts` exports
`qualifyMiniMaxFirstFrame(value: unknown): MiniMaxFirstFrame`. The explicit result
contains only `bytes: Uint8Array<ArrayBuffer>`, `mimeType`, `width` and `height`.
The byte array has its own exact-sized backing buffer, at most 8MiB; the caller
owns its lifetime and may mutate or transfer it. The function retains no input
or result in module state or closures and never mutates the input.

Only canonical `data:image/png;base64,`, `data:image/jpeg;base64,` and
`data:image/webp;base64,` prefixes qualify. No MIME default, `image/jpg` alias,
URL-safe alphabet, whitespace, percent encoding, extra URI parameters or HTTPS
input. Padding and unused trailing bits must be canonical. The validator scans
the original string, then decodes directly into one exact allocation; it does
not capture/normalize the payload or use whole-input `atob`/`btoa`. Scratch is
bounded independently of payload size. The unchanged portable
`qualifyImageContainer` supplies PNG/JPEG/static-WebP container checks only; its
reuse carries no PixVerse authority.

Dimensions come from the validated native frame headers (including matching
extended-WebP canvas/coded dimensions). The short edge must exceed 300 pixels;
aspect ratio must be within inclusive 2:5 through 5:2. There is no added vendor
pixel maximum; native container limits still apply. PNG framing/CRC/zlib header,
JPEG marker/table/scan framing and WebP chunk checks are structural. They do not
inflate or decode pixels, prove raster integrity or establish playable media.
Tests label dimension-mutated JPEG/WebP fixtures accordingly; the generated
301x301 grayscale PNG also has its complete raster checked with a local inflater.

The pure qualifier supplies no runtime authority or complete admission proof.
The explicit global V2 runtime uses its byte/container validator after one
incremental decode; see [inline input ownership](minimax-video-inline-contract.md).
That contract owns the input digest, original caller and video generation/lineage,
exact model/route/slot, current policy, signals and observable transport.
The pure qualifier supplies no input publication, upload, fetch, retention
permission or owned-asset receipt is supplied. OpenRouter publication consent,
receipts, URLs and namespaces cannot authorize MiniMax input. HTTPS remains
closed; Messages OAuth, speech and TokenPlan Search grants do not authorize video.

## Original-job files

### Explicit current-CN T2V authority

`minimax-current-cn-video` is a separate administrator intent. Its closed
`clawrouter.minimax-video.v4` binding selects exactly `https://api.minimax.cn`,
region `cn`, scalar API-key credentials, and the original Hailuo-2.3/02 models.
It has no input profile. Inline images and the four required-first-frame models
remain denied before credential materialization. V1/V2/V3 constructors, their
destinations and request digests remain unchanged; the legacy CN map still uses
`https://api.minimaxi.com`.

The existing owner computes the complete mutation digest, admits the pool, then
checks current SQL administrator authority before storage. Changing the binding
rotates lineage. Existing jobs fail their original-owner/route digest checks;
they do not migrate. A separately retained legacy owner keeps its binding.
Imported/forged binding fields do not attest authority. Shape validation accepts
only the three exact origin strings; it supplies no credential authority. Create,
poll, metadata and download use the original validated binding origin and current
policy, never a declared-base fallback, redirect or alternate-host retry.

The per-invocation 96 MiB application reservation, exchange profiles, original
deadline and reader/FIRST-cancel/late-response/delivery joins are unchanged.
Synthetic tests cover the two models on native/manifest routes, actual durable
restart and current-CN file bytes, re-attestation/demotion and zero-secret denials.
They do not prove live vendor availability, credential portability, entitlement,
tariffs or native-platform allocation bounds. CN inline/six-model support,
declarations and native-client activation remain separate work.

Only a successful original task supplies a generated `file_id` descriptor.
The primary metadata/download schemas declare int64 IDs. The bounded native
JSON reader preserves task/file integer tokens as decimal strings before
JavaScript can round them; already unsafe parsed numbers are rejected.
IDs must be positive canonical signed-int64 values. String content is inert.

GET `/v1/files/retrieve?file_id=...` must use the original regional credential
and match the exact generated file ID and `purpose:video_generation`.
Metadata can contain a download URL valid for one hour. That lifetime is not
task retention, and the URL is stripped from the qualified file state. No
credentials are forwarded to a response-supplied CDN URL.

The native same-origin GET `/v1/files/retrieve_content?file_id=...` downloads
bytes using the original grant. Its primary schema labels binary output as
application/json; this codec accepts that MIME only with an MP4 ftyp box, and
also permits video/mp4 or octet-stream with the same header check. A JSON error
cannot become video. Complete HTTP 200 bytes, no ranges/redirects, matching
declared lengths, a caller abort signal and at most 16MiB are required. The
minimal ftyp test fixture proves header validation, not a playable full video.
File-processing or delivery failure does not reverse generation settlement.

## Shared owner handshake and cost

Proposed protocol `minimax.video`; create request `minimax.video_create`, read
request `minimax.video_get`, response `minimax.video`; file formats
`minimax.file_get` / `minimax.file` and `minimax.file_download` / `binary`.
These are proposed exact names, not existing registered offers. Source 11.1
must qualify the actual ManagedProtocol/query/file links, using the existing
scoped BackgroundStore and file descriptor machinery. Source 11.5 will attach
its concrete wrapper/factory after that type contract is published. No cast,
replacement job store, global job index or raw task/file-ID route is introduced.

Source 11.3 owns existing MiniMax YAML/schema/catalog; source 11.4/11.1 own
regional native-media product/grant qualification. The selected origin is
explicitly global api.minimax.io, legacy CN api.minimaxi.com, or separately
attested V4 current-CN api.minimax.cn, independent of any Anthropic resource
prefix. Source 11.2 owns actual native consumption and
source 11.6 owns integrated proof. Codecs alone do not activate this route.

The public card lists Hailuo per-video USD prices and separate resource-pack
point deductions. Resource-pack failure/safety non-deduction does not establish
every account's USD refund. No per-job debit, I2V legacy tariff or complete hard
budget bound is inferred. Upstream cost stays unknown and upstream-dollar hard
budgets remain closed; `policy_fixed` is a separate basis.

Fixture: `providers/_fixtures/minimax/video.json`. Seven tests cover finite
model shapes, lossless int64 IDs, state transitions, unsupported controls,
original-file metadata, unsafe URL isolation and complete/cancelled byte reads.
No live call, manifest/snapshot edit or deployment.

Primary evidence checked 2026-11-03:
- [Text creation](https://platform.minimax.io/docs/api-reference/video-generation-t2v)
- [Image creation](https://platform.minimax.io/docs/api-reference/video-generation-i2v)
- [Task status](https://platform.minimax.io/docs/api-reference/video-generation-query)
- [Video file metadata and one-hour link](https://platform.minimax.io/docs/api-reference/video-generation-download)
- [Same-origin file bytes](https://platform.minimax.io/docs/api-reference/file-management-retrieve-content)
- [Public tariffs and resource-pack rules](https://platform.minimax.io/docs/pricing/overview)
