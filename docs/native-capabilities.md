# Native capability metadata

GET /v1/catalog accepts the same ClawRouter key used for inference. The existing
clawrouter.client-catalog.v1 envelope remains backward compatible. A model may
include optional nativeCapabilities with version clawrouter.native-capabilities.v1.
Older manifests and unknown models omit it. Consumers must ignore unrecognized
versions or malformed facts, not infer support from names, prices or observations.

## Support versus authorization

nativeCapabilities.endpoints[endpointId] describes **declared model support**:

- sources and checkedAt: required provenance for any endpoint facts.
- input: explicit input modalities (text, image, audio, video, json).
  Missing means unknown, not text-only or multimodal.
- contextWindow: full context; contextTokens: native preferred input threshold;
  maxOutputTokens: output bound for this endpoint only. These never replace
  pricing.maxInputTokens, pricing.defaultMaxOutputTokens or admission reservations.
  A zero-output Decisions contract cannot reduce the conversational budget.
- supportedServiceTiers: canonical declared tier IDs, not fast/auto aliases.
  Every declared tier must have an existing qualified rate card.
- inference.chat and optional typed inference.decision: native inference
  contracts. Decision question types, probability forms, limits, reasoning and
  image constraints have a closed schema, not an arbitrary JSON grant.

Existing requestParameters[endpointId] remains the optional authoritative
parameter-support contract (reasoning defaults, sampling, logprobs, tools).
Both endpoint maps are projected only to endpoints visible under this request.
Model facts are never mutated or cached with another caller’s authorization.

An offer may include permittedServiceTiers: declared support intersected with
that offer’s **selected policy and credential** tier allowlists. A blocked known
offer has an empty array; unknown tier support omits the field. This is a policy
permission observation, **not** tier-specific affordability, upstream entitlement,
or dispatch authorization. Existing eligible, affordability, reasonCode, policy
selection, grants and live admission remain authoritative and unchanged.
Consumers must re-authenticate every request; the catalog is private, no-store.

## Initial coverage and validation

Exact OpenClaw native declarations at commit
ffd5377099f76c2578a93da1a3fb8eedf71a2897 establish text/image input,
1,050,000 full context, 272,000 preferred input, and 128,000 output for exactly
openai/gpt-6-astra, openai/gpt-6.1-sol, openai/gpt-6-sol and openai/gpt-6-luna.
Their existing qualified service tier cards establish tier support. openai/tts-1
explicitly declares text input from its existing provider documentation. Other
model facts remain absent until separately evidenced.

No shipped model advertises Decisions: service PR #277 still owns its route and
endpoint-specific pricing work. This optional metadata is orthogonal to that
PR’s ClientCatalogModel.endpointPricing; preserve both when integrating.
Observed inventory PR #260 remains separate: observations do not grant inference
or author native support. This change does not refresh or store observed models.

The compiler rejects malformed versions, unknown fields, absent provenance,
invalid modalities, unsafe bounds, unsupported endpoint references, unqualified
tiers, and Decisions contracts attached to conversational endpoints. All bundled
providers validate before a generated snapshot is emitted. Real Worker HTTP tests
use isolated synthetic credentials and the production authority to verify key
narrowing, revocation, endpoint isolation, unchanged budgets and dispatch rejection
before upstream I/O. No live provider probe is required.

Regenerate the checked-in runtime snapshot with:

    pnpm provider:compile -- --output worker/generated/provider-snapshot.json
