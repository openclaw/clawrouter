# Frozen xAI managed video

Frozen source: `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/xai/video-generation-provider.ts` and capability metadata.
Qualified catalog identities are `grok-imagine-video` and `grok-imagine-video-1.5`.
Preserve the caller's identity. The frozen metadata also recognizes a 1.5 preview
and dated spelling; current evidence does not qualify those as live offers.
Do not invent a rewrite or claim they were removed. New 1.5-lite/keyframe/audio
reference modes are outside this bounded slice.

## Native evidence

Primary pages checked 2026-11-03:
[generation](https://docs.x.ai/developers/model-capabilities/video/generation),
[editing](https://docs.x.ai/developers/model-capabilities/video/editing),
[extension](https://docs.x.ai/developers/model-capabilities/video/extension),
[REST](https://docs.x.ai/developers/rest-api-reference/inference/videos), and
[official TypeScript SDK](https://github.com/xai-org/xai-sdk-ts/blob/main/src/resources/videos.ts).
SDK video blob `bb8eb0e4bb2a2396a9ddded0eeda2fc8088886d3` accepts empty HTTP 202
as pending; types blob `74805549ee8daea905bc1701dbed374aec281094` recognizes
pending/done/failed/expired. Timeouts do not stop the remote job.

Submit generation/edit/extension with POST `/v1/videos/generations`, `/edits`,
or `/extensions`. Poll GET `/v1/videos/{request_id}`. Native responses can omit
the polled ID. Filtered done results have respect_moderation=false and no URL.
Result URLs are temporary; exact URL TTL and job retention remain unqualified.
Editing inherits a source up to 8.7 seconds. Extension accepts 2–15-second sources
and requests 2–10 new seconds; output duration includes the original video.

## Codec and binding handoff

`worker/xai-video.ts` exports `xaiVideoProtocol`, `xaiVideoModels`,
`validateXaiVideoId`, `prepareXaiVideo`, `prepareXaiVideoControl`,
`observeXaiVideo` and `readXaiVideo`. Fixture:
`providers/_fixtures/xai/video.json`.

Proposed protocol `xai.video`; request formats `xai.video_generate`,
`xai.video_edit`, `xai.video_extend` and `xai.video_get`; response `xai.video`.
Only retrieve is supported. No cancellation or separate result endpoint is
qualified. Source 11.1 owns the actual shared protocol/controller; source 11.3
owns existing xAI YAML/schema. Source 11.5 will attach its concrete registry
wrapper against those published types and endpoint links. Source 11.2 owns the
actual video consumer and source 11.6 owns integrated proof. This codec alone
does not activate the provider.

Controls must resolve the original caller/job/create-route/model/credential in
the existing BackgroundStore. An absent response ID inherits only that validated
request context; a present mismatching ID/model fails. The three create paths
share a poll route, so selecting an arbitrary matching endpoint is unsafe.
Reuse scoped reservation/idempotency/outbox and the frozen terminal settlement.
Do not create a second job store or expose raw upstream ID authority.

Keep the frozen first-frame-only 1.5 mode, seven-reference classic mode, native
aspect/resolution constraints and integer durations. Input image data and remote
URLs are bounded and opaque. Video source duration/codec requires actual client
or runtime media qualification; this parser cannot inspect a remote file. Upload
IDs and cross-job file references stay closed until asset ownership exists.

The frozen client supplies a UUIDv4 x-idempotency-key. Preparation can preserve
it; this is not evidence of an upstream replay guarantee. The common runtime
must bind its original value and never automatically replay uncertain POSTs.
Changing the key or opening a fresh route is not recovery for uncertain create.

Execution done, filtered delivery, failed execution and expired observation are
distinct. Expired sets observationUnavailable:expired_or_unknown and stops
continuation; it does not invent failure or refund. A local canceled read only
aborts response consumption. Output URLs never receive provider credentials or
become router fetch authority. The actual consumer must qualify safe, bounded,
credential-free downloads separately.

Native usage and duration are preserved as evidence, with upstreamCostMicros=null.
No output-second price is inferred from requested seconds, extension output
length, moderation, failure, expiry or a public starting rate. Unknown whole-job
cost stays closed under hard upstream-dollar budgets; policy_fixed is separate.
No live calls, production deployment, commercial changes or price activation.
