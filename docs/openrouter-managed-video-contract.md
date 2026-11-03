# Scoped OpenRouter video and content wrappers

This source wrapper consumes the actual `ManagedLifecycleAdapter` and
`ManagedFileAdapter` download-only variant published in
[PR624](https://github.com/openclaw/clawrouter/pull/624), source
`8384d7c515f1a7fc4051bfaaa438de5d3abb3a67`, plus trusted create admission from
[PR637](https://github.com/openclaw/clawrouter/pull/637) at
`008bb4eafac58467d38fa1cc527bcf25d07c589e`. It reuses the frozen native codec from
[PR567](https://github.com/openclaw/clawrouter/pull/567) for the single OpenRouter
model `google/veo-3.1-fast`. Direct-Google retired preview IDs remain distinct.

## Exact exports and routes

- `worker/managed-openrouter-video.ts` exports
  `createOpenRouterVideoManagedAdapter()` and the default registered
  `openRouterVideoManagedAdapter`.
- `worker/managed-openrouter-video-files.ts` exports `openRouterVideoFiles`.
  Its `mode` is `download_only`; it has no metadata reader.
- The owned lifecycle registry matches only `openrouter.video` plus
  `openrouter.video_create`; its `files` field is the same adapter returned by
  `managedFileAdapter("openrouter.video")`.

The selected base must be `https://openrouter.ai/api`. Source3 owns exact schema
and declaration links: create POST `/v1/videos`, lifecycle retrieve GET
`/v1/videos/${video_id}`, and file download GET
`/v1/videos/${video_id}/content` with fixed query `index: "0"`. The lifecycle file
link uses `mode: download_only` and only a download endpoint. Polling remains a
lifecycle operation; there is no metadata, cancel or separate result endpoint.

The descriptor ID is the original succeeded job ID and its MIME is exactly
`video/mp4`. This container is qualified by the current
[official SDK content handler](https://github.com/OpenRouterTeam/typescript-sdk/blob/c8452caf0d92caafd65a64a192b06ed36e7b1830/src/funcs/videoGenerationGetVideoContent.ts),
which sends Accept video/mp4 and requires that content type for HTTP 200.
The old documentation URL currently returns 404; cached documentation is not
the sole evidence. No filename or result URL supplies the MIME.

## Original ownership and bounded delivery

Only a validated original succeeded observation without visibility loss can
derive the descriptor. Native polling/unsigned URLs must match the original
job, but never authorize a fetch. Signed URLs and expiry are removed before
publication. The file wrapper derives only the original relative content path
and fixed index; it rejects metadata actions, foreign origins/API prefixes,
invented ACTIVE state and extra queries. `assertDispatch` synchronously pins
the public origin, exact routes and native Bearer scheme without I/O or mutation.

Source1's existing runtime owns caller/policy/credential/grant/job binding,
durable immutable descriptors, route digests, restart/compaction, expiry and
dispatch. The wrapper does not reinterpret a raw ID or x-clawrouter-job-id as
authority. Runtime cancellation and deadlines bound the source reader.

Content requires complete HTTP 200 MP4, no redirect/range/encoded body, valid
length and nonempty EOF. WebM and generic binary MIME are rejected, not relabeled.
The shared 16 MiB delivery cap and 32 MiB lease remain; smaller supplied bounds
are enforced and larger ones rejected. The existing content codec now accepts
an optional tighter byte limit and uses one bounded buffer, avoiding an
unbounded collection of tiny chunks. Its standalone 64 MiB default does not
grant the wrapper a larger allowance. File failure changes neither original
generation settlement nor its unknown upstream-dollar cost and never replays
create. policy_fixed remains separate from native cost observations.

## Trusted per-request create admission

The native video product temporarily retains output and is not ZDR-compatible.
`prepareOpenRouterVideo` requires trusted `retentionAllowed`. The registered
adapter's ordinary four-argument `prepare` remains denied with
`retention_admission_required`. The factory no longer accepts a policy boolean.
Its `prepareAdmitted(body, headers, pathParams, query, admission)` uses only
`admission.upstreamRetention === "allowed"` from PR637's actual
ManagedCreateAdmission type, after original credential selection. Neither body,
headers, query, router logging nor model/budget facts supply permission.

The hook returns canonical native JSON with empty adapter headers and route
parameters. The already selected original request retains its headers and
credential. The source wrapper's dispatch assertion only validates origin,
path and native Bearer/JSON headers; source1 rechecks policy plus the original
credential/route receipt at the real dispatch boundary. No wrapper-global
permission or mutable cross-request admission state exists. Image/frame/reference
creates remain closed pending original asset ownership, even when retention is
allowed. No live policy or server binding is created by this code.

`providers/_fixtures/openrouter/managed-video.json` and the original video fixture
are synthetic. Source5 tests exercise registered lookup, the actual wrapper and
file methods, exact route/MIME/byte limits, descriptor derivation and lifecycle
outcomes. A separate hosted composition test invokes the actual admission
resolver and registered wrapper, covering missing permission, logging
independence, original grant/route/generation mismatch and expired receipts.
Source3 still owns endpoint/compiler links; source6 must qualify the composed
actual Worker/client original-job/file path after the shared runtime qualifies.
No YAML, common controller/types, snapshot, credentials, deployment
or paid requests are changed by this wrapper slice.
