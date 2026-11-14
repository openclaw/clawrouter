# Xiaomi PAYG frozen inventory

This source slice covers the four IDs assigned to the frozen campaign. The
[OpenClaw manifest at `31ad71a8`](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/xiaomi/openclaw.plugin.json)
records Chat and text/image input for `mimo-v2.6-pro` and `mimo-v2.6-flash`.
The existing PAYG base remains `https://api.xiaomimimo.com/v1`, with
`XIAOMI_API_KEY` and the selected grant's Bearer credential. The
[previously qualified first-call contract](https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call)
was checked on 2026-11-03. No newer model is added.

| Selected native ID | Disposition |
| --- | --- |
| `mimo-v2.6-pro` | Executable Chat, text/image input |
| `mimo-v2.6-flash` | Executable Chat, text/image input |
| `mimo-v2.5-pro` | Stopped; no executable capability or tariff |
| `mimo-v2.5` | Stopped; no executable capability or tariff |

The [previously recorded retirement notice](https://mimo.mi.com/docs/en-US/updates/deprecate)
checked on 2026-11-03 gives the final expiry as 2026-10-21 at 10:00 UTC+8.
The October 14 transition is not a continuing alias after that cutoff. Both
expired IDs remain known stopped rows, including when an unknown-model
passthrough is otherwise permitted. No selected ID is rewritten to a 2.6 ID.

Regional TokenPlan endpoints and their `XIAOMI_TOKEN_PLAN_*` credentials remain
separate products. Their presence cannot configure this PAYG provider; wrong
provider grants never satisfy selection. An opaque value manually installed as
a PAYG credential is not independently proven to be a PAYG entitlement. This
slice adds no key-prefix authorization or shared authentication changes.

Prices, context/output limits and reasoning defaults are not copied from the
frozen catalog. Unknown upstream cost still fails a hard dollar budget; an
explicit caller-policy fixed tariff has its own accounting basis. Native Chat
replay, tools, reasoning, SSE usage, errors and cancellation use the existing
Worker transport without a new adapter.

`worker/test/xiaomi-payg-runtime.test.mjs` compiles this actual provider and
calls the real Worker with synthetic owner-backed grants and budget storage.
It covers both active cards, both route shapes, JSON/SSE, stopped passthrough
attempts, TokenPlan isolation, unknown pricing, errors and cancellation.
Local dependency qualification is unavailable: fixtures are prepared, not
claimed executed locally. Source6 owns later snapshot integration and exact
functional/native consumer proof. No live account was queried.
