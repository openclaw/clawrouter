# Provider Responses qualification

Checked 2026-11-03. These are sourced catalog facts, not live runtime certification.

| Provider | Catalog result | Remaining qualification |
| --- | --- | --- |
| xAI | `grok-4.7` supports Responses, text/image input, reasoning and function calls. | Prove streamed encrypted-reasoning replay and tool history through the client and Worker. The landed runtime reserves inference plus the possible outcome fee; unknown hosted-tool bounds and retained history remain denied under hard budgets. Caller-specific native search admission still needs runtime projection. |
| OpenRouter | The public model API explicitly lists Responses for `openai/gpt-6.1-terra`; the manifest advertises that exact model. | Prove the selected credential and upstream route, usage and plugin/routing costs. The row remains unpriced. |
| Azure OpenAI | The Responses endpoint is declared; no generic deployment is certified as a Responses model. | Supply an existing deployment's model/version, region and pricing contract, then prove credential-scoped discovery and inference. Deployment names are account configuration, not global model IDs. |

xAI recommends Responses for reasoning models. With `store: false`, callers must
send all output items back unchanged, including `reasoning.encrypted_content` and
function calls. The manifest does not claim retrieve/cancel or WebSocket support.
Grok 4.7's tariff starts at **200,000** prompt tokens, inclusive. Its configured
threshold is 199,999 because ClawRouter selects long-context rates strictly above
the threshold. The full context is a conservative output reservation ceiling,
not a claim about the provider's default output length. Priority doubles token
rates. `requestPricing` binds the documented possible $0.05 pre-generation fee
through the existing admission/settlement runtime. The model retains
`unpricedCosts: [request_fee]`; only the qualified outcome-tariff path handles
that gap. The whole original `usage.cost_in_usd_ticks` receipt settles once;
unknown outcomes retain the reserve. No arbitrary error or refusal proves a
billable violation or a free failure. `max_output_tokens` cannot reduce the
full reasoning/function-output reserve.

The exact Grok 4.7 row declares native `web_search` support and low reasoning.
These are model facts, not a static admission verdict. Actual callers require
`clawrouter.hosted-tool-admission.v1` derived by shared runtime from their
selected route, policy and pricing. No YAML field advertises `admitted`.

Hosted Web Search is $5 per 1,000 calls. X Search is separately $5 per 1,000
returned posts and $10 per 1,000 returned profiles, including qualifying parent
and quoted posts. `max_turns`, citation counts and tool attempts do not bound
these costs. Native server declarations remain zero-egress under hard-dollar
budgets until all their charge bounds are qualified; explicit `policy_fixed`
remains separately labeled. Ordinary client functions named `x_search` and
user JSON are not server-tool execution. No live charge probes were performed.

`worker/test/xai-responses-manifest.test.mjs` compiles the actual YAML and
exercises native/manifest Worker requests, original credentials, conservative
reservation, complete receipt settlement, hosted-charge denial and distinct
policy-fixed accounting. These deterministic fixtures do not certify actual
client search, safe citations or encrypted-history continuation.

OpenRouter Responses requires full history on each request. It rejects
`store: true` and non-null `previous_response_id`. `openrouter/auto` retains its
existing Chat capability; a qualified named row does not qualify dynamic routing.
The public catalog also lists file input, which is omitted from the manifest's
modality list until the router/client file contract is qualified.

Sources:

- [xAI Grok 4.7](https://docs.x.ai/developers/models/grok-4.7)
- [xAI reasoning replay](https://docs.x.ai/developers/model-capabilities/text/best-practices)
- [xAI native Web Search](https://docs.x.ai/developers/tools/web-search)
- [xAI priority and request fees](https://docs.x.ai/developers/pricing)
- [OpenRouter live model API](https://openrouter.ai/api/v1/models)
- [OpenRouter Responses contract](https://openrouter.ai/docs/api_reference/responses/overview)
- [Azure deployment and Responses requirements](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses)
