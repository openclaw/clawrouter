# Particle frozen native catalog

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/particle/{openclaw.plugin.json,index.ts}`. The finite family contains
one Chat card and strict live model discovery. This slice qualifies that card
and keyed discovery; it adds no newer vendor model, Responses WebSocket,
steering, file or hosted-search capability.

## Identity, input and controls

Primary contracts checked 2026-11-03:
[model catalog](https://docs.particle.ai/models),
[Chat](https://docs.particle.ai/chat-completions),
[reasoning](https://docs.particle.ai/reasoning),
[structured output](https://docs.particle.ai/structured-outputs).

Keep the existing explicit mapping:

| Role | Exact value |
| --- | --- |
| Router selected ID | `particle/particle-ai/particle-1` |
| Public catalog and returned native ID | `particle-ai/particle-1` |
| Documented request ID | `particle-1` |
| Configured provider key | `PARTICLE_API_KEY` |
| Selected global base | `https://api.particle.ai/v1` |

Manifest calls select the router ID and send the existing documented wire
alias. Native callers may select the public `particle-ai/particle-1` identity
or its documented `particle-1` alias; the Worker resolves both to the original
policy and physical request ID. Returned public IDs remain intact. There is no
second model row, product/key substitution or replacement tariff.

Particle documents text/image input, text output, function tools, a combined
1048576-token context and a 131072-token output ceiling. The upstream default
output limit is 32000 when both output-limit fields are absent. Explicit
`max_tokens` and `max_completion_tokens` are accepted; inconsistent simultaneous
values are upstream errors. The router does not inject a default or invent
an independent full input allowance when output also consumes context.

Advertise the frozen canonical efforts `none`, `low`, `high`, `max`, with
upstream default `high`. Current native aliases such as minimal/medium/xhigh
and `ultra` do not broaden this finite advertised menu. Frozen client
normalization remains source2-owned. Preserve `reasoning_content`, native
function/tool replay, developer messages and explicit `prompt_cache_key`;
do not infer long cache-retention support.

Native discovery explicitly reports `structured_outputs: false`. JSON schema
requests are accepted on a best-effort basis: the engine reduces schemas,
and `strict: true` does not add a schema guarantee. Preserve that request and
response contract; do not advertise guaranteed structured output. Fixtures
include a returned JSON object that does not satisfy the requested schema.

## Keyed model discovery

[List models](https://docs.particle.ai/models-endpoint) specifies bodyless
GET `/v1/models`, no query parameters, Bearer authentication with inference
scope, and the standard `{object: "list", data: [...]}` envelope. Credit balance
is not checked for this metadata request. A bounded anonymous probe returned
401; no credential was acquired or anonymous fallback introduced.

The existing `openai.models` parser and original-grant filter apply directly.
The public Particle-1 ID resolves to the same original router policy identity
as its documented request alias. Native metadata includes exact limits,
modalities, capabilities and reasoning fields; keep their native values rather
than rewriting them into a wider compiled menu. An empty filtered list stays
empty. Presence or absence describes service metadata, not account entitlement
or a universal retirement. Additional current vendor models remain outside
this frozen manifest and outside a Particle-1-only grant.

[Authentication](https://docs.particle.ai/authentication) keeps scopes fixed by
route. The [US endpoint](https://docs.particle.ai/regional-endpoints) has a
different GPU-placement constraint despite documented shared keys; this
manifest continues to select the global endpoint and never changes region on
failure. No endpoint auth override, foreign key or alternate-account retry.

## Usage, error and tariff boundaries

[Streaming](https://docs.particle.ai/streaming) uses OpenAI SSE, initial comment
keep-alives, reasoning deltas, tool deltas and a separate terminal usage chunk.
Successful streams finish with `[DONE]`. A caller can suppress stream usage;
that does not make generation free. Generated tokens remain billable after
disconnect or a late invalid-output error. Tests preserve those distinctions,
missing usage and no-replay behavior through the real Worker/SQLite path.

[Billing](https://docs.particle.ai/usage-billing) counts cached input as a prompt
subset and reasoning as an output subset. Do not add either subset twice.
Current default peak USD-per-million prices are 0.25 input, 0.03 cached input
and 1 output. However, account overrides, a DST-sensitive peak/off-peak period
locked per request and the actual served Flex tier affect settlement. Source1
and source3 must qualify those existing pricing/receipt paths before adding
an executable vendor tariff. Policy-fixed fixture charges remain independent.

[Service tiers](https://docs.particle.ai/service-tiers) can downgrade an
unentitled request. Preserve requested versus served tier and the native
`X-Particle-Service-Tier` header; a requested Flex tier alone proves no discount.
Hosted search has a separate fee that can survive later model rejection; it
is not advertised or priced by this finite Chat/tool-calling slice.

## Proof and remaining ownership

`worker/test/particle-native-runtime.test.mjs` compiles the actual YAML and
uses real Worker classification, original grant authority and SQLite reserve
accounting. It covers both native and manifest routes, exact identity mapping,
reasoning/tool replay, fragmented SSE, terminal usage, errors, cancellation,
image input, finite controls, schema semantics and private filtered discovery.
Fixtures assert metadata has no inference reservation or tariff requirement.

Integration uses the canonical `models.list` capability, explicit GET method
and nonstreaming metadata endpoint. This keeps discovery outside model-specific
inference admission while retaining the original credential owner checks.
Undeclared native URL aliases remain closed; the unified selected model ID
continues to map to the documented request alias.

`test/openclaw-particle.test.mjs` pins actual OpenClaw
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb`. Its public CI checkout uses its own
frozen installation and imports the registered Particle catalog/replay policy,
strict discovery builder, host replay sanitizer and native streaming client.
The real Worker and SQLite assertions cover selected public-ID to wire-ID
mapping, the four canonical efforts, cache affinity, tool replay, original
credentials, usage, errors and cancellation. The registered host deliberately
strips reasoning history before serialization; the Worker preserves reasoning
when supplied by native wire callers. Exact-head execution
results are recorded in the PR; authored cases alone are not a passing proof.

Configured native client proof is separate from ClawRouter catalog-driven or
manifest client selection. Worker fixtures cover native and manifest dispatch.
Source1 retains common projection/accounting and source3 its pricing schema.
No account entitlement, live inference, login, provisioning, regional migration
or manual deployment is claimed. Upstream-dollar tariff qualification remains
separate from explicit synthetic `policy_fixed` charges.
