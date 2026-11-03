# Moonshot native Chat and regional discovery

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/moonshot/{openclaw.plugin.json,provider-policy-api.ts,provider-discovery.ts}`.
Primary contracts checked 2026-11-03. Only the five frozen Chat cards are added;
Kimi Code, search, Messages/Responses and media executors retain their own routes.

| Router ID | Selected server credential | Fixed origin and prefix |
| --- | --- | --- |
| `moonshot` | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` |
| `moonshot-cn` | `MOONSHOT_CN_API_KEY` | `https://api.moonshot.cn/v1` |

Both use Bearer authentication. The [global](https://platform.kimi.ai/docs/api/list-models)
and [China](https://platform.kimi.com/docs/api/list-models) contracts explicitly
separate platform keys. Neither route borrows the other region's credential or
`KIMI_API_KEY`. Stored grants remain provider and policy scoped. A key's presence
does not prove model entitlement. A 404 can mean absent model or insufficient
account access; it does not establish retirement.

Native caller paths are `/v1/native/<id>/chat/completions` and
`/v1/native/<id>/models`; manifest endpoints are `chat_completions` and
`models_list`. Upstream paths append `/chat/completions` and `/models` to the
selected base. There is no cross-region or subscription retry.

## Finite model contract

| Frozen identity | Native facts and disposition |
| --- | --- |
| `kimi-k3` | Always-thinking; text/image/video input; 1,048,576 context and documented maximum completion tokens |
| `kimi-k3.1-pro` | Same context/input/output bounds; account access remains separate |
| `kimi-k3.1-pro-highspeed` | Distinct selected identity with the documented K3.1 contract; no inferred common tariff |
| `kimi-k2.7-code` | Always-thinking; frozen text/image input; 262,144 context; existing-account access with dated deprecation |
| `kimi-k2.7-code-highspeed` | Distinct K2.7 identity with the same account restriction; no silent K3 replacement |

The [K3 guide](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart),
[global K3.1 guide](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart)
and [China K3.1 guide](https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart)
qualify `max_completion_tokens` with default 131072 and maximum 1048576.
Current primary documentation supports `low`, `high` and `max` reasoning effort;
the frozen catalog's narrower `max` card/default is retained, without converting
or dropping the caller's native request fields. Complete assistant messages,
reasoning content and tool calls must survive replay. Fixed sampling defaults
are left to the upstream; this source does not inject generic sampling values.

The [K2.7 guide](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart)
uses `max_tokens` (default 32768) and `thinking: {type: enabled}`. Disabling
thinking is rejected upstream. Its frozen `maxTokens: 262144` is not copied as
a verified output limit: context and output bounds are different facts.
Native JSON and SSE travel without a Chat conversion or hidden model rewrite.

The [global availability notice](https://platform.kimi.ai/docs/pricing/chat)
and [China notice](https://platform.kimi.com/docs/pricing/chat) close K2 to new
registrations from 2026-10-31 while preserving existing users. They announce a
planned end-of-December shutdown, not an exact current stop date. The K2 rows
therefore carry `deprecated` availability with original IDs and sources, not
`stopped` or an upstream alias. No runtime timer or replacement model is invented.
The inference platform is pay-as-you-go, separate from Kimi membership/Code.

## Discovery and accounting

GET `/models` consumes the strict existing `openai.models` codec: an `object:
list` envelope with model rows. Native `context_length`, `supports_image_in`,
`supports_video_in` and `supports_reasoning` observations remain on allowed
rows. The original policy filters model IDs on the original selected grant;
the response is private/no-store and never reserves an inference charge.
Anonymous catalog observations are not used as account authority. A dynamic
row does not acquire static pricing or a live-capability badge.

Existing unpriced Chat passthrough remains available under explicit policy.
All frozen prices, including cache-write zeroes, are deliberately unimported.
Hard upstream-dollar budgets reject unknown tariffs; a `policy_fixed` charge is
a router policy charge. Native usage, cache-hit tokens and missing/interrupted
usage remain distinct from vendor-dollar settlement.

## Proof and activation boundary

Real Worker/SQLite fixtures compile both manifests and exercise each frozen
model through both caller routes and JSON/SSE, fragmented tool arguments,
reasoning replay, inline images, regional grants, discovery filtering, invalid
envelopes/queries, native errors, cancellation and conservative accounting.
Video/file ingestion and actual client behavior remain separately qualified;
the native facts alone do not implement those consumers.

This source needs common availability projection before its deprecated cards
are bundled, plus an explicit serialized snapshot slot and final-head gates.
Native model discovery is a configured account query, not a background refresh
scheduler. No live inference, login, entitlement purchase, provisioning or
deployment is part of this change.
