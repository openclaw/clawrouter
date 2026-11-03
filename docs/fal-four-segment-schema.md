# fal four-segment lifecycle declaration

The existing `fal.queue` discriminator and `fal.queue_submit` format now accept
one additional explicit create template:

```yaml
queue_four:
  path: /${owner}/${app}/${variant}/${subvariant}
  pathParams: [owner, app, variant, subvariant]
  requestFormat: fal.queue_submit
  responseFormat: fal.queue_submission
  lifecycle:
    protocol: fal.queue
    retrieve: queue_status
    result: queue_result
    cancel: queue_cancel
```

The origin is exactly `https://queue.fal.run`; the original API key uses
`Authorization: Key ${secret}`. The new template forbids credential, origin,
query and path-style overrides. No fifth segment or relative-path parameter is
added. Concrete product/segment admission remains in the registered adapter:
the landed prompt-video wrapper accepts the fourth segment only for
`fal-ai/heygen/v2/video-agent`, with the actual native prompt-only body.

Three- and four-segment creates may share their existing status/result/cancel
endpoint IDs, only for the same `fal.queue` protocol and action. Their native
control roots remain:

- GET `/${owner}/${app}/requests/${request_id}/status`
- GET `/${owner}/${app}/requests/${request_id}`
- PUT `/${owner}/${app}/requests/${request_id}/cancel`

No control becomes a separate capability. Current shared runtime collects the
candidate create routes and resolves the original stored caller/job owner;
endpoint order cannot select a different create route. Its existing
`managed-control-owner.test.mjs` covers shared-link ownership through restart
and compaction. Compiler fixtures additionally consume actual fal wrappers and
wire fixtures, preserving original create parameters when constructing controls.
Those fixtures alone do not certify the complete fal durable lifecycle or client.

## Seedance handoff

The six exact products in `falSeedanceModels` and
`providers/_fixtures/fal/seedance.json` use three segments for standard modes and
four for Fast modes. All use the exact owner/app pair
`bytedance/seedance-2.0`. Codec/template fixtures preserve these IDs and the
original `/bytedance/seedance-2.0/requests/<bound id>` control root. No new
format, model alias, deeper template or pricing card is needed for this shape.

Shared runtime and the concrete wrapper still need to qualify that exact dotted
app segment: the current fal segment and public-path validators reject it.
Reject exact `.` and `..` segments, separators, percent encodings and arbitrary
extra path components; do not infer a general dotted-product allowlist. Source5
owns wrapper admission against the six published native body contracts. Remote
inputs remain closed until original-credential asset binding exists. Inline
fixture bytes do not prove media decoding or duration.

This change edits no provider manifest, shared path validator, controller,
registry or snapshot. Provider activation requires the corresponding runtime,
actual route/consumer tests and serialized snapshot integration. Unknown
whole-job costs stay denied under upstream-dollar hard budgets; output-second
starting prices, requested duration and inference time do not establish a bound.
Explicit `policy_fixed` remains separately labeled.

Primary evidence and actual codec contracts:

- [HeyGen native schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/heygen/v2/video-agent), checked 2026-11-03.
- [Prompt video contract](fal-prompt-video-contract.md).
- [Seedance contract and six primary schemas](fal-seedance-contract.md).
