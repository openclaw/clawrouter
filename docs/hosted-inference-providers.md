# Hosted inference providers

These experimental manifests expose hosted Chat Completions and SSE. References
were checked on 2026-11-03; no live upstream calls qualify this batch.

| Provider | API-key binding | Base URL | Initial upstream model |
| --- | --- | --- | --- |
| `nvidia` | `NVIDIA_API_KEY` | `https://integrate.api.nvidia.com/v1` | `nvidia/nemotron-3-ultra-550b-a55b` |
| `cerebras` | `CEREBRAS_API_KEY` | `https://api.cerebras.ai/v1` | `qwen-3.8-27b` |
| `deepinfra` | `DEEPINFRA_API_KEY` | `https://api.deepinfra.com/v1/openai` | `Qwen/Qwen3.8-27B` |
| `baseten` | `BASETEN_API_KEY` | `https://inference.baseten.co/v1` | `zai-org/GLM-5.3` |

All use `Authorization: Bearer <provider key>`. Stored API-key grants remain
provider-scoped. Unified model IDs prepend the provider, for example
`deepinfra/Qwen/Qwen3.8-27B`; native model IDs retain their full upstream namespace.
The native URL is `/v1/native/<provider>/chat/completions`. Each upstream request
appends `/chat/completions` to the listed base URL. DeepInfra must not gain an
extra `/v1` after `/openai`.

NVIDIA now has a closed, four-model [qualified inventory](nvidia-model-catalog.md);
its deprecated hosted Llama seed is excluded. The other providers' model
passthrough remains unpriced, including unknown tenant models. These manifests
do not publish prices, reasoning-effort maps or native model capability facts.
Hard-budget requests require an explicit policy fixed request price; unmetered
policies can use the routes. Fixed router charges are not measured upstream cost.
Tool/reasoning history preservation tests prove router behavior only. Live tools,
reasoning replay, stream-terminal usage, model availability and full monetary
settlement require separate evidence before claiming provider parity.

## Product boundaries

- NVIDIA's hosted endpoint is separate from downloadable NIM containers, their
  local management endpoints, and NVIDIA AI Enterprise entitlement. A hosted
  manifest does not install or administer NIM.
- Cerebras public hosted models are separate from dedicated inference, dedicated
  service tiers, batch management and account-specific endpoints.
- DeepInfra chat is separate from native inference, deployments, embedding,
  reranking, media and hosted-agent products. Priority/flex tariffs and returned
  `estimated_cost` are not qualified rate cards for this manifest.
- Baseten Model APIs are separate from custom deployments (`/predict`), Truss,
  Frontier Gateway, Decisions, Messages and Responses. Those APIs need their own
  protocol, credential and billing qualification; no broad capability is inferred
  from the provider's shared brand.

## Primary references

- [NVIDIA hosted LLM API](https://docs.api.nvidia.com/nim/reference/llm-apis)
- [Cerebras quickstart](https://inference-docs.cerebras.ai/quickstart)
- [DeepInfra Chat API](https://docs.deepinfra.com/chat/overview)
- [DeepInfra Qwen model](https://deepinfra.com/blog/qwen3-8-27b-deepinfra)
- [Baseten Model APIs](https://docs.baseten.co/inference/model-apis/overview)
