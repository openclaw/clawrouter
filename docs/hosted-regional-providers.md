# Hosted provider names and product boundaries

These experimental routes expose Chat Completions and SSE. Primary references
were checked on 2026-11-03. No live upstream inference qualifies this batch.

| Provider | Credential binding | Base URL | Initial upstream model |
| --- | --- | --- | --- |
| `gmi` | `GMI_API_KEY` | `https://api.gmi-serving.com/v1` | `deepseek-ai/DeepSeek-V4-Pro` |
| `novita` | `NOVITA_API_KEY` | `https://api.novita.ai/openai/v1` | `stepfun/step-3.7-flash` |
| `longcat` | `LONGCAT_API_KEY` | `https://api.longcat.chat/openai/v1` | `LongCat-2.5` |
| `xiaomi` | `XIAOMI_API_KEY` | `https://api.xiaomimimo.com/v1` | `mimo-v2.6-pro` |

All append `/chat/completions` and use Bearer authentication. Native requests
use `/v1/native/<provider>/chat/completions` and the full upstream model ID.
Unified requests prepend `<provider>/` to that ID. Stored grants remain scoped
to the canonical provider; environment fallback reads only its listed binding.

`gmi-cloud` and `gmicloud` are native/model routing aliases of `gmi`; `novita-ai`
and `novitaai` alias `novita`. They do not create additional provider families,
credential stores or catalog rows. Use canonical IDs in policies and grants.

## Qualification limits

- GMI's hosted API differs from dedicated endpoints, Agentbox, and deployment
  management. Messages and Responses need separate qualification.
- Novita's reference specifies `/openai/v1/chat/completions`. Some older examples
  use `/v3/openai`; this manifest does not combine those path contracts. Media,
  serverless deployments and account-specific model access are separate work.
- LongCat's current quickstart lists `LongCat-2.5`, while its older Chat reference
  still names text-only `LongCat-2.0`. The endpoint agrees; model-specific tool,
  vision and limit facts remain unset until independently qualified. Responses,
  Messages and token-pack accounting are not implied by this route.
- Xiaomi PAYG uses the standard host and its own API key. Token Plan uses dedicated
  regional hosts (`token-plan-cn`, `token-plan-sgp`, `token-plan-ams`) and distinct
  credentials; individual/team plan keys must not be substituted into PAYG.
  Batch inference, Responses, Messages, speech and desktop membership are separate
  products. This manifest never reads `XIAOMI_TOKEN_PLAN_API_KEY`.

No prices, model capability badges or reasoning-effort conversions are inferred.
Opaque model passthrough is unpriced. Hard budgets require an explicit policy
fixed request price; unmetered policies can use these routes. A fixed router
charge is not measured upstream cost. Live access, tool/reasoning replay,
stream-terminal usage, entitlement and monetary settlement remain proof gates.

## Primary references

- [GMI developer API](https://www.gmicloud.ai/en/developers)
- [Novita Chat reference](https://docs.novita.ai/api-reference/model-apis-llm-create-chat-completion)
- [Novita Step model](https://blogs.novita.ai/fr/step-3-7-flash-api-quick-start/)
- [LongCat current quickstart](https://longcat.chat/platform/docs)
- [LongCat Chat reference](https://longcat.chat/platform/docs/api/chat.html)
- [Xiaomi first call and credential types](https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call)
