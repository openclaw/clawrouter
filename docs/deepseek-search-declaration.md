# Bundled DeepSeek native Search

The existing DeepSeek manifest declares one model-less `search.web` endpoint:
POST `/v1/tools/search`, request and response format `deepseek.search`, under
`https://api.deepseek.com`. The original selected Bearer API key is retained.
Existing Chat identities, capabilities and prices are unchanged.

This declaration consumes the native runtime qualified in
[PR728](https://github.com/openclaw/clawrouter/pull/728), landed as
`2f4aafaf485ef83c1260694e8e7d85cba3ece07b`, and the existing compiler and
codec contracts. Its request tariff additionally requires the qualified common
admission and settlement from [PR767](https://github.com/openclaw/clawrouter/pull/767).
Native requests use `/v1/native/deepseek/v1/tools/search`;
manifest requests use `/v1/proxy/deepseek/search` with `{ body }`.
Both require explicit `query`, `count` from 1–10 and `need_content: false`.
No model, implicit count, Fetch, localization, URL fetching or query override
is added. The wrapper bounds request JSON to 4 KiB and response JSON to 1 MiB.

The declaration tests compile this YAML unchanged and use the real Worker,
selected environment or owner-grant credentials and SQLite reservation/event
fixtures. They cover catalog eligibility, both routes, native empty/nonempty
results, the 750-microUSD reservation and conditional settlement, fixed-policy
isolation, incomplete-delivery reservations and zero-egress budget denial.
These deterministic Worker tests do not establish actual OpenClaw registered
Search-client execution, live vendor availability or deployment.

## Frozen native request tariff

The [primary Search guide](https://api-docs.deepseek.com/guides/search/), checked
2026-11-04, publishes USD 0.75 per 1,000 successful nonempty requests, effective
2026-11-01 00:00 Beijing time. The existing codec preserves native nonempty
versus complete-empty observations. Consumer filtering cannot erase a charge;
interruption is not a verified empty response or free error.

The endpoint declares `DeepSeekSearchRequestPricing`, version
`deepseek-search-2026-11-01`, with `successfulNonemptyRequestMicros: 750` and
`emptyRequestMicros: 0`. Admission freezes that sourced tariff and reserves
750 microUSD before dispatch, independently of requested result count. Only
codec-complete native evidence can produce a version-bound `manifest_request`
receipt: nonempty costs 750, empty costs zero. Missing or interrupted evidence
retains the entire reserve; a generic failed response does not establish zero.
Native usage remains non-token usage, separate from Chat model pricing.

The compiler accepts this tariff only on the canonical model-less DeepSeek
Search contract. A missing tariff still denies upstream-dollar hard budgets
before egress. Explicit `policy_fixed` is separately labeled, including an
explicit zero; it does not certify a zero upstream price.

The tariff runtime is qualified by PR767, landed as
`ac46e07bcc0a1318b1eda0db7002e32f9a2029ce`. The generated snapshot is compiled
from the bundled declaration. Actual OpenClaw Search-client qualification
remains separate and unproved.

Primary wire reference: [Search API](https://api-docs.deepseek.com/api/search/).
