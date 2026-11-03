# Frozen Google Veo video contract

Scope: `openclaw/openclaw@31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/google/video-generation-provider.ts`, `generation-provider-metadata.ts`
and the pinned `@google/genai@2.31.0` MLDev converters. Only
`veo-3.1-fast-generate-preview`, `veo-3.1-generate-preview` and
`veo-3.1-lite-generate-preview` are admitted. No Vertex translation or newer model
substitution. The [Google video notice](https://aistudio.google.com/docs/video)
says these previews shut down on October 22, 2026. Deterministic protocol proof
is possible; live availability of these exact IDs needs separate qualification.

## Native create and operation reads

`worker/managed-google-veo.ts` exports `googleVeoManagedAdapter`,
`prepareGoogleVeoCreate`, `readGoogleVeo`, `validateGoogleVeoOperation`,
`googleVeoModel`, `googleVeoModels`, `googleVeoTiming` and
`googleVeoOperationMaxBytes`. Proposed protocol `google.veo`, request format
`google.veo_create` reuse the existing M02 adapter interface; shared registration
is not part of this change.

- Create: POST `/models/${model}:predictLongRunning`, relative to the selected
  Google API base. The model is a bare frozen ID in path parameters, not JSON.
- Retrieve: GET `/${operation_name}`. Preserve the complete opaque resource
  `operations/<id>` or `models/<frozen-model>/operations/<id>`. This is a validated
  multi-segment resource, not an arbitrary URL. The model and exact original
  operation identity must match. No result/cancel endpoint is advertised.
- Native JSON contains one `instances` entry and optional `parameters`.
  Text, one inline image, or one inline video; never mixed references. Image uses
  `bytesBase64Encoded`/`mimeType`; video uses `encodedVideo`/`encoding`, matching
  the [pinned SDK converters](https://github.com/googleapis/js-genai/blob/v2.31.0/src/converters/_models_converters.ts).
  SDK `imageBytes`/`videoBytes` objects are not REST bodies.
- Parameters admit duration 4/6/8, aspect 16:9/9:16 and resolution 720p/1080p.
  The actual client owns frozen duration rounding, size conversion, prefix
  normalization and binary-to-base64 conversion. No audio/count/seed/reference
  extension or duration/price inference. The 32,000-character prompt and 16MiB
  decoded reference caps are local parser limits, not vendor capability claims.
- A name-only create ACK and `done:false` stay pending. `done:true` plus a valid
  Google RPC error is failed; valid generated output is succeeded. Missing or
  malformed output, filtered-empty results, identity drift, HTTP errors and
  interrupted observation cannot manufacture terminal success, refunds or a new
  create attempt. Generation success is separate from file-delivery success.
- Both SDK `response.generatedVideos` and native
  `response.generateVideoResponse.generatedSamples` are accepted. JSON is bounded
  to the frozen 16MiB and decoded with fatal UTF-8. Error messages are content-free.
  Native response bodies are transient, never durable job metadata or logs.

The executor owns the original operation deadline, 180s per-request ceiling,
10s polling interval and 120-attempt limit. Retry only qualified idempotent reads;
never replay an uncertain POST. A helper does not create a new deadline at each
poll, assert cancellation, or settle absent usage at zero. Upstream cost remains
unknown unless independently priced; `policy_fixed` is a separate M02 basis.

## Authenticated output files

`worker/provider-google-veo-files.ts` exports `googleVeoAssets`,
`canonicalGoogleVeoBytes`, `googleVeoApiBase`, `prepareGoogleVeoFileDownload` and
`readGoogleVeoFile`. Inline ProtoJSON permits either base64 alphabet, optional
padding and ASCII whitespace, but rejects mixed alphabets, invalid pad bits and
oversize bytes before decoding. SDK `videoBytes`/`mimeType` and REST
`encodedVideo`/`encoding` are distinct accepted shapes. File handles accept
`files/<id>` or direct HTTPS file download URIs. No file listing or arbitrary
remote-file fetch is introduced.

`prepareGoogleVeoFileDownload(asset, trustedApiBase)` returns a credential-free
GET descriptor with `redirect:error`, `alt=media` and `credential:original_job`.
The runtime must resolve the original admitted M02 job and authorize its caller,
model, endpoint, policy and credential version **before** passing trusted server
configuration. Only the exact selected origin and API prefix can receive that
credential. A configured proxy grant cannot fall back to the Google origin;
a Google grant cannot migrate to a proxy. This deliberately tightens the frozen
client's origin union. Response-supplied keys, credentials, traversal, arbitrary
paths, query extensions and cross-origin targets are rejected. The descriptor
never contains the key; the runtime adds the original `x-goog-api-key` at dispatch
(or a separately qualified identity header), not a key from the result URL.
OAuth/Vertex credentials are not interchangeable with this API-key contract.

The downloader must enforce DNS/public-network SSRF policy, forbid redirects,
propagate the original abort/deadline and cap bytes at configured media limits.
`readGoogleVeoFile` checks status, redirect state, byte count, truncation and media
family, rejecting JSON/HTML/image bodies. Missing/generic binary content types
retain the frozen endpoint contract; this does not claim container decoding or
video authenticity. Raw authenticated upstream file URLs must not become public
job controls. Materialize only through the original job's scoped result path.

## Activation handoffs and proof

- Runtime owner: M02 durable ownership, model admission, trusted endpoint/credential
  binding, exact operation-name routing, file-result ownership, deadline/abort,
  revocation, egress and conservative settlement. No credential acquisition here.
- Manifest/compiler owner: existing Google YAML, finite model facts, proposed
  format/protocol and validated multi-segment operation path contract.
- Media registry owner: register the focused adapter after common schema/runtime
  admission is ready; all other Google adapters retain their existing owner.
- Actual client owner: frozen SDK/body conversion, original operation/file control,
  bounded output decoding and no second generation after an empty/error response.
- Integration owner: serialized snapshots and actual Worker + OpenClaw consumer
  proof including credential rotation, cross-job denial and exactly-once settlement.

Synthetic fixtures exercise the three native request shapes, LRO transitions,
identity/error cases, ProtoJSON, selected-origin downloads and byte-bounded reads.
They do not prove live entitlement or activate a route. Shared manifests, compiler,
registry, runtime and client are intentionally separate owner dependencies.
