# Google Omni lifecycle declaration

The closed `google.omni_video` contract qualifies the native codec from
[PR494](https://github.com/openclaw/clawrouter/pull/494). It does not activate
Google video discovery, a bundled model, a registry adapter or a live route.
The retired Veo previews remain historical only. The replacement is the exact
`gemini-omni-1.1-flash` identity, not a Veo alias.

## Endpoint links

The create endpoint uses this lifecycle object. All four linked endpoints must
be distinct and must not advertise independent capabilities.

```yaml
lifecycle:
  protocol: google.omni_video
  retrieve: interaction
  cancel: cancel
  files:
    metadata: file
    download: download
```

| Action | Method and path | Request format | Response format |
| --- | --- | --- | --- |
| Create | POST `/v1beta/interactions` | `google.omni_video_create` | `google.omni_video` |
| Retrieve | GET `/v1beta/interactions/${interaction_id}` | `google.omni_video_get` | `google.omni_video` |
| Cancel | POST `/v1beta/interactions/${interaction_id}/cancel` | `google.omni_video_cancel` | `google.omni_video` |
| File metadata | GET `/v1beta/files/${file_id}` | `google.omni_video_file_metadata` | `google.omni_video_file` |
| Download | GET `/v1beta/files/${file_id}:download` | `google.omni_video_file_download` | `google.omni_video_bytes` |

Only download declares `query: {alt: media}`. Controls cannot override headers,
credentials or query parameters. Create may declare JSON content type only.
Native streaming, passthrough models, relative-path selectors, orphan formats
and endpoint auth overrides are rejected. The existing Google origin-only base
and GenerateContent endpoints remain unchanged.

## Runtime handoff

The focused codec uses paths relative to a selected `/v1beta` base. The registry
wrapper must validate these exact declaration paths, remove `/v1beta` when
calling `googleOmniVideoManagedAdapter.control`, then restore it in the returned
relative path. File descriptors instead use
`googleOmniApiBase(originalJobSelectedBase)` and
`prepareGoogleOmniFileControl`; response URLs never choose the base. Compiler
fixtures demonstrate this required translation; they do not supply a runtime
wrapper or prove dispatch.

The shared runtime owner must add the closed protocol and optional typed
`files: {metadata: string; download: string}` links to its compiled lifecycle
contract, then bind file delivery to the existing scoped durable job. Neither
`interaction_id` nor `file_id` authorizes a caller. Authorize the original caller,
job, model, selected origin and credential version before controls or downloads.
Persist the original `background`/`store` flags and the bound output descriptor;
retrieve requires storage, cancel requires background mode. A later inline result
does not invalidate the original bound URI descriptor. Raw previous-interaction
and uploaded-file references stay rejected.

`PROCESSING` requires bounded polling; only matching `ACTIVE` permits download.
File `FAILED` is a delivery failure, not proof of free generation. Continuation,
action-required and incomplete interactions preserve native status and the shared
`expired_or_unknown` observation-loss category. Stop continuation and paid replay;
retain uncertainty, conservative settlement and outbox deduplication. Native
modality/token counters do not qualify a video dollar tariff.

Activation requires the registry wrapper, shared job/file delivery, deadlines,
credential/revocation checks, cross-job denial, cancellation-race and exactly-once
settlement tests, followed by actual Worker/client proof and serialized snapshot
integration. The compiler alone cannot enforce durable ownership or byte delivery.
See [the source wire contract](google-omni-video-contract.md) for bounded readers,
file-origin rules and primary evidence.
