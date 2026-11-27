# Managed download-only files

Some native jobs provide authenticated content without a separate file metadata
endpoint. Their polling endpoint remains a lifecycle control. It must not be
registered as file metadata.

## Exact shared fields

`ManagedProtocol` includes `openrouter.video`. Registration remains source-owned;
adding the type does not enable a route. The YAML and compiled lifecycle shape
for download-only files is:

```yaml
lifecycle:
  protocol: openrouter.video
  retrieve: video_get
  files:
    mode: download_only
    download: video_content
```

The linked content endpoint is GET-only, has no capability or lifecycle of its
own, and is distinct from the create and lifecycle control endpoints. There is
no `metadata` link. Existing `{ metadata, download }` declarations retain their
metadata-before-download behavior; their route digest representation is
unchanged. Credential qualification follows only the metadata/download endpoint
links; the mode discriminator is not an endpoint or an allowlist exemption.

`ManagedFileAdapter` is a discriminated union. The new variant has
`mode: "download_only"` and no `readState`. All other existing methods keep their
signatures: `describe`, `identify`, `control`, `readFile` and `rewrite`.
`control("download", endpoint, descriptor, selectedBaseUrl, undefined)` receives
no invented ACTIVE state. `ManagedFilePaths` always has `id` and `download`;
`metadata` is absent in this mode. Declaration and adapter modes must agree.

## Authority and delivery

The runtime first resolves the authenticated caller's original job and create
route. The job must be bound, succeeded, within its retention window and free
of observation loss. The requested file must be in its durable immutable
descriptor set. `x-clawrouter-job-id` selects that scoped job; it is not authority.
The original grant/environment identity, route digest, current caller policy and
connection remain checked at dispatch. Mode and endpoint changes invalidate the
original route. The dispatch deadline cannot extend past job retention.

Only the wrapper's derived relative content path is used, under the original
approved origin/API prefix. Returned polling, signed or unsigned URLs never
authorize a fetch. The existing descriptor still pins one qualified `mimeType`;
this slice does not guess a container or persist bearer URLs. Shared delivery
retains its 30-second deadline, 16 MiB complete-output envelope, 32 MiB capacity
lease, manual redirects, MIME check and cancellation. Source readers must
validate complete EOF, status, ranges and lengths. Content failure, expiry or a
partial read leaves generation's frozen settlement unchanged and never replays
create.

## OpenRouter wrapper handoff

Against the existing `https://openrouter.ai/api` base, the proposed native links
are create `/v1/videos`, lifecycle GET `/v1/videos/${video_id}`, and file GET
`/v1/videos/${video_id}/content` with fixed `index: "0"`. Source3 owns the exact
schema and declaration. Source5 owns the concrete lifecycle/file wrapper and
registry. A succeeded original observation may derive a descriptor whose ID is
that same original job ID; the file wrapper derives the authenticated content
path from it. There is no cancel or manufactured metadata endpoint.

The new mode does not grant retained-output permission, remote-input ownership,
reference-image capability, a tariff or live account eligibility. Those admission
facts must remain qualified separately. The content codec's larger 64 MiB cap
does not override the runtime's tighter 16 MiB bound. A wrapper must use a
qualified fixed container for the existing descriptor contract; variable
container admission needs an explicit bounded descriptor extension, not a MIME
guess or relabeled bytes.

Tests exercise real Worker dispatch, original caller/grant binding, SQLite
restart/compaction, no metadata fetch, no new reservation or settlement, denied
ownership changes, and conservative content failures. The synthetic adapter seam
does not register OpenRouter or replace its source-owned wrapper.
