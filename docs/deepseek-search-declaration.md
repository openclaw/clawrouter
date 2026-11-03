# Bundled DeepSeek native Search

The existing DeepSeek manifest declares one model-less `search.web` endpoint:
POST `/v1/tools/search`, request and response format `deepseek.search`, under
`https://api.deepseek.com`. The original selected Bearer API key is retained.
Existing Chat identities, capabilities and prices are unchanged.

This declaration consumes the native runtime qualified in
[PR728](https://github.com/openclaw/clawrouter/pull/728), landed as
`2f4aafaf485ef83c1260694e8e7d85cba3ece07b`, and the existing compiler and
codec contracts. Native requests use `/v1/native/deepseek/v1/tools/search`;
manifest requests use `/v1/proxy/deepseek/search` with `{ body }`.
Both require explicit `query`, `count` from 1–10 and `need_content: false`.
No model, implicit count, Fetch, localization, URL fetching or query override
is added. The wrapper bounds request JSON to 4 KiB and response JSON to 1 MiB.

The declaration tests compile this YAML unchanged and use the real Worker,
selected environment or owner-grant credentials and SQLite reservation/event
fixtures. They cover catalog eligibility, both routes, native empty/nonempty
results, fixed-policy settlement and zero-egress hard-dollar denial. Source6
owns generated snapshot integration; source2 actual-client proof is separate.
Test source alone is not hosted or client execution proof.

## Native request tariff remains separate

The [primary Search guide](https://api-docs.deepseek.com/guides/search/), checked
2026-11-04, publishes USD 0.75 per 1,000 successful nonempty requests, effective
2026-11-01 00:00 Beijing time. The existing codec preserves native nonempty
versus complete-empty observations. Consumer filtering cannot erase a charge;
interruption is not a verified empty response or free error.

The current `SuccessfulRequestPricing` contract prices successful responses
without a typed native-result condition. The native wrapper also explicitly
rejects `endpoint.requestPricing` and returns null token usage without a tariff
receipt. A qualified tariff needs an extension to the existing request-pricing
admission/settlement contract, retaining the native complete-result condition
and conservative uncertain outcome. This declaration does not invent that
shared interface or silently use unconditional success pricing.

Until that bounded integration is qualified, upstream-dollar hard budgets
reject Search before egress. Explicit `policy_fixed` is separately labeled,
including an explicit zero; it does not certify a zero upstream price.

Primary wire reference: [Search API](https://api-docs.deepseek.com/api/search/).
