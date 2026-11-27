# Hosted Asian model APIs

Moonshot's frozen catalog, separate China credential and native model discovery
are specified in [Moonshot native contracts](moonshot-native-contracts.md).
The initial batch description below records its original Chat seed scope.

These experimental manifests expose standard Chat Completions and SSE. They do
not establish live provider parity. Endpoint and model references were checked
on 2026-11-03. No live upstream inference has been performed for this batch.

| Provider ID | Credential | Base URL | Initial model |
| --- | --- | --- | --- |
| `moonshot` | `MOONSHOT_API_KEY`, global platform API key | `https://api.moonshot.ai/v1` | `kimi-k3.1-pro` |
| `qwen` | `QWEN_API_KEY`, Model Studio Singapore API key | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3.8-max` |
| `zai` | `ZAI_API_KEY`, global Standard API key | `https://api.z.ai/api/paas/v4` | `glm-5.3` |

Use a provider-scoped stored API-key grant or the listed environment binding.
The Qwen binding deliberately has its own name: put the Singapore DashScope key
there. It does not read a shared `DASHSCOPE_API_KEY` of unknown region.
For unified chat use the prefixed model, for example `moonshot/kimi-k3.1-pro`.
Native requests use `/v1/native/<provider>/chat/completions` and the upstream
model ID. Opaque model passthrough carries no inferred price or model facts.

No rate cards are bundled. Token extraction is not proof of monetary settlement.
Hard-budget requests need an explicit policy fixed request price; unmetered
policies can use these routes. A fixed price is a router charge, not a statement
of upstream cost. Tool/reasoning replay, model-specific modalities and limits,
live SSE usage completeness, and priced reservation remain qualification gates.
No native-capability badges or reasoning-effort mappings are inferred here.

## Product boundaries

- Moonshot global and mainland China (`api.moonshot.cn`) are distinct platform
  contracts. `kimi` is reserved for Kimi Coding, whose subscription credentials
  and endpoint must not be sent to this standard API. This batch does not add
  Messages, Responses, server tools, or Code CLI runtime support.
- `qwencloud`, `modelstudio`, and `dashscope` name the Model Studio family; they
  are not extra providers. Singapore is the sole configured region here.
  Alibaba documents workspace-specific regional hosts and says the legacy
  Singapore host remains functional. CN, US, Hong Kong, Japan and Germany need
  separate region-bound configuration and credentials. Qwen Code OAuth and
  Token Plan endpoints are separate products; neither is an alias for this API.
- Z.AI's standard global endpoint differs from its global Coding Plan endpoint
  (`https://api.z.ai/api/coding/paas/v4`) and BigModel's mainland endpoints.
  Standard API grants do not advertise coding-plan entitlement. CN, coding-plan
  quota/credit accounting, authorization and refresh need separate qualification.

## Primary references

- [Kimi quickstart](https://platform.kimi.ai/docs/get-your-api-key)
- [Kimi Code providers](https://moonshotai.github.io/kimi-code/en/configuration/providers)
- [Model Studio Chat API and regional hosts](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)
- [Model Studio model example](https://www.alibabacloud.com/help/tr/model-studio/what-is-model-studio)
- [Qwen Code authentication and Token Plans](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)
- [Z.AI standard quickstart](https://docs.z.ai/guides/overview/quick-start)
- [Z.AI Chat API](https://docs.z.ai/api-reference/llm/chat-completion)
- [ZCode endpoint selection](https://zcode.z.ai/en/docs/configuration)
