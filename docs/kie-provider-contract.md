# Kie Market provider declaration

`providers/kie.provider.yaml` connects the existing `kie.jobs` registry adapter to
POST `/api/v1/jobs/createTask` and scoped GET `/api/v1/jobs/recordInfo?taskId=…` at
`https://api.kie.ai`. Server configuration is `KIE_API_KEY` with native Bearer auth.
The frozen OpenClaw source is `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/kie/video-generation-provider.ts` and `index.ts`.

The [native create contract](https://docs.kie.ai/market/kling/text-to-video) and
[task details contract](https://docs.kie.ai/market/common/get-task-detail) qualify
the wire. Only `media.predict` is advertised. Native `model` and `input` remain
unchanged; the selected model is retained as requestedVersion. The shared runtime
owns caller/policy/original credential binding, admission, uncertain creation,
recovery and exactly-once settlement. Task IDs never independently authorize reads.
The wrapper rejects a present returned model that differs from the original model;
absent metadata does not invent an execution failure or free generation.

No cancellation API, separate result API, callback receiver, asset upload or
model-specific priced catalog is exposed. This is the Market job service contract,
not a cross-product alias or a claim that all Kie products share the same wire.
The frozen consumer owns model-specific duration, reference and audio constraints;
actual client/Worker acceptance remains with sources 2/6.

HTTP 200 must still carry numeric code 200. API auth/foreign-task errors are not
terminal execution observations. Partial output stays pending until a qualified
success/fail state. Native credits and timing remain transient observations, not
dollars. Explicit policy_fixed admission is a router charge; unknown upstream cost
stays closed under upstream-dollar hard budgets. Output URLs are opaque, with no
credential forwarding. Disconnect does not cancel remote work or authorize replay.
See the [existing lifecycle contract](kie-market-jobs.md) and sanitized
[wire fixtures](../providers/_fixtures/kie/jobs.json).

`worker/test/kie-manifest.test.mjs` compiles the actual YAML and resolves the actual
registry and public scoped paths. `worker/test/kie-managed-model.test.mjs` covers
native model identity and missing billing metadata. All manifests and repository
gates require hosted native CI. Source 6 owns snapshot regeneration and strict
smoke qualification before landing. No live paid call, deployment, secret change
or end-to-end parity claim is included.
