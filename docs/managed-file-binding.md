# Managed output files and original routes

Output descriptors live on the existing scoped BackgroundStore job. Each entry
contains only a native `id` and `mimeType`: no URL, credential, prompt, output
bytes or provider response body. At most 64 distinct descriptors fit one job.
IDs are 1–128 ASCII letters, digits, underscores or hyphens. Media types are
bounded lowercase video/audio/image MIME types.

`ManagedObservation.files` is an internal runtime-qualified list, never a copy of
caller input or an unchecked native field. A succeeded observation commits its
terminal receipt, closed continuation association and descriptors in the same
transaction before response delivery. Storage failure rolls all three back;
a lost acknowledgement never replays creation. The private scoped
`managed_files` action can append qualified descriptors to an already succeeded
job, including after financial compaction. It requires the original upstream ID,
rejects observation loss and the original retention deadline, and cannot change
settlement. This action is not a public raw-file registration API.

An empty list from a later inline response preserves the initial URI descriptor.
Repeating the same ID/media type is idempotent; changing its type or exceeding
capacity fails without partial insertion. Metadata processing failure is a file
delivery outcome, not a new generation verdict or evidence for a refund.

## Source-owned wrapper contract

The shared types in `worker/managed-lifecycle-types.ts` define
`ManagedFileDescriptor`, `ManagedFileState`, `ManagedFilePaths` and
`ManagedFileAdapter`. The media registry owner supplies a new focused module,
`worker/managed-file-adapters.ts`, exporting:

```ts
managedFileAdapter(protocol: string): ManagedFileAdapter | undefined
```

The factory does not activate a route by itself. Unknown protocols return
undefined. Wrapper methods perform no network I/O, credential selection, refresh,
durable writes, logging or price calculation:

- `describe(observation, selectedBaseUrl)` returns canonical descriptors extracted
  only from that original job's succeeded output. For Omni, use `googleOmniVideos`
  and validate each file through `prepareGoogleOmniFileControl("metadata", ...)`
  against the original selected base before taking the basename of `files/<id>`.
  Ignore inline media. Reject response-supplied credentials and other origins.
- `identify(action, pathParams, query)` validates the exact native file selector.
  It parses identity; it does not authorize possession of the ID.
- `control(action, endpoint, file, selectedBaseUrl, state?)` validates the exact
  source-owned schema link and returns a relative path/query with bounded
  non-secret headers. Download requires a matching ACTIVE metadata observation.
  Preserve the origin/prefix translation in the Omni schema contract; no absolute
  URL can choose a different origin.
- `readState(response, file)` returns the matching descriptor ID, one of
  processing/active/failed, and a bounded native state body.
- `readFile(response, file, maxBytes)` uses the source byte reader, rejecting
  redirects, partial, empty, truncated or oversized delivery. The runtime owns
  cancellation and one deadline across metadata/content reads.
- `rewrite(body, paths)` replaces only validated output file URIs with trusted
  relative router metadata/download paths. Never derive paths from a caller Host.

The next dispatcher slice owns the `x-clawrouter-job-id` header on native file
requests. The header is a selector only: resolve the authenticated caller's scoped
original job/create/model/credential binding, then require the requested file in
that job's descriptors. File metadata and download cannot use an arbitrary raw ID,
current credential-pool fallback, redirect destination or unqualified origin.
No native file endpoint, upload route, image reference or Google offer is activated
by this state foundation. The original credential dispatcher and actual Worker /
consumer tests remain required before registry/snapshot activation.

## Shared native control paths

Several create routes can share a native retrieve/cancel path. The runtime
collects compatible declarations, requires agreement on protocol/action/native
identity, and lets the scoped continuation owner select its original create
endpoint. It preserves that endpoint's path parameters and route digest through
compaction. Declaration order is not authority. Explicit manifest endpoints remain
restricted to their declared create links; ambiguous protocol/action/ordinary
route collisions fail before upstream egress.

This supports the common prerequisite for PixVerse text/image retrieval. Its
image/upload formats remain closed until original-credential upload binding is
implemented. Existing header and observation-loss contracts are unchanged.
