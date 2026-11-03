# Hosted gateway routes

These experimental routes use each gateway's own API key and Chat Completions
endpoint. Vercel also exposes native Messages and model discovery. Primary
documentation was checked on 2026-11-03. Live provider qualification remains
separate from deterministic Worker proof.

| ID | Key binding | Base URL | Bundled upstream model |
| --- | --- | --- | --- |
| `kilocode` | `KILOCODE_API_KEY` | `https://ai-gateway.kilo.ai/api/v1` | `anthropic/claude-sonnet-4.6` |
| `requesty` | `REQUESTY_API_KEY` | `https://router.requesty.ai/v1` | `openai/gpt-6-luna` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` | `https://ai-gateway.vercel.sh/v1` | `anthropic/claude-sonnet-4.6` |
| `opencode` | `OPENCODE_API_KEY` | `https://opencode.ai/inference/openai/v1` | `glm-5.3` |
| `opencode-go` | `OPENCODE_GO_API_KEY` | `https://opencode.ai/inference/go/openai/v1` | `glm-5.3` |

Each appends `/chat/completions`. Unified model IDs prepend the gateway ID to the
upstream ID; native `/v1/native/<id>/chat/completions` calls retain upstream model
names. Unknown names remain opaque and unpriced. Direct lab keys and another
gateway's credentials are never fallbacks. Store any BYOK credentials at the
gateway using its separate authorized management workflow.

## Credential and endpoint distinctions

- Kilo's current primary documentation uses `ai-gateway.kilo.ai/api/v1`, rather
  than the older `api.kilo.ai/api/gateway` declaration in OpenClaw. Its examples
  call the key variable `KILO_API_KEY`; bind that API credential explicitly to
  `KILOCODE_API_KEY` here. Short-lived organization tokens need an organization
  header and refresh lifecycle; this manifest does not implement those tokens,
  anonymous access or BYOK management.
- Requesty uses its global endpoint. EU routing also requires qualified model
  placement; it is not inferred from a global key. A bare model name can select
  a managed policy. The bundled name pins its provider namespace. Custom
  `policy/` names and gateway-level fallback still require account qualification.
- Vercel uses the OpenAI-compatible and Anthropic Messages APIs, not the AI SDK's wire protocol.
  `VERCEL_OIDC_TOKEN` is not read as a substitute for `AI_GATEWAY_API_KEY`.
  OIDC refresh and team/project binding and Responses are separate
  contracts. Provider-native keys are not Vercel gateway keys.
- OpenCode Console and Go are separate products. Go requires subscription
  entitlement; an API key does not prove a plan or remaining quota. Configure
  each selected product's credential explicitly. No automatic fallback to
  Console charges occurs when Go rejects a request. Neither reads
  `OPENCODE_ZEN_API_KEY` as an implicit alias. These routes use current inference
  paths, not legacy Zen paths. Models use different API families: only documented
  Chat models belong here. Claude/Qwen Messages, GPT Responses and Gemini native
  routes are not advertised. Console free-tier models can reject external
  clients even with a valid key.

Gateway prices depend on routing, BYOK, tiers and plans. No tariff is inferred
from a direct lab's prices. Hard-budget requests need an explicit fixed policy
request price; unmetered policies can use these routes. Policy charges are not
authoritative upstream costs. Live streaming usage, tools/reasoning, entitlement,
cancellation and whole-request settlement remain unqualified.

## Vercel frozen native continuation

OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/vercel-ai-gateway/openclaw.plugin.json`, defaults to
`anthropic-messages` with a refreshable catalog and no static model list.
The existing Chat seed is retained; no newer vendor model generation is added.

`POST /v1/native/vercel-ai-gateway/v1/messages` and
`POST /v1/proxy/vercel-ai-gateway/messages` dispatch to
`https://ai-gateway.vercel.sh/v1/messages` with the selected gateway key.
Native names retain their provider prefix. Messages, signed and redacted
thinking, tool use/results, system cache controls and the caller's Anthropic
version/beta headers pass through unchanged. Caller API-key headers cannot
replace the selected gateway credential.

The new real Worker/SQLite fixtures cover JSON and fragmented SSE on both
routes, fixed-price reservation/settlement, error events, cancellation and
pre-egress policy/unknown-price rejection. Transport cancellation does not
prove upstream execution stopped. Missing token usage remains unknown;
fixed policy charges do not establish the upstream gateway bill.

`GET /v1/native/vercel-ai-gateway/models` and the `models_list` manifest endpoint
expose the documented OpenAI-shaped `/v1/models` inventory, filtered to the
caller's model policy. This is discovery on demand, never a foreground catalog
lookup during inference. The vendor's public catalog does not prove team
entitlement. Team availability query annotations need a separately qualified
query contract; they are not enabled by relaxing existing discovery validation.
Upstream pricing/reasoning fields remain metadata and do not become trusted
router tariffs or static capability claims.

Generated snapshot integration needs its assigned serial slot. The format-based
discovery dependency is tracked by
[PR538](https://github.com/openclaw/clawrouter/pull/538). Actual OpenClaw consumer
acceptance and live entitlement remain distinct proof stages.

## Primary references

- [Kilo gateway](https://kilo.ai/docs/gateway)
- [Kilo authentication](https://kilo.ai/docs/gateway/authentication)
- [Kilo model IDs](https://kilo.ai/docs/gateway/models-and-providers)
- [Requesty quickstart](https://docs.requesty.ai/quickstart)
- [Vercel APIs](https://vercel.com/docs/ai-gateway/sdks-and-apis)
- [Vercel authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok)
- [Vercel Messages](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api)
- [Vercel streaming](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api/streaming)
- [Vercel dynamic catalog](https://vercel.com/docs/ai-gateway/models-and-providers)
- [OpenCode inference](https://opencode.ai/v2/docs/console/api/inference/)
- [OpenCode Go](https://opencode.ai/v2/docs/console/go/)
