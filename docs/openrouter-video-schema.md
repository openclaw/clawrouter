# OpenRouter video endpoint links

This schema/compiler contract composes the published OpenRouter video codec with
the download-only file ABI from
[PR624](https://github.com/openclaw/clawrouter/pull/624), source head
`fdeb0ee04badd05806fc4a984a9214e6e46993dd`. It adds no provider declaration,
snapshot, registry entry, retention admission or live route.

The provider remains `openrouter`, with base `https://openrouter.ai/api` and its
original Bearer API key. Existing fixed application attribution headers are
preserved; credential, origin, query and transport overrides are rejected.

| Link | Method and path relative to the existing base | Request format | Response format |
| --- | --- | --- | --- |
| Create | POST `/v1/videos` | `openrouter.video_create` | `openrouter.video` |
| Retrieve | GET `/v1/videos/${video_id}` | `openrouter.video_get` | `openrouter.video` |
| Content | GET `/v1/videos/${video_id}/content`, fixed query `index: "0"` | `openrouter.video_content` | `openrouter.video_content` |

Only create declares capability `media.predict`. Retrieve and content are
distinct linked controls with no standalone capability, passthrough, tariff,
streaming or lifecycle of their own. Both use one strict `video_id` path segment.
The content format names authenticated binary delivery; it is not JSON metadata
or permission to infer a MIME type.

```yaml
lifecycle:
  protocol: openrouter.video
  retrieve: video_get
  files:
    mode: download_only
    download: video_content
```

`files.mode` is a discriminator, never an endpoint name. `metadata`, `cancel`,
`result`, additional file links and arbitrary file settings are rejected. Polling
remains a lifecycle operation; it cannot masquerade as file metadata. The fixed
content path is derived from the original bound job ID, not a returned URL.

Existing Google Omni `{ metadata, download }` links compile unchanged, without
an injected default mode. Explicit `mode: metadata` is also qualified. Omni
cannot select `download_only`, and OpenRouter cannot select `metadata`; the
shared runtime separately requires the declaration and concrete adapter modes
to agree.

The only qualified video model identity is the frozen OpenRouter product
`google/veo-3.1-fast`. This is separate from retired direct-Google preview IDs.
An optional model row must be media-only and unpriced. It cannot inherit the
provider's Chat tariff or become a Chat offer. Duration, resolution and native
cost observations do not establish a whole-request tariff.

## Runtime and source handoff

- Source1 owns the shared download-only runtime, original caller/grant/job
  checks, durable descriptor set, retention/deadline checks and settlement.
  Create remains denied until trusted retention admission is qualified.
- Source5 owns the concrete lifecycle/file wrapper and registry. Use the actual
  `prepareOpenRouterVideo`, `prepareOpenRouterVideoControl`,
  `prepareOpenRouterVideoContent` and complete content reader from
  `worker/openrouter-video.ts`. The existing base already contains `/api`;
  translate that codec prefix once without changing origin or caller paths.
- The wrapper must pin a qualified `video/mp4` descriptor and preserve the
  shared 16 MiB complete-delivery limit. The codec's broader MP4/WebM reader and
  64 MiB ceiling do not widen that contract. Do not guess a MIME, relabel WebM,
  invent metadata or fetch a returned signed/unsigned URL.
- Source3 retains existing YAML/schema ownership. Declaration activation waits
  for the binding runtime and concrete wrapper, not these compiler fixtures.
- Source6 retains serialized snapshot integration and actual original-job/file
  proof. Source2 retains the actual frozen video consumer.

Six focused cases compile the real provider declaration plus synthetic endpoint
links, compose native create/poll/content fixtures, reject invalid links and
credential changes, and preserve existing metadata-first behavior. They do not
prove durable controller or client execution. Expiry remains observation loss;
partial content cannot undo a generation charge or authorize create replay.
Unknown upstream-dollar costs stay closed; explicit policy-fixed accounting
remains a separate basis.
