# Qwen regional standard and Coding Plan contracts

Scope: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/qwen/{models.ts,openclaw.plugin.json,provider-catalog.ts,stream.ts}`
and `docs/providers/qwen.md`. Primary evidence checked 2026-11-03.
This implements the remaining three frozen regional Chat choices. Existing
Singapore standard `qwen` and the separate Token Plan source PR are unchanged.

## Endpoint, product and credential selection

| Router ID | Server binding | Fixed upstream base |
| --- | --- | --- |
| `qwen` (existing) | `QWEN_API_KEY` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| `qwen-cn` | `QWEN_CN_API_KEY` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `qwen-coding-global` | `QWEN_CODING_GLOBAL_API_KEY` | `https://coding-intl.dashscope.aliyuncs.com/v1` |
| `qwen-coding-cn` | `QWEN_CODING_CN_API_KEY` | `https://coding.dashscope.aliyuncs.com/v1` |

The [current Chat reference](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)
recommends workspace-specific hosts and explicitly keeps the old hosts working.
These frozen routes do not silently migrate account resources or infer a
workspace ID. Beijing and Singapore credentials remain separate. No US, Hong
Kong, Frankfurt, Tokyo or new QwenCloud-origin route is introduced.

The [global Coding Plan contract](https://www.alibabacloud.com/help/en/model-studio/coding-plan)
and [China contract](https://help.aliyun.com/zh/model-studio/coding-plan) require
plan-specific `sk-sp-` keys and plan endpoints. They cannot substitute standard
PAYG credentials. Token Plan is a separate product with separate bindings and
origins. Current Coding Plan lists six exact versions, not every model in the
frozen fallback catalog. Lite stopped new subscriptions and renewals; this does
not mean Pro or an unexpired eligible subscription is retired.

Native `/v1/native/<id>/chat/completions` and manifest
`/v1/proxy/<id>/chat_completions` routes preserve Bearer auth from only the
selected server binding or original policy/provider-scoped API-key grant.
There is no missing-key fallback, regional probe, plan upgrade or auth retry.
The issuer must qualify the named subscriber, product, region and allowed
interactive consumer. Plan use in shared accounts, unattended scripts, custom
application backends or bulk calls is not established by these fixtures.

## Frozen inventory and retirement

| Frozen ID | China standard | Both Coding Plan regions |
| --- | --- | --- |
| `qwen3.5-plus` | Enabled until announced retirement | Enabled until announced retirement |
| `qwen3.6-plus`, `qwen3.7-plus` | Enabled | Enabled |
| `qwen3.6-flash`, `qwen3.7-max`, `qwen3.8-max`, `qwen3.8-flash` | Enabled | Unsupported; rejected |
| `MiniMax-M2.5`, `glm-5`, `kimi-k2.5` | Enabled | Enabled |
| `qwen3-max-2026-01-23`, `qwen3-coder-next`, `qwen3-coder-plus`, `glm-4.7` | Retired; rejected | Retired; rejected |

The [current text model guide](https://help.aliyun.com/zh/model-studio/text-generation-model/),
[Beijing catalog](https://help.aliyun.com/zh/model-studio/model-pricing),
[MiniMax reference](https://help.aliyun.com/zh/model-studio/minimax-api) and
[Kimi card](https://help.aliyun.com/zh/model-studio/kimi-k2-5) qualify the standard
identities. Their tariffs are not copied; subscription quota and operator-fixed
charges are not native per-token prices. Native modality/context facts remain
unasserted in this transport batch.

[Notice 118344](https://www.aliyun.com/notice/118344) retires `qwen3-coder-plus`;
[118345](https://www.aliyun.com/notice/118345) retires the other three closed
names on 2026-10-10, including affected Coding/Token Plan versions. No replacement
model is silently substituted. The current notice bodies were read from their
published page data; stale search snippets still show older plan inventories.

[Notice 118728](https://www.aliyun.com/notice/118728) schedules `qwen3.5-plus`
end of marketing for 2026-11-18 and end of service for 2027-01-19 at 10:00
Beijing time, including affected plans. It is not retired on this qualification
date. Source3 needs dated availability metadata before that transition; the
current declarations do not implement an automatic retirement clock.

The frozen docs explicitly remove `qwen-oauth` / Qwen Portal authentication.
[Current Qwen Code documentation](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)
confirms the OAuth free tier closed on 2026-04-15. No Portal flow, refresh,
credential conversion or live OAuth offer is added. Historical migration aliases
do not make Portal tokens valid API keys.

## Focused proof and handoffs

`worker/test/qwen-regional-runtime.test.mjs` exercises the real Worker,
authority, scoped grant store and SQLite budget ledger: both native and manifest
JSON/SSE, reasoning/tool replay, split tool arguments, final cached-token usage,
all enabled identities, blocked IDs even under permissive model policy,
missing/revoked keys, HTTP rejection, unknown usage, embedded SSE errors and
client cancellation. One synthetic seven-micro policy charge tests reservation
and settlement; it is not a vendor rate. The native 3.8 reasoning-effort field
is preserved only on an eligible standard route in the focused fixture.

New export `assertQwenCodingPlanCredential(providerId, credential): void` in
`worker/qwen-plan-credentials.ts` validates the documented `sk-sp-` shape for
exactly the two Coding Plan IDs. It throws a sanitized 503
`provider_credentials_invalid` error on wrong-product/malformed values. It leaves
standard and Token Plan contracts alone and does not infer region/entitlement.
Five unit cases cover this helper separately.

**Source1 wiring is required before activation:** call the validator after
original credential selection and before upstream headers/fetch for environment
and grant paths. Add real Worker wrong-product no-egress cases at that hook.
The helper is not wired here; valid-key transport tests do not claim the common
guard is active. Source2 must map the frozen endpoint choice to its exact router
ID and original grant, preserving client-owned thinking normalization.

All new manifests are Chat-only with no passthrough inventory. Native Messages,
Responses, discovery, original global inventory, schema facts and actual-client
proof remain separate continuations. Source5 retains media ownership. Source6
retains snapshot/acceptance scheduling. No snapshot lease, live call, login,
provisioning, account change or deployment is included.
