# Existing provider qualification

Research checkpoint: **2026-11-03**. Source inventory: the 22 provider manifests
at `8833ed747cbcf521aa8139c234de286126e29f30`. Later provider additions have their
own qualification. This document records source evidence and unresolved work;
it does not certify live transport, client compatibility, or hard budgets.

Keep these results separate:

- Published model or endpoint facts establish what the provider documents.
- Compiler checks establish that a manifest is valid and represented in the snapshot.
- Runtime fixtures establish specific request, stream, usage and isolation behavior.
- Live qualification establishes that the selected account, model, region and
  transport actually work. Hard budgets additionally need every cost component,
  a preflight bound, and complete settlement evidence.

An unpriced model can still serve fixed-request or unmetered policies. A token
rate alone must not certify a request that can incur other charges. Dates below
are source-check dates, not claims about when providers changed their tariffs.

## Disposition of all 22 existing providers

| Provider | Source evidence checked | Disposition and next gate |
| --- | --- | --- |
| anthropic | [Models](https://platform.claude.com/docs/en/models/overview), [pricing](https://platform.claude.com/docs/en/about-claude/pricing) | Current Fable 5.1, Opus/Sonnet/Haiku 5.5 base rates agree with bundled cards. Mythos prices are published, but publication does not establish account access. Qualify restricted inventory and native facts through scoped model discovery; preserve Messages tool/cache/modifier gates. |
| aws-bedrock | [Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html), [pricing](https://aws.amazon.com/bedrock/pricing/) | Existing Invoke/InvokeStream is not Converse parity. Converse uses a distinct message/tool contract; EventStream observation, client transport and model/region-specific prices remain required. A generic model/inference-profile ID cannot inherit direct-provider rates. |
| azure-openai | [Responses](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses) | Endpoint documented; deployment placeholder remains unqualified for Responses. Need an existing deployment's model/version, region, credential isolation and rate contract. API key and Entra ID are separate auth flows. Foundry is not an alias for every Azure OpenAI deployment. |
| cloudflare-ai-gateway | [Provider-native routes](https://developers.cloudflare.com/ai-gateway/usage/providers/) | The bundled universal-array wrapper does not establish provider-native or client transport parity. Pin the gateway route and upstream billing/credential contract before declaring model capabilities or prices. |
| cohere | [Command A+](https://docs.cohere.com/docs/command-a-plus), [compatibility API](https://docs.cohere.com/docs/compatibility-api), [models](https://docs.cohere.com/docs/models) | Command A+ is current: 128k context, 64k output, text/image input. Native billed-unit observation is implemented in [#374](https://github.com/openclaw/clawrouter/pull/374); real client/transport qualification remains separate. The documented compatibility route is `https://api.cohere.ai/compatibility/v1`; system/developer/tool-choice semantics require client proof. Free rate-limited API access does not price Model Vault deployments. |
| deepseek | [Models and tariffs](https://api-docs.deepseek.com/quick_start/pricing/) | Existing peak token rates match the published conservative bound. `deepseek-flash` now resolves to V4.1-Flash-1017; legacy Flash IDs are accepted aliases for retired models. Update vision facts and qualify Responses/Anthropic transports separately. Search/fetch fees need their own meter. |
| firecrawl | [Billing](https://docs.firecrawl.dev/billing), [keyless limits](https://docs.firecrawl.dev/rate-limits) | Scrape has credit and option-dependent charges, not a universal one-request price. Search/crawl/map additions require their own routing and bounds. Preserve optional-key scope; keyless access does not imply every endpoint is free or available. |
| fireworks | [Serverless rates](https://docs.fireworks.ai/serverless/pricing), [OSS120B](https://fireworks.ai/models/fireworks/gpt-oss-120b), [modes](https://docs.fireworks.ai/serverless/serverless-modes) | Missing OSS120B card is addressed in [#376](https://github.com/openclaw/clawrouter/pull/376). Current GLM 5.3/Flash/Fast inventory still needs bounded additions. Fast router IDs differ from Priority `service_tier`; do not interchange them. |
| google-gemini | [Generate/stream](https://ai.google.dev/api/generate-content), [pricing](https://ai.google.dev/gemini-api/docs/pricing) | F01 tier enforcement and F06 SSE query/runtime changes are implemented in [#371](https://github.com/openclaw/clawrouter/pull/371), [#377](https://github.com/openclaw/clawrouter/pull/377) and [#388](https://github.com/openclaw/clawrouter/pull/388); live transport qualification remains separate. Current docs include Gemini 4 Argon and several native media families; the existing 3.5 Flash card must not certify those models. Qualify exact current model IDs and media/grounding costs separately. |
| groq | [Models](https://console.groq.com/docs/models) | OSS120B base rates and bounds match. [#409](https://github.com/openclaw/clawrouter/pull/409) adds OSS20B and keeps both OSS hard budgets blocked pending hosted-tool/tier qualification. The 20B model page rounds cached input to $0.037/M while the documented 50% discount gives $0.0375/M; use the higher bound. Safeguard/Qwen availability, parsed reasoning and transcription remain separate gates. |
| huggingface | [Billing](https://huggingface.co/docs/inference-providers/pricing) | `:fastest` is dynamic routing. Keep it unpriced until selected provider/model and billed rates are pinned and observed. Dynamic routing does not establish uniform modalities or token ceilings. |
| lanseq | [Configured evidence URL](https://api.lanseq.cloud/docs) | Source retrieval was unavailable during this audit. Existing September card is not re-certified. Need accessible primary model/rate evidence and a scoped inference/usage probe for the exact Qwen target; do not invent replacements. |
| local-openai | [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility) | Generic compatible Chat is a transport option, not native local-engine parity. Zero API charge assumes operator-hosted local compute; it does not price arbitrary cloud endpoints. Need reachable host bridge, actual model discovery and tested context/modality/embedding contracts. |
| minimax | [Invocation](https://platform.minimax.io/docs/guides/text-generation), [pricing](https://platform.minimax.io/docs/pricing/overview) | Current documented models include M3.1-Flash and M3; bundled M2.7 alone is incomplete. Add current cards with M3 long-context/Priority rates. Global/CN API keys and subscription/OAuth routes require distinct endpoint/auth qualification; do not reuse secrets across products. |
| mistral | [Models](https://docs.mistral.ai/models) | Current inventory includes Large 4 and Small 4 plus coding and Voxtral families. Model additions do not resolve native tool-ID replay; client strict9 handling remains a separate gate. Audio/realtime models need their native protocols and meters. |
| openai | [Models](https://developers.openai.com/api/docs/models), [pricing](https://developers.openai.com/api/docs/pricing) | Bundled flagship base rates agree with current published rates. Preserve existing endpoint/tool/media scope gates. Check 12-hour cache-write, regional/FedRAMP and processing-tier costs before extending priced modes. GPT-Live/agent surfaces require runtime contracts rather than a static model badge. |
| openrouter | [Live catalog](https://openrouter.ai/api/v1/models), [Responses](https://openrouter.ai/docs/api_reference/responses/overview) | [#383](https://github.com/openclaw/clawrouter/pull/383) adds the exact Terra Responses row from the live catalog. It stays unpriced. Responses is stateless; `auto` is not upgraded by inference. Verify selected account/provider, optional plugins and usage costs. |
| perplexity | [Sonar migration](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview), [pricing](https://docs.perplexity.ai/docs/getting-started/pricing) | Sonar support ended September 27; synchronous/streaming calls are being reformulated as Agent API requests. Old Sonar token/request tariffs cannot certify current cost. Keep the request-fee gap; implement Search and Agent APIs under their separate tool/usage contracts. |
| replicate | [Billing](https://replicate.com/docs/topics/billing), [prediction lifecycle](https://replicate.com/docs/topics/predictions/lifecycle) | Async create/read does not settle a completed prediction. The bounded managed-prediction slice uses typed create/retrieve/cancel links from [#400](https://github.com/openclaw/clawrouter/pull/400), scoped persistent ownership, terminal polling and conservative accounting. Its first implementation rejects webhooks. Requested model versions, tariff/bounds, uncertain-create recovery and idempotent attribution still require integrated proof. Do not turn an async 200/201 into a metered success. |
| tavily | [Credits](https://docs.tavily.com/documentation/api-credits) | Search/extract/crawl need operation credits plus an account-specific credit-to-money basis. Map is a separate endpoint. Request counters alone cannot attest consumed credits or a complete dollar bound. |
| together | [Available models and rates](https://docs.together.ai/docs/serverless/models) | Existing GLM 5.2 base rates match. GLM 5.3/Flash and other current rows remain candidates. US-only inference has a separate premium; image per-request estimates are not universal fixed tariffs. Embedding/image/video need their own endpoint contracts. |
| xai | [Grok 4.7](https://docs.x.ai/developers/models/grok-4.7), [pricing](https://docs.x.ai/developers/pricing), [replay](https://docs.x.ai/developers/model-capabilities/text/best-practices) | [#383](https://github.com/openclaw/clawrouter/pull/383) adds Responses/Grok 4.7 with the request-fee gap retained. Prove encrypted reasoning and tool replay. Priority, long context, regional processing, search and media are separate billing dimensions. |

## Request and credit costs before hard-budget certification

These are published tariff facts, **not executable admission cards**. Runtime
must still establish the charge condition, maximum billable quantity, account
rate and complete usage evidence. Credit rates below are not dollars.

| Service / operation | Published charge | Missing qualification |
| --- | --- | --- |
| xAI Responses pre-generation violation | USD 0.05 = 50,000 microdollars per applicable request | Observe the provider's fee outcome and reserve/settle it even when no generation tokens exist. Keep `unpricedCosts: [request_fee]`. |
| Tavily search | Basic: 1 credit/request; advanced: 2 | Normalize effective search depth, including automatic choices; verify returned usage. |
| Tavily extract | Basic: 1 credit/5 successful URLs; advanced: 2 | Bound successful URLs and qualify partial-batch rounding and extraction depth. |
| Tavily map | 1 credit/10 returned pages; 2 with instructions | Bound pages and qualify rounding and instruction mode. |
| Tavily crawl | Mapping plus extraction credits | Bound and observe both operations; a request count is insufficient. |
| Tavily pay-as-you-go | USD 0.008 = 8,000 microdollars/credit | Confirm the account uses this plan; monthly and enterprise rates differ. |
| Firecrawl scrape/crawl | 1 credit/page before options | Bound pages, PDFs and all requested modifiers. |
| Firecrawl map | 1 credit/call | Qualify success/failure billing and account credit value. |
| Firecrawl search | 2 credits/10 results, rounded upward; scraping costs extra | Bound results and every scraped page's modifiers. |
| Firecrawl scrape modifiers | PDF +1/page; JSON +4/page; ZDR +1/page | Other options stack too. These examples are not an exhaustive upper bound. |
| Perplexity legacy Sonar | No current whole-request tariff certified | Rewritten requests need the actual Agent API model/tool contract and measured charges. Do not restore an obsolete fee table. |

Tariff sources: [xAI](https://docs.x.ai/developers/pricing),
[Tavily](https://docs.tavily.com/documentation/api-credits),
[Firecrawl](https://docs.firecrawl.dev/billing),
[Perplexity](https://docs.perplexity.ai/docs/getting-started/pricing).

## Ownership and proof gates

Existing manifest source and central schema/compiler changes stay with the
existing-provider owner. Generic Worker runtime, client transport and new
capability adapters have separate owners. Integration regenerates snapshots
serially and verifies exact-head CI. Current pricing and catalog research must
not be used as a substitute for the cross-repository request/stream/usage proof.

No credentials, commercial accounts or production services were changed to
produce this checkpoint. No live upstream inference was performed. Remaining
model additions and runtime gates above are open work, not completed parity.
