# Qwen Token Plan: frozen product and regional bindings

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/qwen/openclaw.plugin.json` and its Token Plan catalog. Primary
contracts checked 2026-11-03. This change implements Chat transport for the
frozen Token Plan product; standard Qwen and Coding Plan remain distinct.

| Router ID | Server credential binding | Fixed upstream base |
| --- | --- | --- |
| `qwen-token-plan` | `QWEN_TOKEN_PLAN_API_KEY` | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| `qwen-token-plan-cn` | `QWEN_TOKEN_PLAN_CN_API_KEY` | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |

The original frozen ID selects Singapore explicitly. The additional `-cn` ID
selects Beijing within the same Qwen family. Each appends `/chat/completions`.
The native route is `/v1/native/<id>/chat/completions`; the manifest route is
`/v1/proxy/<id>/chat_completions`. Native model names remain unchanged; manifest
model IDs prepend the selected router ID.

Bind a dedicated Token Plan credential from the selected account and region.
A provider-scoped grant stays with that region and policy. Standard Qwen,
DashScope, Coding Plan, QwenCloud and the other region's credentials are never
fallbacks. A caller cannot choose an upstream host or switch billing products.
A rejected or exhausted plan does not retry pay-as-you-go or another region.
Personal subscriptions and team seats remain separately billed accounts;
configure each member's own credential under that member's policy, never a
shared seat. A key's presence does not prove entitlement or remaining Credits.

[Alibaba's personal-plan guide](https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-quick-start)
describes `sk-sp-` keys, while the official
[Qwen Code ModelStudio Token Plan contract](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)
explicitly has no prefix requirement. The router therefore does not infer a
product, region or entitlement from a secret prefix. The selected provider and
its explicit server binding determine the destination. QwenCloud's newer
`qwencloudapi.com` endpoints are not silent aliases of these frozen endpoints.

## Finite model disposition

All seven frozen IDs remain listed in the current
[Singapore team catalog](https://www.alibabacloud.com/help/en/model-studio/token-plan-team-overview)
and [Beijing team catalog](https://help.aliyun.com/zh/model-studio/token-plan-team-overview).
They are distinct, unpriced Chat cards; an account's actual entitlement still
controls access. No newer models, native context limits or tariffs are inferred.

| Frozen upstream ID | Current documented eligibility |
| --- | --- |
| `qwen3.7-plus` | Team catalogs and Singapore Personal catalog |
| `qwen3.8-max` | Team catalogs and Singapore Personal catalog |
| `qwen3.8-flash` | Team catalogs and Singapore Personal catalog |
| `qwen3.6-plus` | Team catalogs; absent from current Singapore Personal list |
| `kimi-k2.5` | Team catalogs; absent from current Singapore Personal list |
| `glm-5` | Team catalogs; absent from current Singapore Personal list |
| `MiniMax-M2.5` | Team catalogs; absent from current Singapore Personal list |

Absence from the [Personal list](https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-overview)
is not a retirement claim. No model is silently rewritten to a newer model.
Restrict the policy model list to the selected account's approved inventory.
Unknown models can pass through with explicit policy permission and unknown
pricing; this does not manufacture a native capability card.

Credits vary by edition, quota, model, thinking and tools. Subscription fees
are not per-token API rates. A hard budget needs an explicit fixed policy
request charge; that charge is not an estimate of upstream Credits. Usage
fixtures measure token fields, not plan quota. No live account call, subscription
change, provisioning or deployment is performed.

The real Worker/SQLite fixtures compile both source manifests without changing
the shared snapshot. They cover region and credential isolation, both routes,
JSON/fragmented SSE, replay, fixed settlement, unknown-price admission and
rejection without cross-product fallback. Snapshot activation requires a later
explicit serialized slot. Actual OpenClaw consumer and live entitlement proof
remain separate. Native Messages/Responses, OAuth, account-scoped catalog
refresh and remaining Coding Plan variants are not completed by this Chat batch.
