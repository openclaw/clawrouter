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
The registered preparation path now enforces the qualified frozen text contracts:
Kling 2.6, Grok, Wan 2.6 and Hailuo. Native string durations, sound types, resolution
requirements and each model's allowed fields must survive client preparation;
they are not generic defaults. Known image variants remain denied before dispatch
pending original caller/model/credential asset binding. Unknown Market models
receive no model-specific input, asset or tariff qualification from this service
declaration. Actual client/Worker acceptance remains with sources 2/6.

The frozen `bytedance/seedance-1.5-pro` default is explicitly denied for new
creates by the landed registered adapter. Its current primary native contract is
unqualified; a product-page redirect is neither proven retirement nor permission
to alias it to a newer model. Original scoped GETs remain available. See the
[Seedance disposition](kie-seedance-contract.md) and the qualified
[Kling](kie-kling-contract.md), [Grok](kie-grok-contract.md),
[Wan](kie-wan-contract.md) and [Hailuo](kie-hailuo-contract.md) contracts.

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

Source 1 retains any future input-asset ownership/admission changes; source 5
owns exact native model qualification, and source 2 must not silently choose the
unqualified frozen default. Source 6 must compose this declaration with the
landed create guards before snapshots. No new schema/controller or priced model
row is needed for the existing bounded Market transport.
