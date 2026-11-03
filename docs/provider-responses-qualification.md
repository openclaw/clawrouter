# Provider Responses qualification

Checked 2026-11-03. These are sourced catalog facts, not live runtime certification.

| Provider | Catalog result | Remaining qualification |
| --- | --- | --- |
| xAI | `grok-4.7` supports Responses, text/image input, reasoning and function calls. | Prove streamed encrypted-reasoning replay and tool history through the client and Worker. Reserve and settle the pre-generation request fee before hard-budget admission. |
| OpenRouter | The public model API explicitly lists Responses for `openai/gpt-6.1-terra`; the manifest advertises that exact model. | Prove the selected credential and upstream route, usage and plugin/routing costs. The row remains unpriced. |
| Azure OpenAI | The Responses endpoint is declared; no generic deployment is certified as a Responses model. | Supply an existing deployment's model/version, region and pricing contract, then prove credential-scoped discovery and inference. Deployment names are account configuration, not global model IDs. |

xAI recommends Responses for reasoning models. With `store: false`, callers must
send all output items back unchanged, including `reasoning.encrypted_content` and
function calls. The manifest does not claim retrieve/cancel or WebSocket support.
Grok 4.7's tariff starts at **200,000** prompt tokens, inclusive. Its configured
threshold is 199,999 because ClawRouter selects long-context rates strictly above
the threshold. The full context is a conservative output reservation ceiling,
not a claim about the provider's default output length. Priority doubles token
rates. A documented $0.05 pre-generation fee keeps whole-request pricing blocked.

OpenRouter Responses requires full history on each request. It rejects
`store: true` and non-null `previous_response_id`. `openrouter/auto` retains its
existing Chat capability; a qualified named row does not qualify dynamic routing.
The public catalog also lists file input, which is omitted from the manifest's
modality list until the router/client file contract is qualified.

Sources:

- [xAI Grok 4.7](https://docs.x.ai/developers/models/grok-4.7)
- [xAI reasoning replay](https://docs.x.ai/developers/model-capabilities/text/best-practices)
- [xAI priority and request fees](https://docs.x.ai/developers/pricing)
- [OpenRouter live model API](https://openrouter.ai/api/v1/models)
- [OpenRouter Responses contract](https://openrouter.ai/docs/api_reference/responses/overview)
- [Azure deployment and Responses requirements](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses)
