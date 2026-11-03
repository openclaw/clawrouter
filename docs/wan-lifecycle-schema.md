# Wan lifecycle schema contract

This is the schema/compiler dependency for the existing Alibaba source route in
[PR483](https://github.com/openclaw/clawrouter/pull/483). It activates no provider
manifest, registry entry or snapshot. Canonical provider `alibaba` remains
separate from Qwen hosted Chat and its credential pool.

`dashscope.video` links the native create endpoint to one named retrieve endpoint:

```yaml
lifecycle:
  protocol: dashscope.video
  retrieve: task
```

The only qualified create is POST
`/api/v1/services/aigc/video-generation/video-synthesis`, using request format
`dashscope.video_create` and response format `dashscope.video`. Retrieve is GET
`/api/v1/tasks/${task_id}`, with request format `dashscope.video_get` and the same
response format. The task ID must be one path segment. There is no separate
result or cancellation action. Controls cannot advertise independent public
capabilities, escape the create binding, accept extra query, or override the
original credential through endpoint headers/auth. Create may declare only the
native async and JSON content headers. The adapter validates the actual body,
identity and response envelope against `providers/_fixtures/wan/lifecycle.json`.

The runtime owner must extend the shared protocol union and bind the existing
registry/controller before activation. [PR487](https://github.com/openclaw/clawrouter/pull/487)
provides `ManagedObservation.observationUnavailable` and the durable transition.
Wan `UNKNOWN` means `expired_or_unknown`, with `terminal: null`: freeze once,
stop polls, preserve uncertainty and the conservative policy-fixed receipt.
It does not prove execution failure, cancellation, refund or zero upstream cost.
Only actual shared-controller tests can certify durable behavior; the compiler
fixture tests prove the source contract and adapter correspondence.

Before every create/control egress, call `assertWanStandardCredential` with the
selected original secret and regional origin. Preserve original grant lineage,
authorization, fresh admission, reservation/dispatch acknowledgement, idempotency
and outbox. Never replay uncertain creates. Unknown whole-request upstream cost
stays denied under dollar hard budgets; explicit `policy_fixed` is distinct.
No live credentials, calls or deployment are introduced here.

PixVerse remains a separate subsequent contract: the runtime must consume fresh
non-secret control headers and bind uploads to the original caller/policy/
provider/region/credential. The common loss transition must consume `deleted`
without inventing a native terminal failure. This Wan schema change does not
activate PixVerse or authorize unbound image IDs.
