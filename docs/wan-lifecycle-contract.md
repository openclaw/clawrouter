# Wan managed video contract

Frozen consumer: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/alibaba/index.ts`, `extensions/qwen/video-generation-provider.ts`,
and `src/video-generation/dashscope-compatible.ts`. This slice covers only
`wan2.6-t2v`, `wan2.6-i2v`, `wan2.6-r2v`, `wan2.6-r2v-flash`, and
`wan2.7-r2v`. The fixture is synthetic; no live generation or deployment occurred.

## Wire and limits

`worker/managed-wan.ts` exports `wanManagedAdapter`,
`validateWanTaskId`, and `assertWanStandardCredential`.
The adapter follows the existing managed lifecycle method contract; protocol
`dashscope.video` and its observation-loss signal still need shared registration.

- Submit: JSON POST `/api/v1/services/aigc/video-generation/video-synthesis`,
  `X-DashScope-Async: enable`, and the original provider Bearer credential.
- Retrieve: GET `/api/v1/tasks/{task_id}`. IDs are bounded ASCII identifiers,
  1–128 characters. Controls reject extra parameters, query, and identity changes.
- No qualified cancel endpoint or separate result fetch. Never infer cancellation
  support from the native `CANCELED` status.
- Model-specific image/reference fields and size/resolution fields are distinct.
  Reference mode allows 1–5 assets, at most 3 declared videos, and 2–10 seconds;
  text/image mode allows 2–15 seconds. These are the frozen consumer bounds.
  A 2.7 first frame alone is not a subject reference.
- Inline images are bounded to 20 MiB. Remote asset sizes, formats, and durations
  cannot be established from URLs. The adapter never downloads them or equates
  the request byte bound with a duration or monetary bound.
- Native response JSON is bounded to 1 MiB and must reach valid UTF-8 EOF.
  HTTP failures, API error envelopes, unknown statuses, and ID mismatches are
  observation failures, not evidence of free terminal execution.

The canonical provider is `alibaba`, with default origin
`https://dashscope-intl.aliyuncs.com` and server configuration
`MODELSTUDIO_API_KEY`. Hosted Qwen Chat is a separate provider and credential
contract. `DASHSCOPE_API_KEY` and `QWEN_API_KEY` aliases require explicit,
qualified server configuration; they are not automatic fallbacks and must never
be read from client upstream-secret headers.

Standard regional API keys and model regions must match the configured origin.
Coding/Token Plan credentials and origins are rejected. Runtime must invoke
`assertWanStandardCredential(selectedSecret, selectedOrigin)` before **every**
create/control egress, including retries of safe reads. Controls retain the
original regional grant and credential lineage; they cannot select a new region
or credential pool. Shape checks cannot prove region entitlement.

## State, expiry, and settlement

`PENDING` and `RUNNING` remain pending even with partial video URLs.
`SUCCEEDED`, `FAILED`, and `CANCELED` are terminal without requiring output
or usage metrics. A successful status with no output is still terminal execution;
the consumer must separately reject a missing deliverable.

`UNKNOWN` means a missing or expired task observation. The adapter returns
`observationUnavailable: "expired_or_unknown"`, no follow-up, and no fabricated
execution outcome. The shared controller must freeze observation loss once,
stop polling, retain conservative policy-fixed settlement, and return an
actionable unavailable result. Its present contract does not consume that flag:
do not register this adapter until that transition is implemented and tested.
Task IDs and output URLs have a documented 24-hour lifetime.

Use the existing caller/policy/provider/credential job binding, reservation,
idempotency, and outbox. Preserve original credential lineage on every control.
Never replay an uncertain remote POST, including after a crash, missing
submission response, or task expiry. Native response bodies stay transient.
Control URLs are dropped; media URLs remain opaque output data. Authenticated
asset delivery, if later required, needs separate ownership and destination
qualification.

No USD tariff or conservative whole-request cost bound is qualified here.
Reference-video billing can include input and output duration; model, region,
resolution, and media composition matter. Terminal state, cancellation, absent
metrics, and expired observation do not prove a refund or zero cost. Explicit
`policy_fixed` is a separate charge basis; upstream-dollar hard budgets stay
closed without qualified pricing and admission bounds.

## Integration and verification

- Runtime owner: add the protocol discriminator and one durable observation-loss
  transition, then register the adapter using the existing controller. No global
  job index or parallel job framework.
- Manifest owner: `providers/alibaba.provider.yaml` declares only the five frozen
  model IDs, canonical server credential and native create/retrieve pair.
  `lifecycle: { protocol: dashscope.video, retrieve: task }` has no cancel or
  result action. The compiler must bind `dashscope.video_create` to this exact
  native POST and `dashscope.video_get` to GET `/api/v1/tasks/${task_id}`.
  No standalone raw task control capability is advertised.
- Schema/compiler owner: add that bounded protocol contract. The present schema
  does not accept it; all-manifest validation must pass on the integrated head.
  Do not remove lifecycle metadata to work around this activation dependency.
- Client owner: consume `providers/_fixtures/wan/lifecycle.json`; test partial
  output, missing deliverable, expired task, credential isolation, and restart.
- Integration owner: prove actual Worker and frozen client transport, final
  snapshot, idempotency/uncertain-create handling, and one terminal settlement.

The dependency-free adapter tests validate deterministic wire/state behavior.
They do not certify activated routing, live model access, or upstream billing.

## Primary evidence

Checked 2026-11-03:

- [Wan 2.6 text-to-video](https://www.alibabacloud.com/help/en/model-studio/legacy-wan-text-to-video-api-reference)
- [Wan 2.6 reference-to-video](https://www.alibabacloud.com/help/en/model-studio/legacy-wan-reference-to-video-api-reference)
- [Wan 2.7 reference-to-video](https://www.alibabacloud.com/help/en/model-studio/wan-video-to-video-api-reference)
- [Standard regional API keys](https://www.alibabacloud.com/help/en/model-studio/get-api-key)

The existing DashScope origins remain documented as functional. Dedicated
workspace origins do not justify adding models outside the frozen consumer.
