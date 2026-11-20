# Vydra Jobs and Models provider declaration

`providers/vydra.provider.yaml` declares the canonical `vydra.jobs` protocol at
`https://www.vydra.ai`: POST `/api/v1/jobs`, original-job GET and DELETE
`/api/v1/jobs/${job_id}`. `VYDRA_API_KEY` is server-side Bearer configuration.
It uses the existing managed registry and scoped BackgroundStore controller; no
new job store, raw-ID read capability or credential selection path is introduced.

The [native Jobs contract](https://www.vydra.ai/docs/jobs) documents HTTP-201
creation, including immediate completion that still needs original-job retrieval.
Only the observed GET terminal state settles execution. A DELETE/refund
acknowledgement remains nonterminal and requires observation. Present `workflow`
or `workflowSlug` must match the original requested workflow; missing metadata
is not invented execution failure or free generation. Provider `_links` never
select a destination. Output URLs remain opaque and transient.

The [billing contract](https://www.vydra.ai/docs/billing) distinguishes integer
ledger units from customer credits and account-specific dollars. No conversion
rate or uniform model tariff is published here. Explicit policy_fixed charges
remain separate from unknown upstream cost. Hard upstream-dollar budgets must
stay closed without a qualified whole-job bound. A failed read, expired ownership,
disconnect or cancellation acknowledgement does not authorize POST replay or a
second settlement. The shared runtime retains original caller/policy/credential
lineage, uncertainty, deadlines, restart recovery and the existing outbox.

## Finite Models video continuation

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/vydra/shared.ts`, submits image/video requests to
`/api/v1/models/{model}`, then polls Jobs. Its speech provider submits
`/api/v1/models/elevenlabs/tts` and consumes an audio URL. These are different
create payloads and response contracts from the canonical workflow Jobs API.
The declaration now activates only the finite video create format for `veo3` and
`kling`, with the original-format `vydraModelVideoAdapter` and GET-only controls.
It does not translate unary image/speech into workflow Jobs. Configured native
video acceptance is bound separately to the exact candidate and SDK workflow.
Studio run idempotency, uploads, listings,
account APIs and later model generations are not added by this slice.

The [Models contract](vydra-models-contract.md) qualifies `veo3` and `kling`
video creates with HTTP202 `jobId`, unlike Jobs' workflow-body HTTP201 response.
Only original-job GET is qualified for Models; Jobs' DELETE support must not be
inherited. The frozen Kling client reuses one image URL as its motion video;
the codec rejects that mismatch, including canonically equal URLs. Tested
OpenClaw revision `542958f2c02754de72361bfbdc016a724a4572f1` supplies separate
image and motion references through its registered video runtime. Arbitrary
Jobs input has no model-specific asset qualification here.
Unary Models image/speech can return a URL without a job ID and must not be forced
into this lifecycle with a fabricated ID.

The compiler, registry and original-create resolution bind the shared GET path
to the job that actually created it. Models cannot acquire Jobs DELETE authority.
There are no new defaults, replacement models, cross-product credential aliases
or inferred dollar rates. Pending asset URLs are withheld until terminal success.

`worker/test/vydra-manifest.test.mjs` compiles the actual YAML and resolves actual
registry/control paths. `worker/test/vydra-managed-workflow.test.mjs` checks
workflow identity and cancel/result uncertainty against the existing sanitized
[wire fixture](../providers/_fixtures/vydra/jobs.json). The existing
[Jobs contract](vydra-jobs.md) retains protocol bounds and retention limits.
The dedicated Models consumer additionally requires the actual registered SDK,
Worker and SQLite proof before qualification. No paid call, deployment, secret
or commercial change is included.
