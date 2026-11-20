# xAI managed video declaration contract

This compiler contract consumes the actual exports and fixtures in
[the native codec contract](xai-video-contract.md). It does not activate provider
YAML, discovery, snapshots or a registry binding. The shared controller/types and
concrete wrapper remain separate source-owned dependencies.

## Exact declaration

YAML and compiled `lifecycle` use the same closed object:

```yaml
lifecycle:
  protocol: xai.video
  retrieve: video_get
```

All three creates can reference the same `video_get` endpoint. The original
stored create endpoint determines ownership; endpoint order is not authority.
Each create declares `media.predict` with POST. No control is a standalone
capability or accepts an unbound upstream job ID.

| Operation | Method and path | Request format | Response format |
| --- | --- | --- | --- |
| Generate | POST `/v1/videos/generations` | `xai.video_generate` | `xai.video` |
| Edit | POST `/v1/videos/edits` | `xai.video_edit` | `xai.video` |
| Extend | POST `/v1/videos/extensions` | `xai.video_extend` | `xai.video` |
| Retrieve | GET `/v1/videos/${request_id}` | `xai.video_get` | `xai.video` |

Retrieve declares exactly `pathParams: [request_id]`, using segment encoding.
No cancellation, separate result, authenticated file link, stream, passthrough,
query override or alternate format is qualified. Unknown `xai.video` formats
and unbound native `/v1/videos` paths are rejected.

The selected origin is `https://api.x.ai`, with one original API-key Bearer
scheme. Grant transport and adapter credential/query/header overrides are
rejected. The codec owns the validated UUIDv4 `x-idempotency-key`; a static or
passthrough manifest header cannot supply it. Its presence does not authorize
an uncertain POST replay. Controls cannot replace the original credential.

The [primary REST reference](https://docs.x.ai/developers/rest-api-reference/inference/videos)
was checked on 2026-11-03 for the three create paths and polling path. The exact
finite codec permits `grok-imagine-video` and `grok-imagine-video-1.5`, preserving
their different modes. Preview and dated spellings are not qualified aliases.
No token card, borrowed Chat price or endpoint tariff is permitted in this slice.
Requested seconds and native duration remain evidence, not a whole-job bound.
Unknown upstream-dollar costs remain closed; explicit policy-fixed accounting
is a separate runtime decision.

## Runtime and registry handoff

Source 11.1 must add `xai.video` to its actual shared types and qualify the existing
durable controller against all three original create routes, including restart
and ambiguous control matches. Source 11.5 binds the published native codec to
that controller and these exact formats. Source 11.3 activates existing xAI YAML
only after binding runtime and real proof exist. No replacement job store or
file-delivery framework is required or introduced here.

The wrapper must retain original caller/job/create route/model/credential,
deadline, reservation, dispatch acknowledgment and settlement/outbox binding.
An ID-less native retrieve response inherits only the validated original job;
present ID/model mismatches fail. Empty HTTP 202 is pending. Expired is
`observationUnavailable: expired_or_unknown`, stops automatic continuation and
does not prove execution failure or a refund. Filtered completion is distinct
from failed generation. Temporary media URLs stay opaque and credential-free;
unbound uploaded files or cross-job references remain closed.

Six compiler/codec cases exercise exact paths, shared control candidates,
unknown costs, native observations and invalid declarations. This is schema and
codec composition proof, not durable lifecycle, live provider or client parity.
