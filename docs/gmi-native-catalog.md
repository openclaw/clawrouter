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
static fallback cards. Metadata and inference both retain the original canonical
provider even through existing `clawrouter-gmi`, `gmi-cloud` and `gmicloud`
routing aliases. Model IDs preserve case and are never provider-product aliases.

The synthetic seven-micro fixed policy charge is separate from unknown upstream
prices. A streamed receipt is used only when observed. No static zero-price
fallback or limit is assigned to configured passthrough models.

## Owner handoffs and proof boundaries

- Source1: the primary multi-organization contract names `X-Organization-ID`.
  A future selected-account organization binding must come from the original
  server-controlled grant/transport, not a caller-supplied header. This manifest
  does not forward that header. Frozen custom/dedicated bases also need the
  existing approved destination/key-binding runtime; no inferred service URL or
  provisioning. Keyed metadata must not fail over to anonymous data or another
  grant to manufacture a catalog.
- Source2: qualify the actual frozen `openai/` tool-reasoning compatibility
  wrapper and configured catalog augmentation. The eight literal cards do not
  replace strict live discovery or establish account access. Preserve native
  replay; no source4 client or model-name heuristic is added.
- Source6: serialized snapshot integration, final exact-head Worker/native-client
  proof and any separately authorized keyed consumer. Source4 holds no snapshot
  lease. The compiler/runtime format foundation is already landed; shared code
  is unchanged.

Local execution remains code-only under native dependency qualification. Hosted
checks must distinguish all-manifest compilation from Worker tests skipped by a
snapshot gate. No paid inference, login, organization change, credential/host
provisioning or manual deployment occurred.
