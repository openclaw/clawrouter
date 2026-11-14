# Provider contracts, access products, and the shared model catalogue

Status: proposed design, not implemented. Review baseline: ClawRouter `6fceb88`,
catalog `8680cc8`, OpenClaw `b3aa84d0d79`, inspected 2026-11-04. These are local
revisions, not a claim about current remote heads. Examples below are proposed
contracts, not valid v1 manifests or promises of upstream access.

## 1. Decision

Make a provider a versioned integration package. Separate its identity from its
access products, credentials, operations, models, and commercial terms. Compile
those declarations into immutable execution offers. Use the OpenClaw model
catalogue for shared model facts, and keep execution authority in ClawRouter.

Do **not** create one enum containing `api`, `rest`, `oauth`, and `subscription`.
Those describe different axes. OAuth can authorize a metered API. A subscription
can use OAuth and HTTP JSON. A gateway can expose another vendor's models. None
of these relationships makes the objects interchangeable.

The useful unit for routing is an **offer**: one model or service operation,
through one provider product and protocol binding, with explicit capabilities,
pricing treatment, and credential requirements. An offer becomes executable only
after connection, grant, policy, quota, and budget checks.

Keep a modular TypeScript application and the existing Worker deployment. This
design needs clearer ownership, not microservices or a runtime plugin loader.

## 2. What exists, and where it bends

The current implementation already has strong foundations:

- `providers/*.provider.yaml` declares endpoints, models, auth, billing, quota,
  and exceptional grant transports.
- `scripts/compile-providers.mjs` validates and compiles the declarations.
- `worker/provider-auth.ts` checks operation/grant compatibility, including
  HTTP versus WebSocket and lifecycle requirements.
- `worker/discovery.ts` builds credential-scoped offers. A public model list is
  not treated as proof that a caller can execute a request.
- Credential ownership, admission projections, reservations, and settlement
  already have dedicated modules. Preserve those boundaries and their tests.

The pressure is in the domain model:

| Current seam | Evidence in the inspected source | Consequence |
| --- | --- | --- |
| `class` plus `service.kind` | `worker/types.ts`, provider manifests | Wire family and service category look like provider identity. |
| `UpstreamGrant.kind` | `api_key`, `oauth`, `subscription` in `worker/types.ts` | Authentication and commercial access share one discriminator. |
| Grant transport overrides | OpenAI and Anthropic manifests | A distinct product's endpoint, auth, and lifecycle hide inside credential-kind overrides. |
| One provider connection key | `ProviderConnection.providerId`; `worker/provider-connections.ts` | No explicit identity for two projects/accounts of the same provider. |
| Model metadata beside execution rules | Provider `models.entries` | The catalogue and router can drift on names, limits, reasoning, and prices. |
| Model type ownership (resolved) | `shared/provider-model.ts` | Compiled models and client DTOs share model facts without making the client response the execution contract. |
| Provider logic in discovery | `supportsHostedSearch` in `worker/discovery.ts` | Discovery must know implementation-specific qualifications. |
| Central logo registry | `scripts/sync-provider-icons.mjs` | Adding a provider also requires editing an unrelated branding map. |

This is not a proposal to replace tested protocol or accounting code wholesale.
It moves facts to their owners and puts a compiler between declarations and the
hot path.

### Auth declaration ownership

`scripts/provider-auth.mjs` compiles auth schemes, OAuth authorization and
refresh metadata, and grant transport declarations. It checks grant transport
references and maintenance prerequisites after manifest schema validation. The
provider compiler retains validation order and uses the same compiled scheme
identifiers. This build-time module does not resolve credentials, refresh tokens,
execute transports, or establish account eligibility; those runtime owners stay
unchanged.

### Quota declaration ownership

`scripts/provider-quota.mjs` normalizes quota response headers and account probe
metadata, including fallback windows, units, metric scales, and fixed limits.
It checks declared data sources and header names after manifest schema
validation. The provider compiler preserves the existing validation order.
This module does not run probes, refresh credentials, or decide budget admission;
runtime polling and accounting retain their current owners.

### Model discovery declaration ownership

`scripts/provider-catalogs.mjs` owns the registered discovery request/response
pairs and the existing native and public catalog qualification checks. It
preserves provider origins, credential binding constraints, GET-only routes,
and the qualified opaque model-ID retrieval variants. The provider compiler
calls these checks in the same order after validating the manifest schema.
This is upstream model discovery validation; it does not import the shared
model catalogue or authorize a new endpoint, protocol, or provider.

### Managed lifecycle declaration ownership

`scripts/provider-lifecycles.mjs` owns the existing managed protocol registry
and create/control/file endpoint qualification. Its schema-validated inputs
retain provider, origin, credential, method, codec, and path constraints. The
provider compiler calls it in the same validation order. This module does not
create jobs, poll, cancel, download files, or settle usage; runtime job ownership
and execution stay with their existing owners.

### Endpoint declaration ownership

`scripts/provider-endpoints.mjs` compiles endpoint metadata and checks endpoint
transport, pricing, model passthrough, and path constraints. The provider
compiler validates the manifest schema first and supplies its canonical literal
upstream-path pattern; the endpoint module does not maintain a second pattern.
Normalization and semantic validation retain their existing order and defaults.
This build-time boundary does not change runtime routing or authorize additional
provider protocols, credentials, or endpoints.

### Provider qualification ownership

`scripts/provider-validation/` holds host-owned semantic qualification rules.
The Google module contains the existing unary media, speech, grounded search,
inline understanding, and embedding checks. The compiler calls each check after
schema validation, in its existing order, including on other providers so
reserved formats cannot bypass qualification. Provider packages supply data;
they cannot load validation code or register a protocol as qualified. Runtime
adapters and lifecycle validation retain their existing owners.

### Model contract ownership

`shared/provider-model.ts` owns `ProviderModelDefinition` and the router-qualified
pricing types. `CompiledModel` refers to that definition directly. The client
`ClientCatalogModel` projection currently extends the same fields, preserving the
v1 response shape and existing type imports from `shared/contracts.ts`.

Build-time model handling lives in `scripts/provider-models.mjs`; price
normalization and tariff checks live in `scripts/provider-pricing.mjs`. The
provider compiler validates the manifest schema before calling their semantic
checks. These modules preserve the existing routing qualifications and local
price authority. They do not fetch a catalogue, trust remote prices, or infer
endpoint support. A future catalogue importer can supply neutral facts without
owning these provider-specific checks.

This separation gives future catalogue import and client presentation changes
an explicit boundary. It does not turn router price qualification into a public
catalogue fact, change price units, or establish execution eligibility. The
provider snapshot imports account observations from
`shared/provider-observations.ts`. Existing account type imports from
`shared/contracts.ts` remain available.

The compiled snapshot's declaration dependency graph is independent of the client
API and Worker environment. `test/provider-snapshot-contract.test.mjs` emits that
graph and typechecks a consumer using only the emitted declarations. This is an
internal build boundary, not a published package or a new runtime validator.

## 3. Vocabulary and identities

| Object | Meaning | Example |
| --- | --- | --- |
| Provider | Stable integration identity and package owner | `openai`, `anthropic`, `openrouter` |
| Product | An upstream access surface with its own auth, limits, and terms | `platform-api`, `codex-subscription` |
| Protocol | Request/response semantics | `openai.responses`, `anthropic.messages` |
| Transport | Connection mechanics | HTTP JSON, SSE, WebSocket, multipart |
| Operation | What the caller requests | generate text, decide, embed, search |
| Model reference | Exact catalogue pair `(provider, modelId)` | Provider ID plus opaque upstream model ID |
| Connection | Tenant-owned configured use of a provider product | Production OpenAI project |
| Grant | Scoped permission to use a connection, referencing credentials | Team A may use project X |
| Credential | Secret material and its lifecycle, owned by a credential service | API key, OAuth token family, AWS identity |
| Offer | Compiled executable shape before caller-specific admission | Model X, Responses, platform API, SSE |
| Execution | One admitted upstream attempt | One credential generation and pricing revision |

IDs must not encode mutable labels, secret values, account emails, or plan names.
Provider and product IDs are versioned public contract identifiers. Connection,
grant, and execution IDs are opaque tenant-scoped identities. Catalogue IDs are
opaque: a model ID may contain `/`; never recover its provider by splitting on
every slash. Use the catalogue's reference helpers and an explicit mapping.

Keep existing external names such as `openai/<model>` as aliases throughout the
migration. A new internal identity scheme does not justify breaking clients.
Record both requested alias and resolved model reference in execution metadata.
Do not join two physical models merely because their display names match.

### Independent classification axes

```ts
type ProviderRole = "direct" | "gateway" | "local" | "service" | "composite";
type CommercialModel = "metered" | "subscription" | "prepaid" | "unbilled" | "unknown";
type AuthMethod = "api-key" | "oauth2" | "aws-sigv4" | "binding" | "none";
type Transport = "http-json" | "http-multipart" | "sse" | "websocket" | "binary";
```

These are separate fields, not a Cartesian product to eagerly materialize.
Products declare only combinations that exist. An upstream CLI integration is
not automatically a server-side provider product. Supporting local executables
would require a separately designed execution environment.

## 4. Ownership across the three repositories

There is already a reusable core: OpenClaw's
`packages/model-catalog-core`, named `@openclaw/model-catalog-core`. It exports
reference helpers, model types, normalization, and versioned bundle validation.
It is currently `private: true`, version `0.0.0-private`, and depends on a
workspace normalization package. It is not yet an installable public dependency.

The `catalog` repository is currently a publication repository. Its workflow
runs OpenClaw's `scripts/publish-model-catalog.mts` against plugin manifests and
publishes v1, v2, and v3 together. Do not pretend the JSON repository currently
owns model authoring or move that ownership implicitly during this refactor.

| Owner | Owns | Must not own |
| --- | --- | --- |
| Model catalogue core | Wire schemas, canonical references, neutral inference facts, source metadata | Worker bindings, OAuth callbacks, routing policies |
| OpenClaw plugin manifests today | Authored model definitions and client integration facts | ClawRouter tenant state or gateway credentials |
| Catalogue publisher | Validated, versioned public data and reproducible publication | Remote execution rules or secret distribution |
| ClawRouter provider packages | Products, endpoint bindings, auth recipes, operation qualifications, price overrides | A second generic model catalogue |
| ClawRouter control plane | Connections, policy, grants, secret references, quota observations, budgets | Mutating a public catalogue to express tenant access |
| ClawRouter data plane | Immutable plan execution and bounded observation | Fetching the catalogue or probing account eligibility before each request |

**Recommended first integration:** publish a supported, independently versioned
release of the existing catalogue core after removing or publishing its
workspace-only dependency. Reuse that package in both applications. Validate
the catalogue during a ClawRouter update/build job, import selected data, and
bundle the resulting snapshot. The Worker need not ship a schema validator.

Do not install the entire OpenClaw repository as a dependency. Do not copy the
schemas into ClawRouter and call that sharing. Moving model authoring into
`catalog` could be a later decision, but it is not required here.

### Catalogue compatibility policy

- Consume v3 explicitly. The unversioned feed remains v1; changing its meaning
  would break existing consumers.
- v3 has `inference.chat` and structured `inference.decision` facts. v1/v2 do
  not gain native decision support through inference from names or JSON output.
- Preserve `known`, `unknown`, and `withdrawn` price states. An unknown or
  withdrawn row must not silently regain an old price from another index.
- Preserve explicit zero separately from absent price. Validate currency,
  units, and decimal conversion before producing integer internal amounts.
- Treat catalogue `providers.api` as descriptive client metadata. It cannot
  authorize a ClawRouter endpoint or select an unshipped adapter.
- Maintain an explicit provider map, for example catalogue provider `google`
  to router integration `google-gemini`, only after verifying that mapping.
  Never assume string equality means semantic equality.

## 5. A provider package

```text
providers/
  openai/
    provider.yaml             identity, products, operation bindings
    models.yaml               catalogue selection and scoped overrides
    pricing.yaml              router-qualified commercial rates
    assets/
      logo.svg
      logo-dark.svg           optional
      provenance.json         origin, license, source version
    fixtures/                 synthetic request/response and quota cases
    contract.test.mjs         package conformance cases
    README.md                 support boundaries and maintenance owner
    adapter.ts                only if declarative bindings are insufficient
```

Allow one-file declarations for small integrations. Self-contained means one
ownership boundary, not a mandatory pile of empty files. The compiler discovers
packages and validates all references. It generates registry entries, branding
metadata, setup form descriptors, offer indexes, and the lean Worker snapshot.

An adapter is a statically imported, reviewed TypeScript module. Remote catalogue
data cannot introduce code, URLs, secret bindings, refresh endpoints, headers,
or arbitrary templates. Avoid a generic scripting language in YAML.

### Proposed declaration shape

```yaml
schema: clawrouter.provider.v2
id: openai
displayName: OpenAI
role: direct
branding:
  light: ./assets/logo.svg
products:
  platform-api:
    commercialModel: metered
    authentication: platform-key
    bindings: [responses-api]
  codex-subscription:
    commercialModel: subscription
    authentication: existing-subscription-grant
    bindings: [responses-subscription]
    availability: existing-integrations-only
authentication:
  platform-key:
    method: api-key
    provisioning: [operator-secret, scoped-grant]
    injection: bearer
  existing-subscription-grant:
    method: oauth2
    provisioning: [existing-managed-grant]
    onboarding: unavailable
bindings:
  responses-api:
    operation: text.generate
    protocol: openai.responses
    transports: [http-json, sse]
    endpointRef: platform-responses
    capabilityProfile: platform-responses-v1
    pricingProfile: platform-responses
  responses-subscription:
    operation: text.generate
    protocol: openai.responses
    transports: [http-json, sse]
    endpointRef: subscription-responses
    capabilityProfile: subscription-responses-v1
    pricingProfile: subscription-accounting
models:
  catalogProvider: openai
  selection: explicit
```

This is a shape illustration; endpoint, model selector, capability, and pricing
references must resolve in a real package. It intentionally does not assert that
subscription onboarding, WebSockets, or full Responses lifecycle are available.
Preserve the current documented support boundary in
[OpenAI subscriptions](openai-subscriptions.md).

### Compiler output

```ts
interface OfferDefinition {
  id: string;
  providerId: string;
  productId: string;
  modelRef?: { provider: string; id: string }; // absent for model-free operations
  operation: string;
  protocolId: string;
  transports: readonly Transport[];
  capabilityProfileId: string;
  pricingProfileId: string;
  authProfileId: string;
  bindingId: string;
}
```

Use discriminated operation-specific shapes underneath this summary. A search
operation must not be forced to invent a model, token price, or reasoning level.
Intern large profiles once and refer to them by index in the Worker snapshot.
Keep logs, documentation, assets, and test fixtures out of the hot-path bundle.

Compiler checks include unique IDs; valid cross-references; exact model mapping;
allowed URL origins and placeholders; protocol/transport compatibility;
credential injection; complete lifecycle dependencies; pricing units; asset
references; and adapter availability. Reject ambiguous alias collisions.

## 6. Capabilities are evidence, not marketing labels

Use three layers:

1. **Operation semantics:** text generation, decisions, embeddings, reranking,
   image generation, speech, transcription, search, extraction, generic REST.
2. **Protocol binding:** OpenAI Responses, Chat Completions, Anthropic Messages,
   native Decisions, provider REST. These describe wire behavior.
3. **Qualified features and constraints:** tools, structured output, reasoning
   domain, input modalities, streaming, background create, retrieve, cancel,
   continuation, service tier, request size and token limits.

Continue exposing existing `llm.chat`, `llm.responses`, `llm.decisions`, and
other public IDs as compatibility projections. Internally avoid equating a
protocol name with the semantic operation.

Every consequential fact has `supported`, `unsupported`, or `unknown`, plus
scope and provenance. Absence is unknown. A source can establish a fact only
within its authority: a model catalogue cannot certify an account entitlement,
and one successful request cannot certify every tool or service tier.

```ts
type Fact<T> =
  | { state: "known"; value: T; source: string; checkedAt: string }
  | { state: "unknown"; reason: string };

interface CapabilityScope {
  providerId: string;
  productId: string;
  modelRef?: { provider: string; id: string };
  bindingId: string;
  transport: Transport;
}
```

For booleans, known false represents explicit lack of support. Generic native
passthrough may forward an unknown field under current policy; it must not
advertise that field as supported or use it for automatic composition. Preserve
the existing distinction between admission checks and upstream validation.

Effective features are the compatible intersection of model facts, shipped
binding qualifications, product restrictions, account entitlement, and policy.
Constraints combine according to their meaning: numeric maximums narrow by
minimum, allowed sets intersect, required fields accumulate. They do not all
use a generic last-writer-wins merge. Contradictions produce diagnostics and
disable the affected offer until resolved.

### Native Decisions

Native decision models are first-class operations, not chat models with a JSON
prompt. Reuse v3's question kinds (`boolean`, `choice`, `score`, `sort`, `tags`,
`box`), probability semantics, abstention, reasoning modes, grounding support,
and limits where declared. A provider-specific confidence value is not a
calibrated probability. Do not compare confidence across providers as though
it were one scale.

An offer for Decisions requires a shipped protocol adapter and a qualified
billing model. `inference.decision` alone does not make it executable. Token
pricing cannot silently become pricing per decision or per question. The shared
schema already distinguishes tokens, decision units, and requests.

Keep three concepts separate: a native decision operation, an explicit chat
composition that produces structured output, and ClawRouter's own route
selection. A decision model can later power route selection, but that is an
opt-in paid child execution with a deterministic fallback, not a hidden call
before every request. Preserve Fusion as an explicit composite offer.

## 7. Connections, grants, credentials, and subscriptions

```ts
interface Connection {
  id: string;
  tenantId: string;
  providerId: string;
  productId: string;
  label: string;
  enabled: boolean;
  credentialSetRef: string;
  accountRef?: string;
  configurationRevision: string;
}

interface Grant {
  id: string;
  connectionId: string;
  subjectScope: string;
  allowedOfferIds: readonly string[];
  enabled: boolean;
  revision: string;
}
```

These are logical boundaries, not a demand for one new database per object.
Preserve credential-owner Durable Objects and their refresh serialization.
Public DTOs contain credential status and opaque references, never secret
material. Keep refresh-token rotation, generation, lineage, and ambiguous
refresh outcomes; they are correctness requirements, not migration clutter.

Model three independent state machines:

| State domain | Representative states |
| --- | --- |
| Credential | missing, active, refreshing, retry-blocked, reauth-required, revoked |
| Entitlement | unknown, eligible, limited, exhausted, expired |
| Connection | disabled, incomplete, ready, degraded |

An active token does not establish a paid plan, model permission, or remaining
quota. A quota observation has source, timestamp, reset time, units, and scope:
account, product, model group, or connection. Stale observations remain visibly
stale. Provider-reported unknown remaining quota is not unlimited quota.

Auth profiles define acquisition, injection, refresh, revoke, identity lookup,
and optional quota lookup separately. Provider packages declare trusted recipes;
the core performs state validation, PKCE where applicable, secret handling,
bounded retries, scheduling, and persistence. OAuth client ownership and exact
registered callbacks are part of deployment qualification. A provider logo and
a token endpoint are not enough to render a Connect button.

In particular, retain OpenAI's current unavailable browser onboarding while
representing existing managed subscription grants. This design does not add a
token-import workaround or turn a client-only entitlement into shared access.

### Selection and refresh

Filter candidates by tenant and subject, product, operation, model, transport,
entitlement, policy, cooldown, and usable credential generation before ranking.
Never select a preferred grant and only then discover it cannot execute the
operation. An API key and subscription grant can have different eligible offers
even when they belong to the same provider.

Refresh remains single-writer per credential family. Quota probes and scheduled
maintenance stay outside inference admission. Read the existing owner's local
credential cache on warm requests. Do not add a distributed refresh lookup to
every request. A connection edit invalidates the relevant projection generation.

Failover must not cross tenant, product, cost ceiling, privacy, or region policy.
After a request may have reached an upstream, a timeout does not prove no work
or charge occurred. Retry only with operation-specific idempotency evidence;
do not replay a stream after user-visible output. Preserve credential affinity
for continuation, retrieval, cancellation, and WebSocket session state.

## 8. One resolver for discovery and execution

```text
provider packages + catalogue snapshot + qualified overrides
                         |
                      compiler
                         |
                immutable offer registry
                         |
caller policy + connection/grant projection + local observations
                         |
              shared eligibility evaluator
                    /             \
          discovery projection    admission + selection
                                         |
                                   execution plan
                                         |
                              credential materialization
                                         |
                              protocol adapter -> upstream
                                         |
                         bounded observations + settlement
```

The evaluator is pure over a captured snapshot. Discovery asks what is eligible
and explains blockers without consuming quota, reserving money, selecting a
credential permanently, or calling upstreams. Execution repeats admission with
the concrete request and current allowed projection. Discovery is an observation,
not a reservation or a guarantee against later revocation.

An execution plan freezes offer, binding, catalogue, policy, connection, grant,
credential generation, price revision, budget principal, and affinity metadata.
The credential owner verifies the selected revision before materialization.
Persist enough of this identity to settle delayed jobs after a catalogue update
without saving the prompt or response body by default.

Keep warm admission, route selection, credential reads, and soft-budget verdicts
in isolate memory. Preserve the configured hot-cache maximum staleness, including
authoritative behavior when it is zero. Explicit `reserve` budgets remain
foreground and authoritative. This refactor cannot redefine a hard budget as
eventual consistency to meet a latency target.

Cold cache behavior must be explicit and retain existing authority rules. A
miss cannot manufacture eligibility. Snapshot installation swaps one complete
generation atomically; no request mixes old model facts with new rates.

### Adapter boundary

Adapters own wire transformation and bounded observation: prepare request,
decode errors, normalize usage, interpret quota headers, and expose supported
lifecycle hooks. They do not read global policy, select grants, reserve budgets,
refresh credentials, or write analytics directly.

Use small operation-specific interfaces. An HTTP JSON adapter need not implement
WebSocket or background-job methods. Keep stream processing incremental and
bounded; no common abstraction may require buffering an entire completion.
Share the existing protocol implementations rather than moving copies into
every package. Provider adapters extend the protocol only at actual differences.

## 9. Pricing, spend, and analytics

Maintain four separate financial views:

| View | Meaning |
| --- | --- |
| Provider charge | Known or estimated variable upstream charge |
| Subscription allocation | Explicit accounting allocation of a recurring fee |
| API-equivalent value | Optional comparison against a named metered price card |
| Policy debit | Amount charged against a router's internal budget or tariff |

A subscription call is not automatically free. It may consume quota, use paid
credits, or trigger overage. Conversely, applying API list prices to all
subscription traffic would misstate cash spend. Show these measures separately;
never sum them into one default total.

Represent measured quantities before pricing: input/output tokens, cache read
and write tokens, requests, decisions, images, characters, audio duration,
credits, and provider-specific units. Units must carry their scope and
provenance. Do not convert credits or percentage quota into money without a
qualified conversion. Preserve measured zero versus missing usage.

Price cards identify currency, unit, applicability, effective date, source,
settlement basis, service tier, context bracket, cache treatment, and known
unpriced components. Ingest catalogue decimals with exact decimal conversion;
do not use binary floating-point multiplication as the money contract. Preserve
current integer micro-USD budget fields and use checked rational/decimal
arithmetic where a unit price needs finer precision.

Catalogue prices may populate display estimates immediately after validation.
They become hard-budget prices only after the router's price qualification:
complete dimensions, valid bounds, correct product, and conservative treatment
of unsupported or unpriced components. Existing qualified local cards take
precedence until deliberately replaced. A negotiated price is a tenant/product
override, never a mutation of the global model row.

### Subscription accounting example

For a hypothetical $100/month subscription with 10,000 observed calls:

- Fixed cash expense: $100 for the billing period, recorded once.
- Equal-per-call allocation: $0.01/call, explicitly labeled an allocation.
- Variable charge: unknown until the product rules or invoice establish it.
- API-equivalent value: calculated separately from a pinned reference card.
- Remaining quota: whatever the provider reports, including unknown or stale.

Allocation must state its method and period. Token-weighted allocation can be a
reporting option, but it cannot change enforcement retroactively. Show invoices
and corrections as separate revisions when reconciled.

### Event model and delivery

Use a logical request ID and one attempt ID per actual upstream execution.
Retries, Fusion advisers, synthesis, and optional decision-routing calls are
child attempts. Every attempt carries provider, product, connection, offer,
opaque grant reference, requested/resolved model, operation, protocol, transport,
status, latency, time to first output, usage evidence, and pinned pricing basis.
Tenant-filter all queries. Do not place account emails or secret fingerprints
in public dimensions. Keep high-cardinality attempt IDs in event storage, not
every metrics label.

Budget reservation and settlement continue to use durable idempotency keys.
Queue delivery can repeat: deduplicate event and settlement identities; represent
late usage as a correction rather than double charging. A lost response can have
uncertain usage and a retained conservative reservation. Do not collapse
unknown into zero merely because an analytics event is missing.

Control-plane changes and background refreshes have their own audit events.
Quota snapshots are observations, not spend events. A dashboard rollup must
declare whether it aggregates logical requests, attempts, or child executions.

## 10. Catalogue refresh and supply-chain boundary

Start with a build/update job, not a runtime subscription:

1. Fetch a configured, versioned catalogue URL outside the request path, with
   size/time bounds and conditional HTTP validation.
2. Validate the complete candidate using the supported catalogue core.
3. Resolve explicit model selections and provider mappings.
4. Compute field-level changes, withdrawals, missing mappings, and price gaps.
5. Compile a candidate snapshot and run provider contract fixtures.
6. Review execution-affecting changes, then deploy a pinned snapshot.

Record source commit where supplied, payload digest, schema version, import
time, and compiler version. A digest establishes identity, not publisher
authenticity. Trust still comes from the configured distribution path; artifact
signing can be added later without pretending it exists today.

Remote metadata cannot add a provider, change an endpoint, widen credential
scope, enable billing dimensions, or execute a newly advertised protocol.
Unknown protocols remain informational. A new model is imported only under an
explicit selection policy; it is not automatically authorized for every tenant.

If live metadata updates become necessary, first separate display-only metadata
from execution generations. Last-known-good is useful for an update failure,
but withdrawn or expired pricing cannot remain authoritative indefinitely.
Attach freshness policy to qualified price cards. On expiry, retain safe native
passthrough where policy allows it, and reject measured hard-budget admission
unless another qualified card or explicit fixed tariff exists.

Rollback swaps to a complete compatible snapshot, never individual model rows.
Existing executions settle against the revision they captured. Revocation and
price withdrawal remain separate control-plane invalidations, so rollback
cannot resurrect a disabled credential or an explicitly withdrawn rate.

## 11. UI and public API

Generate branding and setup descriptors from provider packages. Keep presentation
data separate from secret state. Validate and sanitize bundled SVGs at build
time; do not fetch arbitrary remote logos in the admin UI. Include asset
provenance and light/dark variants. Use a deterministic fallback icon.

The admin flow becomes:

1. Choose provider.
2. Choose product: API, subscription, gateway account, local endpoint, etc.
3. Show supported setup methods and exact deployment prerequisites.
4. Connect or provision credentials.
5. Inspect account/entitlement observations and available offers.
6. Set access, budget basis, quota behavior, and failover policy.

The provider page groups connections by product. It shows credential health,
quota freshness, actual/estimated charges, allocation, and offered operations
as distinct concepts. Do not render a green provider badge as proof that all
models and transports work. Display the blocker on the affected offer.

Keep `/v1/catalog` as the caller-scoped execution view. Extend it compatibly with
stable offer identity, product, capability constraints, and revision. Introduce
a versioned projection if semantics change. A model inventory endpoint is a
different view from executable offers. Keep hidden grant/account identifiers
out of unauthenticated responses and explain denials only to authorized owners.

Suggested diagnostic codes: `product_disabled`, `credential_missing`,
`reauth_required`, `entitlement_unknown`, `quota_stale`, `quota_exhausted`,
`operation_unsupported`, `model_unmapped`, `transport_unsupported`,
`price_unqualified`, and `policy_denied`. Unknown entitlement or stale quota
needs product-specific policy; neither globally permits nor globally denies
every API request.

## 12. Migration with bounded work packages

Keep old storage and routes authoritative until each replacement has parity.
Use one implementation owner per slice. Do not combine this refactor with
provider expansion, a UI redesign, or a new distributed scheduler.

| Slice | Deliverable | Acceptance and rollback |
| --- | --- | --- |
| 0. Freeze invariants | Golden offer, grant-selection, request, and accounting fixtures for representative products | Current behavior captured, including intentional denials; no production change. |
| 1. Shared catalogue core | Supported package release, v3 importer, pin/provenance manifest | Reproducible import; unknown/withdrawn/zero prices preserved; old static metadata remains usable. |
| 2. Provider v2 compiler | Package schema and v1-to-v2 internal normalization | All bundled v1 manifests produce equivalent routes, offers, and pricing; retain v1 input support. |
| 3. Product-aware offers | Pure shared eligibility evaluator; internal/public DTO separation | Shadow comparison with discovery and admission; explain every difference before switching reads. |
| 4. Connection identities | Explicit connection IDs, legacy default mapping, grant references | Multiple accounts remain isolated; old keys/routes resolve; roll back through projection compatibility. |
| 5. Accounting dimensions | Versioned attempt events, product/connection views, explicit charge bases | Deduplicated replay matches old budget totals; new reporting does not alter enforcement. |
| 6. Provider-owned setup and branding | Generated UI descriptors, package assets, product setup flow | No false Connect availability; asset and descriptor validation; legacy UI remains reversible. |
| 7. Remove compatibility code | Retire redundant metadata and old projections | Only after consumers, stored generations, and delayed executions no longer require them. |

Pilot with one simple metered provider and OpenAI's API/existing-subscription
split. Then exercise Anthropic, a gateway, a non-LLM REST service, and a native
decision provider. The inspected baseline lacks some later integrations; do not
assume work in other branches has landed.

For legacy grants, map `api_key` to a credential method and the verified metered
product; map `subscription` through that provider's explicit product; map `oauth`
using known provider semantics. Ambiguous records remain `legacy-unclassified`
under the compatibility path until classified. Never infer subscription from
the presence of a refresh token. Preserve credential ciphertext, generation,
lineage, grant IDs, and outstanding reservations.

For provider-keyed connections and budgets, create a legacy default connection
identity without duplicating existing spend. Preserve the provider aggregate
cap, then add optional connection/product limits. Do not copy one old provider
limit independently to every new connection: that would multiply allowance.

Expand storage first, dual-read through a single compatibility layer, backfill
idempotently, compare, then switch authority. Avoid two independent writers for
money or refresh state. Delay destructive schema contraction until old consumers
and background executions have drained. Rollback must retain new records and
recognize their supported subset, not erase them.

### Required verification matrix

- Same model via metered API and subscription yields different eligible offers.
- Two same-provider connections cannot leak credentials, quota, or spend.
- Decision-only model never appears as Chat; unknown model inherits no capability.
- Model identifiers containing slashes round-trip without alias corruption.
- Unknown/withdrawn catalogue prices cannot regain stale fallback prices.
- OAuth rotation, revocation, ambiguous refresh outcome, and generation races
  preserve existing credential-owner guarantees.
- HTTP, SSE, binary, multipart, and WebSocket retain protocol-specific behavior.
- Background create/retrieve/cancel and continuations keep credential affinity.
- Repeated events and late settlement never double charge.
- Subscription allocation never contributes twice to cash spend or budgets.
- Ordinary warm admission adds no foreground backend call; reserve mode stays
  authoritative; cache age zero and revocation bounds still work.
- All provider manifests compile; focused Worker/admin tests and relevant
  integration fixtures pass; non-trivial implementation receives autoreview.

Measure compressed snapshot size, cold-start work, warm route-selection CPU,
foreground call count, and streaming memory against the frozen baseline.
Set numerical regression limits from those measurements before the migration;
do not invent latency targets from this design alone.

## 13. Choices and sequencing

**Recommended:** explicit products and offers, shared catalogue core, build-time
import, existing deployment topology. It gives self-contained integrations
without transferring execution authority to remote data.

**Smaller alternative:** keep v1 manifests and add catalogue references plus
product IDs. Useful as the first slice, but insufficient as the final model if
grant kind still determines protocol and billing implicitly.

**Larger alternative:** move model authoring and the neutral contract package
into a dedicated shared repository. That could simplify multi-consumer
governance, but requires a publication and ownership migration. Do not put it on
the critical path for ClawRouter's internal cleanup.

The first implementation should end after a supported catalogue import and an
equivalent compiled registry for existing providers. That proves the shared
contract before connection/storage migration. The later subscription and
analytics slices then have a stable object model to build on.

Open decisions before implementation: package release ownership; automatic
versus explicit admission of new model rows; which product facts require live
entitlement proof; financial allocation defaults; and the deprecation window for
legacy public projections. Recommended defaults are explicit model admission,
no allocation in cash-spend totals, and no public alias removal in this refactor.

## 14. Evidence and scope

Local ClawRouter evidence: [provider guide](../providers/README.md),
[provider types](../worker/types.ts), [provider auth](../worker/provider-auth.ts),
[discovery](../worker/discovery.ts), [accounting](../worker/accounting.ts),
[provider compiler](../scripts/compile-providers.mjs),
[icon registry](../scripts/sync-provider-icons.mjs),
[public catalogue API](api-reference.md), and
[subscription support boundary](openai-subscriptions.md).

Other inspected source paths at the revisions stated above:

- `openclaw/catalog`: `README.md`, `.github/workflows/publish.yml`,
  `models/v3/catalog.json`.
- `openclaw/openclaw`: `packages/model-catalog-core/package.json`,
  `src/model-inference-capabilities.ts` within that package,
  `src/model-catalog/remote-bundle.ts`, `src/model-catalog/remote-overlay.ts`.

This RFC is based on repository inspection. It does not establish live provider
eligibility, test deployment behavior, change OAuth support, or implement the
proposed schema. No production configuration or existing credential state is
changed by this document.
