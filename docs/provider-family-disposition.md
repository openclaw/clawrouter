# Provider family disposition

This ledger accounts for all **54 missing canonical families** in the frozen
OpenClaw inventory at
[`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`](https://github.com/openclaw/openclaw/tree/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions).
The comparison with `b3aa84d0d79e3bfe7f2ef697fec3f5bf15b634fd` adds Particle
only. Aliases, endpoint regions, auth methods and plan variants are not extra
families. Implementation batches started from ClawRouter
`8833ed747cbcf521aa8139c234de286126e29f30`.

**State:** 34 families have experimental Chat transport implementations in the
linked PR queue; 16 have the exact dependencies below; four media families have
a separate implementation owner. These counts are not a parity certification.
Draft PRs need serial current-main snapshot integration, focused tests, all
manifest validation and exact final-head CI. No live proof is claimed here.

## Hosted inference: 24

All rows implement API-key Chat Completions/SSE only. No native capability facts,
prices, tool/reasoning acceptance, terminal usage or cancellation proof are
inferred from a model row. Unknown model names remain unpriced. Hard budgets
need an explicit policy fixed request price; that is not upstream cost parity.

| Family | Implemented route / ID | Qualification boundary | Source PR |
| --- | --- | --- | --- |
| abliteration | `abliteration`, current Large v2 Chat | Other models, Messages, Responses, policies and server tools separate | [394](https://github.com/openclaw/clawrouter/pull/394) |
| arcee | `arcee`, Trinity Mini | Quickstart lists this ID; account availability and wider inventory unqualified | [385](https://github.com/openclaw/clawrouter/pull/385) |
| baseten | `baseten`, hosted inference | Dedicated deployments are separate endpoints/contracts | [378](https://github.com/openclaw/clawrouter/pull/378) |
| cerebras | `cerebras`, hosted API | Current example model does not establish full inventory | [378](https://github.com/openclaw/clawrouter/pull/378) |
| chutes | `chutes`, API-key LLM endpoint | OAuth, serverless lifecycle and dynamic pricing separate | [385](https://github.com/openclaw/clawrouter/pull/385) |
| deepinfra | `deepinfra`, OpenAI API | Native inference, deployments, embeddings/media separate | [378](https://github.com/openclaw/clawrouter/pull/378) |
| featherless | `featherless`, Chat | Model availability and terminal monetary usage need live proof | [385](https://github.com/openclaw/clawrouter/pull/385) |
| gmi | `gmi`; routing aliases `gmi-cloud`, `gmicloud` | Aliases share one canonical provider/grant identity | [389](https://github.com/openclaw/clawrouter/pull/389) |
| longcat | `longcat`, LongCat 2.5 | Published examples differ by page; no inherited native facts | [389](https://github.com/openclaw/clawrouter/pull/389) |
| meta | `meta`, Model API | Chat does not replay reasoning across turns; Responses/Messages separate | [394](https://github.com/openclaw/clawrouter/pull/394) |
| moonshot | `moonshot`, global standard API | Kimi Coding is the distinct `kimi` family below | [373](https://github.com/openclaw/clawrouter/pull/373) |
| novita | `novita`; routing aliases `novita-ai`, `novitaai` | One canonical provider; media jobs separate | [389](https://github.com/openclaw/clawrouter/pull/389) |
| nvidia | `nvidia`, hosted API Catalog endpoint | Self-hosted NIM deployment and GPU runtime separate | [378](https://github.com/openclaw/clawrouter/pull/378) |
| particle | `particle`, global API | Catalog `particle-ai/particle-1` maps to request `particle-1`; US placement and WebSocket steering separate | [394](https://github.com/openclaw/clawrouter/pull/394) |
| qianfan | `qianfan`, mainland v2 Bearer API | Published ERNIE 4.5 0.3B smoke ID; entitlement, legacy AK/SK, international and coding plans separate | [392](https://github.com/openclaw/clawrouter/pull/392) |
| qwen | `qwen`, Singapore compatible endpoint | qwencloud/modelstudio/dashscope naming does not merge regional, OAuth or token-plan credentials | [373](https://github.com/openclaw/clawrouter/pull/373) |
| stepfun | `stepfun`, global standard API | Mainland and step-plan endpoints separate | [392](https://github.com/openclaw/clawrouter/pull/392) |
| synthetic | `synthetic`, OpenAI base | Moving `syn:` alias; subscription quotas, Messages and search separate | [394](https://github.com/openclaw/clawrouter/pull/394) |
| tencent | `tencent-tokenhub`, mainland TokenHub | TokenPlan, regional TokenHub and native Hunyuan separate | [392](https://github.com/openclaw/clawrouter/pull/392) |
| venice | `venice`, Chat API | Model privacy/mode differences and other APIs need separate evidence | [385](https://github.com/openclaw/clawrouter/pull/385) |
| volcengine | `volcengine`, Beijing standard Ark | Distinct from BytePlus; coding-plan paths and credentials separate | [392](https://github.com/openclaw/clawrouter/pull/392) |
| byteplus | `byteplus`, Singapore standard Ark | No shared ARK-key fallback to mainland Volcengine | [392](https://github.com/openclaw/clawrouter/pull/392) |
| xiaomi | `xiaomi`, standard API | Regional token-plan credentials/endpoints separate | [389](https://github.com/openclaw/clawrouter/pull/389) |
| zai | `zai`, global standard API | Mainland and Coding Plan paths/credentials separate | [373](https://github.com/openclaw/clawrouter/pull/373) |

Each implementation PR includes its checked primary endpoint/model references,
credential binding, exact product boundary and focused contract tests. Those
references qualify the transport declaration, not an account's live entitlement.

## Gateways: eight

| Family | Disposition | Exact remaining dependency |
| --- | --- | --- |
| bifrost | Configured authenticated Chat transport, [406](https://github.com/openclaw/clawrouter/pull/406) | Reachable operator gateway, version-correct `/openai` base and configured model; async jobs, management and runtime excluded |
| kilocode | Hosted Chat transport, [397](https://github.com/openclaw/clawrouter/pull/397) | Current primary endpoint replaces old static declaration; organization-token expiry/header binding and BYOK management separate |
| litellm | Configured authenticated Chat transport, [406](https://github.com/openclaw/clawrouter/pull/406) | Reachable gateway, own virtual key and model alias; no local zero-price assumption, OIDC/management/runtime excluded |
| opencode | Console Chat transport, [397](https://github.com/openclaw/clawrouter/pull/397) | Paid Chat-family models only; Messages/Responses/Gemini and external free-tier restrictions separate |
| opencode-go | Distinct Go Chat transport, [397](https://github.com/openclaw/clawrouter/pull/397) | Explicit subscription credential and entitlement; no fallback to Console billing |
| requesty | Global Chat transport, [397](https://github.com/openclaw/clawrouter/pull/397) | Managed policies, EU placement, BYOK and live tariffs need account qualification |
| vercel-ai-gateway | API-key OpenAI Chat transport, [397](https://github.com/openclaw/clawrouter/pull/397) | AI SDK native protocol, OIDC refresh, team/project identity and other APIs separate |
| radius | **Blocked: native Pi protocol** | R01 below; no Chat manifest or OpenRouter credential substitution |

## Enterprise: three

| Family | Disposition | Exact remaining dependency |
| --- | --- | --- |
| amazon-bedrock-mantle | US East API-key `/v1` Chat subset, [401](https://github.com/openclaw/clawrouter/pull/401) | IAM bearer generation/refresh, regional discovery, per-model `/openai/v1` routes and other APIs separate from existing Bedrock SigV4 Invoke |
| anthropic-vertex | **Blocked: Google identity and resource binding** | E01 below; not Anthropic API-key auth or Google AI Studio |
| microsoft-foundry | Configured resource/deployment API-key Chat subset, [401](https://github.com/openclaw/clawrouter/pull/401) | Entra refresh/audience/tenant selection, deployment discovery, Anthropic and MAI image routes separate |

## Media: four, separate owner

| Family | Disposition | Acceptance boundary |
| --- | --- | --- |
| comfy | Media lane owns implementation | Workflow/node execution, reachable server and lifecycle; no Chat claim |
| fal | Media lane owns implementation | Submit/poll/cancel and owner-bound settlement; no generic synchronous badge |
| kie | Media lane owns implementation | Provider job identity, credentials and terminal billing |
| vydra | Media lane owns implementation | Provider job identity, credentials and terminal billing |

The model-family lane does not edit these products. Their separate manifests
and proof must be linked by the campaign integration owner before completion.

## Subscription and bridges: three

| Family | Disposition | Exact remaining dependency |
| --- | --- | --- |
| github-copilot | **Blocked: account/enterprise auth route** | S01 below; no static generic GitHub-token endpoint |
| copilot-proxy | **Blocked: operator host bridge** | S02 below; `localhost:3000/v1` belongs to the machine running the bridge |
| kimi | Overseas Coding Plan Chat subset, [401](https://github.com/openclaw/clawrouter/pull/401) | Separate `KIMI_CODING_API_KEY`; mainland, plan quotas, login, Responses/Messages and CLI runtime unqualified |

## Local engines: seven

HTTP compatibility is not native runtime parity. Existing `local-openai` can
carry an explicitly reachable compatible Chat service; it does not install a
model, discover hardware, load weights or control a process. Its zero API-charge
assumption must not be reused for cloud or paid gateway products.

| Family | Frozen native contract | Disposition / exact blocker |
| --- | --- | --- |
| apple-fm | `native.ts` compiles `AppleFoundationModels.swift` with the macOS 27 SDK and runs its helper | **L01:** Worker has no Apple framework, native compiler or device state; needs an authenticated host bridge and availability/tool/stream fixtures |
| llama-cpp | `src/managed-server.ts`, installer and hardware modules own GGUF/model assets and llama-server | **L02:** Worker cannot install binaries, load local weights or own GPU/CPU process lifecycle; host executor plus model/discovery/cancellation boundary required |
| lmstudio | `src/chat.ts` selects native Messages versus schema-enforcing Chat; discovery identifies installed models | **L03:** Reachable LM Studio host, model-load/auth discovery and transport-specific reasoning/schema tests required; generic Chat loses native semantics |
| ollama | Native `/api/chat`, NDJSON, discovery, embeddings and node inference; separate `ollama-cloud` credentials | **L04:** Native NDJSON/tool/usage and host/node transport required; local/cloud auth isolation and cancellation need fixtures |
| omlx | Apple Silicon service, `/v1/models`, Chat and memory embedding registration; oMLX owns model lifecycle | **L05:** Reachable host plus exact discovery/embedding contract; an edge Chat route does not provide MLX or model lifecycle |
| sglang | Provider discovery/setup at loopback port 30000 | **L06:** Reachable serving host and discovered model facts; GPU/server lifecycle remains with operator |
| vllm | Provider discovery/setup at loopback port 8000 | **L07:** Reachable serving host and discovered model facts; GPU/server lifecycle remains with operator |

Source paths in this table refer to each family's directory at the frozen
[extensions revision](https://github.com/openclaw/openclaw/tree/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions).
No local host, tunnel or runtime is provisioned by this campaign slice.

## Decisions: four

| Family | Frozen wire/runtime contract | Disposition / exact blocker |
| --- | --- | --- |
| levanto | Sage `/decide` and `/decide/batch`; `content`, typed question(s), calibrated answer/abstention and reasoning metadata | **D01:** Native Sage codec, bounded batch/image validation, usage mapping and Decision V2 client/catalog registration; not OpenAI Decisions |
| liquid-ai | `https://api.liquid.ai/decisions/v1/systemone`, typed questions and provider-specific result decoding | **D02:** Liquid System One codec, supported input/question limits and usage mapping; prepared Decision V2 consumer and protocol metadata required |
| onnx | `onnxruntime-node` InferenceSession/Tensor, model artifact loader and child worker process | **D03:** Native host executor, pinned model assets/adapters, deadlines and typed result transport; cannot run this Node native module/process in the Worker |
| typesafe | Hosted `/v1/systemone` Jev; separately configured local Kev without inherited hosted auth | **D04:** System One codec, model discovery, hosted/local credential isolation and Decision V2 client/catalog bridge; local executor remains operator-owned |

The schema allows a string wire-format name, so a raw proxy manifest could
compile. That would not provide these codecs or certify the consumer contract.
ClawRouter's decision capability metadata currently declares only
`openai-decisions` in `shared/native-capabilities.ts` and the compiler validates
that declaration against `openai.decisions`. The smoke harness has no native
Sage/System One request template. These shared contracts need their source
owners before provider-specific adapters can be exposed as usable offers.

TypeSafe's frozen README also identifies the prepared Decision V2 host/plugin
release dependency; an older package's installation floor does not prove V2
compatibility. Do not copy static zero-output-price claims into router tariffs.

## Agent runtime: one

| Family | Disposition | Exact blocker |
| --- | --- | --- |
| codex | **A01: native runtime remains host-owned** | App Server stdio/WebSocket, threads/turns, approvals, filesystem/process tools, paired-host session ownership and cancellation are not an inference API. Existing OpenAI/ChatGPT transport cannot supply those semantics. |

## Dependency acceptance

- **R01, Radius:** frozen `extensions/radius/stream.ts` sends `{model, context,
  options}` to `/messages`, consumes Pi `text_*`, `thinking_*`, `toolcall_*` and
  terminal `done`/`error` events. `catalog.ts` loads `/config` with constrained
  origin selection. Implement bounded native event/usage observation, dynamic
  catalog authorization and API-key/OAuth lifecycle before advertising parity.
  Runtime, catalog and integration owners must cover malformed/unfinished tools,
  cancellation, missing terminal usage and credential-scoped discovery. The
  [official service docs](https://radius.earendil.com/docs) describe Pi-native
  services; OpenRouter backing does not make Radius an OpenRouter wire alias.
- **E01, Vertex:** frozen `extensions/anthropic-vertex/stream-runtime.ts` uses
  `GoogleAuth` with cloud-platform scope and `AnthropicVertex`; region/project
  selection belongs to the resource. Implement renewable Google credential
  materialization and project/region/publisher route binding under the runtime
  owner's contracts, then native Anthropic request/stream fixtures. Do not reuse
  Anthropic API keys or AI Studio credentials.
- **S01, Copilot:** frozen `runtime-auth.ts` reads account metadata, validates
  the returned API origin against the selected GitHub/enterprise domain, then
  sends the original GitHub token. It explicitly does not use the retired
  `/v2/token` exchange. Device/enterprise-device login, model endpoint selection,
  entitlement and subscription accounting need an owner-bound auth lifecycle
  and fixtures before a router credential contract is offered.
- **S02 and L01–L07, host bridges:** require a named reachable host, its explicit
  authentication/trust boundary, model identity and supported operations. Keep
  host installation/loading, readiness, cancellation and cleanup authority
  separate from edge inference. A localhost default is not a deployed bridge.
- **D01/D02/D04, hosted decisions:** provider-specific adapters stay with the
  family owner; shared metadata/schema, Worker accounting and OpenClaw Decision
  V2 registration stay with their source owners. Integration must run the real
  `decision_evaluate` consumer through the Worker, validate typed results,
  rejection/abstention, stale/denied offers, caller cancellation and no secret
  fallback. [TypeSafe's primary API](https://api.typesafe.ai/redoc) documents
  System One, and [Levanto's primary model page](https://levanto.ai/model)
  documents Sage; neither is an OpenAI Decisions alias.
- **D03/A01, native execution:** a host bridge must retain model/session/approval
  ownership and enforce bounded operations. ONNX Web/WASM would be a new backend
  requiring model/operator qualification, not parity with `onnxruntime-node`.
  Codex inference routing must not be presented as native tools or supervision.

These are implementation dependencies, not requests to provision credentials,
change accounts, deploy production or install extra dependency trees. Every
exposed API still needs account-safe live evidence separately from deterministic
tests. No deployment or runtime mutation is performed by this ledger.
