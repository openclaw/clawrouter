# GMI frozen native Chat and discovery

Scope is the eight model IDs in `extensions/gmi/openclaw.plugin.json` and the
strict refresh/configured-catalog contract in `extensions/gmi/index.ts` at
OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`. Keep the already bundled
DeepSeek V4 Pro seed first and add the other seven exact identities. New market
models, control-plane deployments, Agentbox and native Messages/Responses are
outside this frozen Chat slice.

## Qualified contract

Primary sources checked 2026-11-03:

- [Developer endpoint contract](https://www.gmicloud.ai/en/developers).
- [LLM API reference](https://docs.gmicloud.ai/inference-engine/api-reference/llm-api-reference).
- [Text model reference](https://docs.gmicloud.ai/model-quickstarts/text/overview).
- [GLM 5.1](https://docs.gmicloud.ai/model-quickstarts/text/zai-org-glm-5-1-fp8).
- [DeepSeek V4 Pro](https://docs.gmicloud.ai/model-quickstarts/text/deepseek-ai-deepseek-v4-pro).
- [DeepSeek V3.2](https://docs.gmicloud.ai/model-quickstarts/text/deepseek-ai-deepseek-v3-2).
- [Claude Sonnet 4.6](https://docs.gmicloud.ai/model-quickstarts/text/anthropic-claude-sonnet-4-6).

The API reference specifies Bearer authentication for GET `/v1/models` and POST
`/v1/chat/completions`. Keep the original `GMI_API_KEY` and canonical base
`https://api.gmi-serving.com/v1`. A bounded anonymous metadata request returned
403; it did not expose an account catalog. No credential was acquired or sent.
That response establishes neither retirement nor entitlement for any model.
The existing standard `openai.models` request/response implementation handles
this documented list shape; no new parser or public credential-free helper is
introduced. The malformed illustrative example in the reference (empty `id`,
model name in `object`) does not override its normative field table or justify
relaxing the strict OpenAI list envelope.

| Frozen native ID (router prefix `gmi/`) | Declaration and remaining evidence |
| --- | --- |
| deepseek-ai/DeepSeek-V4-Pro | Retained seed; primary Chat and function-calling examples |
| zai-org/GLM-5.2-FP8 | Exact frozen Chat identity; current keyed catalog/access proof required |
| zai-org/GLM-5.1-FP8 | Primary Chat/function-calling; frozen deprecated hint lacks a qualified primary cutoff |
| deepseek-ai/DeepSeek-V3.2 | Primary Chat; frozen deprecated hint lacks a qualified primary cutoff |
| google/gemini-3.5-flash-lite | Exact frozen Chat identity; current keyed catalog/access proof required |
| anthropic/claude-sonnet-5 | Exact frozen Chat identity; current keyed catalog/access proof required |
| anthropic/claude-sonnet-4.6 | Primary Chat/functions/image input; frozen deprecated hint lacks a qualified primary cutoff |
| openai/gpt-5.6-sol | Exact frozen Chat identity; current keyed catalog/access proof required |

All cards are unpriced. Only three model-specific function-calling observations
are declared; only Sonnet 4.6's model-specific image input is declared. Other
native capabilities, effort menus and context/output ceilings remain unknown.
Frozen costs/limits and a generic model-description mention of 1M context are
not independent hosted admission or pricing evidence. Missing anonymous data
or absence from an unadvertised model list cannot establish a shutdown. No
`availability` date, serving alias, replacement price or account grant is invented.

## Actual Worker source fixtures

`worker/test/gmi-native-runtime.test.mjs` compiles the actual provider manifest
and uses the existing Worker authority, selected grants and SQLite budgets.
Both native and manifest routes cover eight JSON/SSE model identities, opaque
reasoning/tool history, fragmented tool deltas, terminal token/cache usage,
original authentication, revoked/missing credentials, unknown-cost admission,
HTTP errors, stream errors, missing usage and cancellation. Simulated upstream
wire preservation does not prove each hosted model supports every optional field.
The separate Sonnet image case uses its model-specific primary contract.

GET discovery is bodyless, credential-bound and zero-inference-cost. Fixtures
exercise filtered and empty lists, strict envelope/ID errors, denied upstreams,
revocation and rejected query remapping. Empty native inventory does not revive
static fallback cards. Native metadata and inference use the canonical `/v1/native/gmi` route.
Unified model prefixes `gmi/`, `gmi-cloud/` and `gmicloud/` retain the original
provider identity; undeclared native URL aliases remain closed. Model IDs
preserve case and are never provider-product aliases.

The synthetic seven-micro fixed policy charge is separate from unknown upstream
prices. A streamed receipt is used only when observed. No static zero-price
fallback or limit is assigned to configured passthrough models.

## Integration proof and remaining boundaries

The optional organization binding is implemented by
[`gmi-organization-binding.ts`](../worker/gmi-organization-binding.ts). Only the
original materialized server grant can supply `X-Organization-ID`; an absent
account ID remains ordinary Bearer authentication. Caller/static/environment
organization values cannot substitute for that owner. Authority checks after
admission waits and catalog reads preserve current owner and policy binding.

`test/openclaw-gmi.test.mjs` pins the actual public OpenClaw implementation at
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb`. Its CI fixture imports the registered
GMI plugin, both stream wrappers, configured catalog augmentation, strict live
catalog builder and replay sanitizer. The public checkout uses its own frozen
installation in ephemeral CI. Requests pass through the real Worker and SQLite
with distinct synthetic original credentials, both optional-organization and
ordinary-Bearer grants, unknown-price denial, terminal usage, errors and caller
cancellation. These are deterministic fixtures; passing execution is recorded
in the PR's exact-head proof, not implied by authored test cases.

This configured native client proof is separate from a ClawRouter catalog-driven
client resolver or manifest client selection. The Worker fixtures cover native
and manifest transport. No inference about live account access, current vendor
inventory, custom/dedicated base qualification, Messages/Responses or unknown
model pricing follows from either suite. No paid inference, login, organization
change, credential/host provisioning or manual deployment is part of this PR.
