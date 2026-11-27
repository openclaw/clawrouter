# Volcengine PAYG frozen inventory

The source adds the nine frozen nonmedia identities from
[OpenClaw `31ad71a8`](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/volcengine/openclaw.plugin.json)
and preserves the already-landed `doubao-seed-2-1-pro-260915` seed. No newer
vendor catalog is imported. Frozen costs and context/output limits are not used.

| Native identity | Disposition |
| --- | --- |
| `doubao-seed-evolving` | Chat, text/image; selected name preserved, no fixed serving model inferred |
| `doubao-seed-2-1-pro-260628` | Chat, text/image; distinct from the existing 260915 seed |
| `doubao-seed-2-1-turbo-260628` | Chat, text/image; not the Coding Plan dotted identity |
| `glm-5-2-260617` | Chat, text; no Coding Plan alias applied |
| `deepseek-v4-pro-260425` | Chat, text |
| `deepseek-v4-flash-260425` | Chat, text |
| `kimi-k2-5-260127` | Frozen deprecated; known non-executable row |
| `glm-4-7-251222` | Frozen deprecated; known non-executable row |
| `deepseek-v3-2-251201` | Frozen deprecated; known non-executable row |

Deprecation does not establish a universal shutdown date or account access.
The three deprecated cards have no executable capability, native facts or
price, so enabling opaque passthrough cannot revive them. Frozen replacement
suggestions do not authorize a selected-ID rewrite. The 260915 seed keeps its
existing declaration; no new native facts are inferred for it.

The existing [standard Chat contract](https://docs.volcengine.com/docs/ark/text-generation?lang=en),
checked on 2026-11-03, fixes `https://ark.cn-beijing.volces.com/api/v3`,
`/chat/completions` and Bearer authentication. `VOLCANO_ENGINE_API_KEY` and the
original provider-scoped API-key grant remain the only credential sources.
BytePlus Singapore, `ARK_API_KEY`, and Volcengine/BytePlus Coding Plan keys
cannot configure or rescue this route. An opaque stored key is not proof of
account entitlement; no prefix-based authority is added.

Plan notices for `doubao-seed-2.1-turbo` and `glm-5.2` do not retire or alias
these distinct dated PAYG IDs. No plan allowance, tariff, output cap or reasoning
default is inferred. Unknown upstream cost fails hard dollar admission; the
fixtures' seven-micro fixed charge exercises a separate caller-policy budget.
Tools, reasoning history, split SSE arguments, cache usage and errors pass through
the existing Chat transport without a new shared adapter.

`worker/test/volcengine-payg-runtime.test.mjs` uses the actual compiled provider,
real Worker and synthetic credential-owner/SQLite budget stores. It prepares
native/manifest JSON/SSE cases for all seven active cards, original credentials,
wrong-product isolation, closed deprecated identities, unknown-price denial,
errors and cancellation. Local dependency qualification keeps this checkout
CODE-ONLY: these fixtures are not claimed run. Source6 owns later snapshot and
final functional/native consumer proof. No live calls or deployment occurred.
