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

`applyProviderCredential` calls `assertXiaomiTokenPlanCredential` immediately after
resolving the selected environment or materialized grant credential and before
header/query formatting. Only these three provider IDs use this shape guard.
It accepts personal `tp-` and team `ttp-` prefixes case-insensitively and checks
the trimmed shape without rewriting the original credential. Raw CR, LF and
NUL are rejected before trimming. Ordinary surrounding spaces retain the
existing header-formatting behavior. Prefixes do not prove region or entitlement.

A missing or empty selected credential retains 503 `provider_not_configured`.
A present wrong-product or malformed credential returns sanitized 503
`provider_credentials_invalid`, without including the credential or a secret
cause. It is not a recoverable selected-grant failure: an invalid selected grant
cannot borrow environment, regional or policy credentials. Standard Xiaomi
PAYG is unchanged. No secret is materialized for catalog metadata validation.

Focused tests compile and inject the regional declarations into the test
snapshot. They exercise environment and materialized-grant selection through
native and manifest routes, initial rejection before upstream POST/reservation,
credential rotation/revocation, and invalid alternate preparation after an
already-reserved first response. In that last case the original response and
real settlement remain; zero additional POSTs does not mean zero prior egress.
These are Worker/SQLite fixture claims, not registered SDK or live-account proof.
The frozen client's `tp-`-only onboarding remains separate from this `ttp-` wire
contract. This change does not regenerate the shipping snapshot.

Generated snapshot activation needs an explicit serialized slot, green final-head checks. Native Messages/Responses, regional plan
discovery, actual client and live account proof remain separate continuations.
No live call, login, seat assignment, subscription action, provisioning or
deployment is performed.
