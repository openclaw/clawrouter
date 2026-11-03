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
| Volcengine | `doubao-seed-2.1-turbo` | Excluded: service stopped 2026-10-09 at 14:00 UTC+8 |
| Volcengine | `glm-5.2` | Excluded pending explicit legacy-account/alias qualification; underlying model retired, upstream documents routing to `glm-5.3` |
| BytePlus | `ark-code-latest` | Enabled as the documented console-managed alias |
| BytePlus | `kimi-k2.5` | Excluded: current personal-plan notice marks it deprecated on September 23; current account availability needs qualification |

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

There is no opaque model passthrough. A policy granting an excluded name still
cannot route it through these manifests. Alias/availability metadata and an
eligible account contract are required before adding excluded compatibility
cards. This does not block the qualified plan transport or surviving inventory.

## Usage and proof

`ark-code-latest` retains its native meaning: console selection or Auto can
change the serving model without changing the caller's model string. The router
preserves both the request and upstream response rather than pinning an
invented target. All token prices and capability facts stay unknown, including
the alias. A fixed policy charge is an explicit router budget, not a vendor
subscription rate or quota estimate.

Real Worker/SQLite fixtures compile both source manifests and exercise both
routes, JSON/SSE replay, account/product isolation, every enabled identity,
pre-egress rejection of excluded cards, response serving identity, fixed
settlement, missing usage, errors and disconnects. Snapshot activation needs a
later explicit serialized slot and green final-head checks. Native Messages,
Responses, plan-scoped discovery, actual client and live account proofs remain
separate continuations. No live call, model switch in a vendor console,
provisioning, subscription change or deployment is performed.
