# Regional platform Chat APIs

These experimental standard APIs expose Chat Completions and SSE. References
were checked on 2026-11-03; live upstream inference remains unqualified.

| Provider | Key binding | Base URL | Bundled upstream model |
| --- | --- | --- | --- |
| `qianfan` | `QIANFAN_API_KEY` | `https://qianfan.baidubce.com/v2` | `ernie-4.5-0.3b` |
| `stepfun` | `STEPFUN_API_KEY` | `https://api.stepfun.ai/v1` | `step-3.7-flash` |
| `tencent-tokenhub` | `TOKENHUB_API_KEY` | `https://tokenhub.tencentmaas.com/v1` | `deepseek-v4-flash` |
| `volcengine` | `VOLCANO_ENGINE_API_KEY` | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-2-1-pro-260915` |
| `byteplus` | `BYTEPLUS_API_KEY` | `https://ark.ap-southeast.bytepluses.com/api/v3` | `dola-seed-2-1-turbo-260628` |

Each appends `/chat/completions` and uses Bearer API-key auth. Native calls use
`/v1/native/<provider>/chat/completions` with the full upstream model ID. Unified
calls prepend the provider to that ID. Stored API-key grants are provider-scoped.
Unknown models and account-specific deployment IDs pass through without inferred
prices or native model facts. Qianfan bundles the published ERNIE 4.5 0.3B request ID for deterministic smoke
planning; account entitlement and current availability still require live proof.

## Region, plan and credential boundaries

- Qianfan v2 API keys are distinct from legacy access-token endpoints, AI Studio
  access tokens, Coding Plan and international Qianfan endpoints. AK/SK exchange,
  signing and model entitlement are not implemented by this Bearer manifest.
- StepFun uses the global `.ai` standard API. Mainland `.com` and `/step_plan/v1`
  subscription routes require their own region and plan selection. Neither plan
  quota accounting nor native thinking-level conversion is inferred.
- `tencent-tokenhub` represents the Tencent family on its documented mainland
  TokenHub endpoint. TokenPlan uses separate credentials and plan endpoints;
  `TOKENPLAN_API_KEY` is never a fallback. Singapore/US TokenHub hosts and native
  Hunyuan APIs remain separate qualification work.
- Volcengine Beijing and BytePlus Singapore retain different IDs and key bindings.
  Neither reads a shared `ARK_API_KEY`. `/api/coding/v3` and newer plan endpoints
  are not aliases of standard `/api/v3`; plan contracts require separate evidence.
  Access-key signing/exchange, batch, Responses, server tools, speech, media and
  agent-session products are not implied by standard Chat compatibility.

No rate cards are bundled. Hard-budget requests need an explicit policy fixed
request price; unmetered policies can use the routes. Fixed router charges are
not authoritative upstream cost. Live tools/reasoning replay, streaming usage,
entitlement and whole-request monetary settlement remain proof gates. A route or
successful compiler result alone does not establish full provider parity.

## Primary references

- [Qianfan v2 API](https://ai.baidu.com/ai-doc/WENXINWORKSHOP/4mchtzl8s)
- [Qianfan model discovery](https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y)
- [StepFun global API](https://platform.stepfun.ai/)
- [StepFun model example](https://www.stepfun.com/)
- [Tencent TokenHub DeepSeek API](https://cloud.tencent.com/document/product/1823/132248)
- [Volcengine standard text generation](https://docs.volcengine.com/docs/ark/text-generation?lang=en)
- [BytePlus standard streaming](https://docs.byteplus.com/en/docs/modelark/streaming-output?redirect=1)
