# Xiaomi Token Plan: regional transport and credential contract

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/xiaomi/openclaw.plugin.json`, `index.ts` and `provider-catalog.ts`.
Current primary contracts checked 2026-11-03.

| Router ID | Dedicated server binding | Fixed upstream base |
| --- | --- | --- |
| `xiaomi-token-plan` | `XIAOMI_TOKEN_PLAN_API_KEY` | `https://token-plan-sgp.xiaomimimo.com/v1` |
| `xiaomi-token-plan-cn` | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `https://token-plan-cn.xiaomimimo.com/v1` |
| `xiaomi-token-plan-ams` | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `https://token-plan-ams.xiaomimimo.com/v1` |

The frozen ID explicitly selects Singapore; the other IDs preserve the frozen
China and Europe choices. Select the region shown in the subscriber's console,
not the router's location. Each appends `/chat/completions`. Native callers use
`/v1/native/<id>/chat/completions`; manifest callers use
`/v1/proxy/<id>/chat_completions` and prepend the router ID to the model name.

The [current quick-access contract](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access)
qualifies the three bases and `api-key` header. It distinguishes personal
`tp-` and team `ttp-` credentials from PAYG `sk-` keys. Each region has its own
explicit binding and provider-scoped grant. The router does not select a region
from a key prefix or borrow `XIAOMI_API_KEY`, `MIMO_API_KEY`, another region or
another policy. The subscription account and assigned team seat still determine
entitlement. Errors and quota exhaustion never retry PAYG or another cluster.

## Every frozen model

| Frozen identity | Current disposition |
| --- | --- |
| `mimo-v2.6-pro` | Enabled, exact identity preserved |
| `mimo-v2.6-flash` | Enabled, exact identity preserved |
| `mimo-v2.5-pro` | Excluded: old name expired October 21, 2026 at 10:00 UTC+8 |
| `mimo-v2.5` | Excluded: old name expired October 21, 2026 at 10:00 UTC+8 |

The [full retirement notice](https://mimo.mi.com/docs/en-US/updates/deprecate)
distinguishes a temporary replacement period from expiry of the old name.
October 14 routing to the 2.6 models does not establish continued compatibility
after October 21. The notice also changes the default output limit and thinking
sampling behavior. These manifests reject both old names before egress even
when a policy grants them; they do not silently alias requests. No opaque
passthrough or newer model generation is added.

The [current OpenClaw integration example](https://mimo.mi.com/docs/en-US/tokenplan/integration/openclaw)
lists the two enabled 2.6 identities and requires preserving reasoning/tool-call
history. Fixtures preserve that history and explicit `max_completion_tokens`
without copying client-side thinking normalization into the native transport.
Prices and capability facts remain unknown rather than importing frozen zero
costs. Fixed policy charging is not a vendor token rate or subscription-quota
estimate. Missing usage and disconnects do not fabricate zero-token success.

## Required runtime and client integration

`assertXiaomiTokenPlanCredential(providerId, credential): void` in
`worker/xiaomi-plan-credentials.ts` validates the selected credential shape for
these three IDs. It accepts both current plan prefixes, preserves the original
credential, and raises a sanitized 503 `provider_credentials_invalid` for PAYG,
empty or malformed values. Unrelated providers are untouched.

The common runtime owner must call this function after credential selection and
before header construction or fetch, for environment and grant paths. That hook
is not wired in this source-owned change. Its seven focused tests prove the
validator contract; the separate 57 real Worker/SQLite cases prove transport
with valid explicitly selected plan keys. They do not claim the unwired guard
already rejects misconfigured keys through production dispatch. Before activation,
add real Worker no-egress assertions for wrong-product credentials after the
common hook lands. The client owner should also reconcile the frozen `tp-`-only
onboarding check with the current `ttp-` contract.

Generated snapshot activation needs an explicit serialized slot, the credential
hook and green final-head checks. Native Messages/Responses, regional plan
discovery, actual client and live account proof remain separate continuations.
No live call, login, seat assignment, subscription action, provisioning or
deployment is performed.
