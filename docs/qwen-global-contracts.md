# Qwen global standard frozen inventory

This source completes the finite standard-global roster selected by
[`buildQwenModelCatalogForBaseUrl`](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/qwen/models.ts).
That frozen function explicitly gives the full catalog to standard endpoints;
its Coding Plan branch filters standard-only cards. The manifest's default
Coding Plan base is not substituted for this existing PAYG route.

`qwen` retains `QWEN_API_KEY`, Bearer auth and
`https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`.
The [previously qualified global Chat reference](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)
checked on 2026-11-03 explicitly retains the old hosts. No workspace ID,
new region, account resource or credential fallback is inferred.

| Frozen native IDs | Source disposition |
| --- | --- |
| `qwen3.5-plus`, `qwen3.6-flash`, `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.8-max`, `qwen3.8-flash` | Native standard Chat |
| `MiniMax-M2.5`, `glm-5`, `kimi-k2.5` | Native standard Chat under original Qwen account |
| `qwen3-max-2026-01-23`, `qwen3-coder-next`, `qwen3-coder-plus`, `glm-4.7` | Known closed rows; no passthrough revival |

Per-model text/image declarations come from the
[frozen catalog](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/qwen/openclaw.plugin.json).
No context/output limit, reasoning default, tariff or underlying vendor account
entitlement is copied. A hosted MiniMax/GLM/Kimi ID keeps its Qwen credential.

Existing evidence for [notice 118344](https://www.aliyun.com/notice/118344) and
[118345](https://www.aliyun.com/notice/118345) records 2026-10-10 retirements for
the four closed names in the previously qualified China/plan scope. This slice
keeps them closed but does not promote that evidence into a new, globally
asserted shutdown date. Exact global product applicability remains a qualification
boundary before any revival or globally dated availability metadata. These
closed rows carry no executable facts, alias or price.

The previously recorded [118728 notice](https://www.aliyun.com/notice/118728)
schedules 3.5 Plus end of marketing on 2026-11-18 and service termination on
2027-01-19, not a shutdown on this source date. No automatic retirement timer
or cross-region scope is invented here. No Qwen Portal/OAuth grant is restored.

CN standard, global/CN Coding Plans and Token Plans retain distinct keys/origins.
The real Worker fixtures use original provider-scoped grants, preserve supplied
thinking/reasoning/tool history and split SSE arguments, and check inclusive
cached-token observations separately from a synthetic policy-fixed tariff.
Every active frozen ID uses both native/manifest JSON/SSE paths. Missing/revoked
credentials, wrong-product grants, unknown-price budgets, errors, cancellation
and the four closed identities are exercised without upstream calls.

Fixtures are PREPARED in a CODE-ONLY checkout, not locally executed. Source6
retains snapshot integration and final native consumer proof. This does not
claim current account eligibility, live authorization or whole-family parity;
other native APIs and client-owned thinking normalization keep their owners.
