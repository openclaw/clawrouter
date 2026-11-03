# Ark Coding Plans: finite inventory and account boundaries

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/{volcengine,byteplus}/openclaw.plugin.json`. Primary contracts
checked 2026-11-03. These are distinct subscription products, not regional
fallbacks for the standard APIs or for each other.

| Router ID | Dedicated server binding | Fixed upstream base |
| --- | --- | --- |
| `volcengine-plan` | `VOLCENGINE_PLAN_API_KEY` | `https://ark.cn-beijing.volces.com/api/coding/v3` |
| `byteplus-plan` | `BYTEPLUS_PLAN_API_KEY` | `https://ark.ap-southeast.bytepluses.com/api/coding/v3` |

Both append `/chat/completions` and use Bearer authentication. Native callers
use `/v1/native/<id>/chat/completions`; manifest callers use
`/v1/proxy/<id>/chat_completions`. Manifest model IDs prepend the selected
router ID; native model names remain unchanged.

The [Volcengine quickstart](https://docs.volcengine.com/docs/ark/coding-plan-personal-get-started?lang=zh)
and [BytePlus quickstart](https://docs.byteplus.com/en/docs/modelark/coding-plan-personal-get-started)
qualify these dedicated paths. Both distinguish `/api/coding/v3` from standard
`/api/v3`, which can incur separate charges. Bind the selected subscriber's
plan credential explicitly. The router never borrows `ARK_API_KEY`, standard
Volcengine/BytePlus keys, the other product's key or another policy's grant.
Rejected and exhausted plans do not retry a different product. Personal and
team accounts must not share a subscriber's credential or imply identical
entitlements. A configured key does not establish account eligibility.

## Every frozen plan model

| Product | Frozen identity | Current disposition in this change |
| --- | --- | --- |
| Volcengine | `ark-code-latest` | Enabled as the documented console-managed alias; no fixed serving model or tariff inferred |
| Volcengine | `deepseek-v4-pro` | Enabled; still listed in the current personal-plan quickstart |
| Volcengine | `deepseek-v4-flash` | Enabled; still listed in the current personal-plan quickstart |
| Volcengine | `doubao-seed-2.1-turbo` | Known, non-executable `stopped` row: service stopped 2026-10-09 at 14:00 UTC+8 |
| Volcengine | `glm-5.2` | Known, non-executable `upstream_alias` row naming `glm-5.3`, effective 2026-08-31; legacy-account and native alias qualification remain required |
| BytePlus | `ark-code-latest` | Enabled as the documented console-managed alias |
| BytePlus | `kimi-k2.5` | Known, non-executable `deprecated` row dated 2026-09-23; current account availability needs qualification |

The [current Volcengine retirement notice](https://docs.volcengine.com/docs/ark/coding-plan-personal-model-deprecation?lang=zh)
records the Turbo shutdown and GLM 5.2 retirement on August 31. It also says
new users lost GLM 5.2 access on August 17 and describes automatic upstream
routing to GLM 5.3. That is not an independent GLM 5.2 serving model; this
change does not silently rewrite the requested identity or add GLM 5.3.

The [BytePlus personal-plan notice](https://docs.byteplus.com/en/docs/modelark/coding-plan-personal-model-deprecation)
marks Kimi K2.5 deprecated, while older setup/team examples still list it.
Deprecation alone does not prove every team account has lost access. This
bounded personal-plan inventory does not advertise that disputed entitlement.
The same notice restricts the BytePlus latest alias to `ark-code-latest`;
`glm-latest`, `kimi-latest` and other latest names are not added.

All seven frozen identities are retained. The three disposition rows use the
published [model availability contract](model-availability-contract.md), with
primary evidence and checked dates, no capabilities and no prices. The GLM row
retains `upstream: glm-5.2`; `servingModel: glm-5.3` does not change its selected
identity, tariff or facts. It does not add a GLM 5.3 card or authorize an account.

There is no opaque model passthrough. A policy granting a non-executable name
still cannot route it. Worker fixtures also enable passthrough on cloned
endpoints to verify it cannot revive these known rows. Before bundling this
source, the common owner must project availability and eligibility through
discovery and live offers, including the legacy `openaiCompatible.models`
projection. Schema publication alone does not satisfy that gate. Alias or
deprecated cards require separate account, codec and runtime proof before any
capability can be enabled; the stopped identity remains non-executable.

## Usage and proof

`ark-code-latest` retains its native meaning: console selection or Auto can
change the serving model without changing the caller's model string. The router
preserves both the request and upstream response rather than pinning an
invented target. All token prices and capability facts stay unknown, including
the alias. A fixed policy charge is an explicit router budget, not a vendor
subscription rate or quota estimate.

Real Worker/SQLite fixtures compile both source manifests and exercise both
routes, JSON/SSE replay, account/product isolation, every enabled identity,
pre-egress rejection of non-executable cards, response serving identity, fixed
settlement, missing usage, errors and disconnects. Snapshot activation needs a
later explicit serialized slot and green final-head checks. Native Messages,
Responses, plan-scoped discovery, actual client and live account proofs remain
separate continuations. No live call, model switch in a vendor console,
provisioning, subscription change or deployment is performed.
