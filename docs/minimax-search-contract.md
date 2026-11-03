# MiniMax native plan Search

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/minimax/src/minimax-web-search-provider.runtime.ts`. This native
HTTP contract does not introduce an MCP process or a replacement search product.

`worker/minimax-search.ts` exports `miniMaxSearchPath`, `miniMaxSearchOrigins`,
`prepareMiniMaxSearch(region, body)`, `observeMiniMaxSearch(body, count, complete)`
and `readMiniMaxSearch(response, count, signal)`.

## Wire and consumer result

Select `global` (`https://api.minimax.io`) or `cn`
(`https://api.minimaxi.com`) from the admitted original server grant.
POST `/v1/coding_plan/search` with native Bearer auth and JSON `{q:string}`.
Prepare supplies no secret or authority; the common materializer owns credentials.
No model, count, page, filters or region field is added to the native body.
The local query bound is 4KiB UTF-8 with valid Unicode and no control characters.

Require complete HTTP 200 JSON, `base_resp.status_code:0` and an `organic` array.
Treat nonzero status codes as errors even at HTTP 200. Results retain native
`title`, `link`, `snippet` and optional `date`, with separate related queries.
The consumer count is 1–10 and truncates locally; it is not a vendor pagination
parameter or a quota observation. Preserve the complete native body and native
row count even when unsafe URLs are omitted. Result URLs are not fetched.

The reader limits JSON to 1MiB and requires complete UTF-8 EOF and consistent
declared length. Abort cancels stalled reads. At most 100 native rows and 50
related queries are accepted locally; these safety bounds are not service
capacity claims. Validate every row before exposing results, including rows
beyond the consumer limit. Keep titles, snippets and related queries untrusted;
the actual consumer owns external-content wrapping and cache scoping.

## Product and billing boundary

The frozen client calls this Token/Coding Plan Search; current primary setup
documentation calls its required credential an M Plan API key. A key's
environment-variable name or prefix alone does not prove entitlement. The
existing E09 OAuth resource contract qualifies Anthropic inference separately;
it does not authorize Search by inference. Source 11.4/11.1 must qualify any
OAuth Search resource and selected regional plan grant before activation.
No key/region/account fallback, client upstream-secret forwarding, login or
commercial-account changes occur here.

No inspected primary evidence supplies a per-request USD charge or an admitted
worst-case bound. `upstreamCostMicros` is always unknown (`null`), including
empty, filtered, failed and interrupted outcomes. Do not divide a subscription
price into invented per-call costs or use returned result count as billing.
Unknown upstream-dollar hard budgets stay closed; `policy_fixed` remains a
separate charging basis. Interrupted requests authorize no automatic POST replay.

## Integration handoff

Proposed exact native request/response format `minimax.search`, capability
`web.search`, existing provider ID `minimax`. Source 11.3 owns existing YAML,
schema and catalog; source 11.1 owns native dispatch, admission/accounting and
credential selection; source 11.2 owns the actual frozen search consumer;
source 11.6 owns integrated proof. No catalog activation or live parity claim.

Sanitized fixture: `providers/_fixtures/minimax/search.json`. Five tests cover
regional wire identity, native-versus-consumer count, vendor errors, invalid
rows/destinations, complete bytes and stalled-read cancellation. No live call.

Primary evidence checked 2026-11-03:
- [Official reference client](https://github.com/MiniMax-AI/MiniMax-Coding-Plan-MCP/blob/main/minimax_mcp/server.py), inspected blob `e2b295191787c02d0801242dcbc7293b98136bc8`
- [Official HTTP client error/auth contract](https://github.com/MiniMax-AI/MiniMax-Coding-Plan-MCP/blob/main/minimax_mcp/client.py), inspected blob `41988d2a4a54c6cb506c2cb8aa1ddaafda1b76b3`
- [Current plan Search setup](https://platform.minimax.io/docs/m-plan/mcp-guide)
