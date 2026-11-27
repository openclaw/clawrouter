# Z.AI regional and Coding Plan contracts

Scope: the four endpoint choices and six model identities in OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/zai/model-definitions.ts`, `openclaw.plugin.json`, `detect.ts`
and `docs/providers/zai.md`. Primary contracts checked 2026-11-03.
This adds three new Chat routes; the existing global `zai` route is unchanged.

## Explicit endpoint and credential selection

| Router ID | Server binding | Fixed upstream base |
| --- | --- | --- |
| `zai` (existing) | `ZAI_API_KEY` | `https://api.z.ai/api/paas/v4` |
| `zai-cn` | `ZAI_CN_API_KEY` | `https://open.bigmodel.cn/api/paas/v4` |
| `zai-coding-global` | `ZAI_CODING_GLOBAL_API_KEY` | `https://api.z.ai/api/coding/paas/v4` |
| `zai-coding-cn` | `ZAI_CODING_CN_API_KEY` | `https://open.bigmodel.cn/api/coding/paas/v4` |

Each new route uses Bearer authentication, `/chat/completions`, native JSON or
SSE, and only its selected server binding or policy/provider-scoped API-key
grant. Missing, revoked, rejected or exhausted credentials do not trigger another
product, region, legacy environment alias or endpoint probe. The frozen
OpenClaw onboarding probe sequence is deliberately not a router fallback rule.

The [global key notice](https://docs.z.ai/devpack/notice/api-key-management)
and [China key notice](https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management)
distinguish standard, personal-plan and team-plan keys from 2026-10-16.
A standard key can still incur PAYG charges on a supported plan endpoint;
changing the URL does not change its billing classification. Older Compatible
keys depend on their account history and endpoint. Team overage follows the
account setting. Therefore a plan route requires an explicitly qualified plan
key/grant; its name alone cannot certify entitlement or prevent operator
misconfiguration. No documented opaque-key discriminator is assumed.

The grant issuer must verify the region, key classification, account/project and
named consumer before activation. Separate grants retain their original key;
there is no consent, login, key migration, account change or live probe here.
[Global tool guidance](https://docs.z.ai/devpack/tool/others) supports OpenClaw
on a best-effort basis. This is not permission to pool personal subscriptions
or infer arbitrary application eligibility.

## Frozen model disposition

| Frozen upstream ID | China standard | Global Coding Plan | China Coding Plan |
| --- | --- | --- | --- |
| `glm-5.3` | Enabled | Enabled | Enabled |
| `glm-5.3-flash` | Enabled | Enabled | Enabled |
| `glm-5.2` | Enabled | Upstream alias to 5.3; closed here | Upstream alias to 5.3; closed here |
| `glm-5-turbo` | Enabled | Not currently qualified for this plan | Upstream alias to 5.3 Flash; closed here |
| `glm-5v-turbo` | Enabled | Not currently qualified for this plan | Not currently qualified for this plan |
| `glm-5.1` | Frozen deprecated card; closed for new setup | Upstream alias to 5.3; closed here | Upstream alias to 5.3; closed here |

The [China model overview](https://docs.bigmodel.cn/cn/guide/start/model-overview)
still lists standard API 5.1; its frozen deprecation is not a claim that the API
has shut down. Standard availability does not establish plan availability.
The [global plan overview](https://docs.z.ai/devpack/overview) and
[China plan overview](https://docs.bigmodel.cn/cn/coding-plan/overview) document
the regional aliases above. No silent rewrite or alias card is advertised.
A closed model remains rejected even when a caller policy permits its name.
Availability and alias metadata plus actual serving-identity qualification
are required before exposing those compatibility cards. Absence from a current
plan list is recorded as unqualified, not invented retirement.

No later model generations are added. Prices remain unknown, including for plan
quota. These declarations do not copy frozen zero costs or assert untested
native modality/context facts. The existing global model inventory is unchanged.

## Wire proof and remaining integration

The [native Chat reference](https://docs.z.ai/api-reference/llm/chat-completion)
and [thinking guide](https://docs.z.ai/guides/capabilities/thinking-mode)
define `tool_stream`, `reasoning_effort`, `thinking.clear_thinking`, replayed
`reasoning_content`, split tool arguments and final token usage with cached-input
details. The router preserves caller parameters and upstream bytes. It does not
silently turn thinking off for 5.3, inject unsupported `stream_options`, or infer
native fees from token counts.

`worker/test/zai-regional-runtime.test.mjs` uses the real Worker, authority,
scoped credentials and SQLite budget ledger. It checks both routes with JSON/SSE,
all enabled identities, fixed-price admission, one reservation/event, cache
usage, missing/revoked credentials, HTTP failures, embedded SSE errors, unknown
usage, client cancellation and credential-free usage records. Synthetic fixed
seven-micro charges exercise policy accounting; they are not vendor tariffs.

The committed snapshot includes the three regional providers. The client fixture
retains the existing 22 global Z.AI scenarios and adds 36 configured native
positives, nine registered ClawRouter catalog/unified positives, and regional
denial, rotation, error and cancellation cases. Native cases use the registered
Z.AI catalog and hooks with an explicit router native base. Unified cases use
the real ClawRouter catalog and the discovered model's Chat API; they do not
inherit Z.AI replay behavior. Discovery and execution use the selected proxy key.

These client cases are authored for the immutable OpenClaw
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb` consumer. Local Worker and observer
tests do not establish execution of that client. Genuine ephemeral client CI,
original resource retirement and SQLite accounting remain required before a
client qualification claim. Cancellation expiry, disposal and an unlocked body
alone do not prove physical retirement. No live account, vendor availability,
voice or other modality entitlement, vendor tariff, or deployment is qualified
by this change.
