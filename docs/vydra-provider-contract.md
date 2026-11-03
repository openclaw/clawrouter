# Vydra Jobs provider declaration

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

## Required frozen Models API continuation

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/vydra/shared.ts`, submits image/video requests to
`/api/v1/models/{model}`, then polls Jobs. Its speech provider submits
`/api/v1/models/elevenlabs/tts` and consumes an audio URL. These are different
create payloads and response contracts from the canonical workflow Jobs API.
This declaration does not silently translate them or claim image/video/speech
consumer parity. The focused Models codec and `vydraModelVideoAdapter` are now
landed separately; they are not registered by this Jobs declaration. Typed create
links, registry composition and actual consumer acceptance remain required.
Studio run idempotency, uploads, listings,
account APIs and later model generations are not added by this slice.

The [Models contract](vydra-models-contract.md) qualifies `veo3` and `kling`
video creates with HTTP202 `jobId`, unlike Jobs' workflow-body HTTP201 response.
Only original-job GET is qualified for Models; Jobs' DELETE support must not be
inherited. The frozen Kling client reuses one image URL as its motion video;
the codec rejects that mismatch. Source 2 must supply the distinct qualified
inputs, and source 1 must bind assets to the original caller/credential before
activation. Arbitrary Jobs input has no model-specific asset qualification here.
Unary Models image/speech can return a URL without a job ID and must not be forced
into this lifecycle with a fabricated ID.

Source 3 owns Models format/endpoint qualification; source 1 owns original-create
resolution for the shared GET path and asset admission; source 5 owns subsequent
registry/declaration composition. This manifest remains Jobs-only, with no Models
defaults, replacement model, cross-product credential alias or inferred dollar rate.

`worker/test/vydra-manifest.test.mjs` compiles the actual YAML and resolves actual
registry/control paths. `worker/test/vydra-managed-workflow.test.mjs` checks
workflow identity and cancel/result uncertainty against the existing sanitized
[wire fixture](../providers/_fixtures/vydra/jobs.json). The existing
[Jobs contract](vydra-jobs.md) retains protocol bounds and retention limits.
Source 6 owns committed snapshots, strict smoke and Worker/client proof before
landing. No paid call, deployment, secret or commercial change is included.
