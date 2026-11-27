# Capability provider qualification

Checked 2026-11-03. Native route availability, upstream billing, and end-to-end
client support are separate gates. An experimental manifest is not a parity badge.
The source inventory is OpenClaw commit
`b3aa84d0d79e3bfe7f2ef697fec3f5bf15b634fd`, under
[`extensions/`](https://github.com/openclaw/openclaw/tree/b3aa84d0d79e3bfe7f2ef697fec3f5bf15b634fd/extensions).
Paths below refer to that inventory; they establish implementation requirements,
not current provider prices. No live account entitlement is inferred.

## Search delivery

Brave, Exa and Parallel have experimental native search manifests. They accept
the provider's own query or JSON shape and return its response unchanged. They
have no synthetic language-model rows and no token tariff. The request counter
is router telemetry, not an upstream search-credit ledger. Unpriced reserve
budgets fail closed; an explicit fixed policy request cost is a policy charge,
not a promise about the provider's invoice. The existing runtime records
unmetered requests as `flat_fallback` with one micro-unit of router cost. That
legacy fallback is not an upstream tariff or measured provider charge.

| Provider | Native request | Source |
| --- | --- | --- |
| Brave | `GET /v1/native/brave/res/v1/web/search?q=...`; selected provider credential supplies `X-Subscription-Token` | [Web search](https://api-dashboard.search.brave.com/api-reference/web/search/get) |
| Exa | `POST /v1/native/exa/search`; `query`, `type`, `contents` remain native; selected credential supplies `x-api-key` | [Search](https://exa.ai/docs/reference/search) |
| Parallel | `POST /v1/native/parallel/v1/search`; `search_queries`, `objective`, `mode` remain native; selected credential supplies `x-api-key` | [Search](https://docs.parallel.ai/api-reference/search/search) |

Search fees depend on product, plan and options. No per-request number is
invented from result count. Separate extract, answer, agent and asynchronous
task APIs are not included by these search manifests. Client capability discovery
and a live credential-scoped result/usage probe remain separate integration gates.

The smoke plan sends a one-result query for Brave and Exa, and one basic Parallel
query with excerpts limited to 1,000 characters. Synthetic checks run the selected
manifest transport through the real Worker and verify caller-scoped usage. These
checks do not exercise the OpenClaw web-search consumer or certify live results.

## Remaining capability queue

Each row names the missing contract rather than claiming that a generic HTTP
route provides the entire integration. “Queued” means no implementation proof.

| Surface | Protocol and billing qualification | Disposition / next gate |
| --- | --- | --- |
| DuckDuckGo | OpenClaw `duckduckgo/src/ddg-client.ts` scrapes HTML. This is not a supported JSON web-search API. Absence of an API charge does not establish availability or permission. | Needs a bounded HTML adapter, challenge/rate-limit handling and service-use qualification. Do not substitute Instant Answers for web search. |
| SearXNG | Operator-selected instance and JSON search; reachability, enabled output formats, engine policy and operating cost belong to that instance. | Needs an approved HTTPS instance or authenticated host bridge, not a public hard-coded instance or an edge loopback URL. |
| Azure Speech | Regional SSML/XML synthesis to binary audio; character/model/region tariff. | Requires non-JSON request handling, region-bound credentials and character admission. Separate product from Azure OpenAI; queued. |
| Microsoft/Edge speech | Consumer read-aloud WebSocket protocol in `microsoft/speech-provider.ts`, not Azure's commercial API. | Requires native session/auth/stream contract and service-use qualification; no Azure alias or API-key badge. |
| ElevenLabs | JSON text-to-speech with voice path and binary output; multipart transcription; realtime WebSocket transcription. Character/credit and audio-duration costs differ. | Synchronous TTS can be isolated; multipart/realtime and authoritative credit accounting remain separate gates. Queued. |
| Fish Audio | Native speech formats and streaming; voice/model-specific billing. | Qualify exact request encoding and response framing before implementing; no OpenAI speech alias. Queued. |
| Gradium | Native speech stream protocol; audio output and duration accounting. | Qualify stream framing, auth, terminal usage and cancellation; queued. |
| Inworld | Native JSON voice streaming; Basic API authorization; character/model billing. | Qualify frame versus raw-audio output and terminal usage; queued. |
| Deepgram | JSON URL or binary audio transcription and realtime audio WebSockets; model/options/channel duration costs. | JSON URL transcription can be isolated; binary uploads, realtime and duration billing remain separate gates. Queued. |
| SenseAudio | Audio transcription at its native regional API; multipart request and duration/model pricing. | Requires multipart transport plus explicit model and duration evidence; queued. |
| Voyage | Native `/v1/embeddings`, batch and other embedding products; text embeddings report input-only `usage.total_tokens`. | Shared usage normalization and aggregate input bounds required before priced embeddings. Do not label it Chat. [API](https://docs.voyageai.com/reference/embeddings-api). |
| comfy | Local workflow submission/history/assets or distinct Comfy Cloud contract. Workflows depend on installed nodes, models and filesystem assets; local GPU time is not an API tariff. | Host bridge/workflow qualification and scoped job ownership required. `/interrupt` affects the current workflow, not an arbitrary caller-owned job. [Server routes](https://docs.comfy.org/development/comfyui-server/comms_routes). |
| fal | Native synchronous inference and asynchronous queue submission/status/result/cancel. Output-unit or runtime pricing depends on endpoint. | Queue requires owner-bound controls and terminal settlement; no async parity until the lifecycle gate below passes. [Queue API](https://fal.ai/docs/documentation/model-apis/inference/queue). |
| kie | `kie/video-generation-provider.ts`: createTask/recordInfo plus a separate upload host; model/credit pricing. | Requires task ownership, upload trust boundary, terminal output/error handling and qualified cancellation semantics. Queued. |
| vydra | `vydra/shared.ts`: model-specific submission, job polling and asset downloads; `speech-provider.ts` is distinct. | Requires pinned job/credential ownership, terminal settlement and qualified cancel support; speech can be isolated. Queued. |
| Alibaba Wan | DashScope regional asynchronous video tasks and assets; model/resolution/duration pricing. | Coordinate product credentials with the Qwen owner before edits; task lifecycle and regional billing required. Queued. |
| PixVerse | Region-specific native video API, job polling and assets; model/quality/duration credits. | Requires per-request provider headers, region-bound credentials and task lifecycle; queued. |
| Runway | Versioned text/image/video task creation and task controls; credits depend on output/model. | Requires version-header contract, task ownership and terminal cost evidence; queued. |
| SubQ | `subq/src/runtime.ts`: native `/v1/systemone` decision contract. | Typed decision input/output, model entitlement and billing required; no fabricated OpenAI Chat/Decisions compatibility. Queued. |

## Shared-owner requests

Existing provider manifests stay with their owner. The following additions need
native protocol fixtures, endpoint-specific capability exposure and current price
evidence before being marked complete:

- Firecrawl Search/crawl/map and Tavily map: credit usage and option-dependent fees.
- Perplexity Search: native search request fees separate from Sonar generation.
- Google, xAI and DeepSeek search: native hosted-tool usage, not standalone search aliases.
- Groq, Mistral, Google and xAI speech/transcription: binary/multipart, realtime,
  terminal usage and native client compatibility where applicable.
- Google and Bedrock embeddings, plus new hosted/local model providers: native
  embedding shape, aggregate input limits and input-only settlement.
- Google, OpenRouter, Together, xAI, MiniMax and Replicate media: product-specific
  media units, async controls and terminal accounting. Replicate official-model
  create/cancel routes do not solve credential ownership or runtime billing alone.

Shared runtime must normalize Voyage input-only usage without inventing output
tokens, and support provider-specific binary/multipart or framed-stream contracts
before those surfaces are advertised. Shared schema/compiler and integration
owners maintain provider-count checks and regenerate runtime snapshots serially.

## Async media gate

Submission, polling and cancellation must share a durable binding of caller,
policy, credential lineage, provider, endpoint and upstream job ID. Re-selecting
a pooled credential for a later poll is unsafe and can make a valid job invisible.
Opaque provider URLs must not become arbitrary authenticated fetch destinations.
Asset retrieval needs its own origin, size, redirect and credential rules.

HTTP cancellation stops the router request; it does not prove upstream job
cancellation. A cancel acknowledgement does not prove zero upstream charge.
Queue admission is not generation completion. Polling must preserve failures,
timeouts, caller aborts and terminal states without duplicate settlement. Reserve
budgets need an enforceable job-cost ceiling before submission and exactly-once
terminal charging. A request counter or estimated duration cannot certify runtime
cost. No generic async media lifecycle currently satisfies this gate here; its
shared runtime owner must provide the contract before dependent manifests land.

## Local and external boundaries

Local CLI TTS and Comfy local workflows execute on a host with installed binaries,
models, filesystem access and a reachable private runtime. An edge Worker cannot
acquire those capabilities by pointing a manifest at localhost. A bridge needs
authenticated caller isolation, asset access rules, cancellation ownership,
resource limits and an explicit accounting policy. ONNX and other local decision
engines remain with the local/decision owner; no HTTP compatibility badge replaces
their native execution contract.

Neon, Liquid Inference, llmman, ds4, Poolside, Telnyx and Claude Max API Proxy are
documented custom/external services in the campaign inventory, not missing bundled
capability plugins. Keep them classified as external pending a named supported
contract, endpoint, credential owner and billing evidence. Internal qa-lab-search
and test plugins are excluded from production integration.
