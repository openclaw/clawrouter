# Successful-request tariff contract

`endpoint.requestPricing` represents an operation price separately from token
prices and credit ledgers. The first qualified source format is Perplexity's
native `POST /search`, with `web.search` and matching `perplexity.search` wire
formats. This compiler contract alone activates no tariff in bundled manifests.

```yaml
requestPricing:
  unit: request
  version: perplexity-search-2026-11-03
  effectiveAt: "2026-11-03"
  source: https://docs.perplexity.ai/docs/getting-started/pricing
  successfulResponseMicros: 5000
  parameterRates:
    parameter: search_type
    rates: { web: 5000, fast: 1000 }
```

Amounts are integer USD micros. The source identifies the successful HTTP request
as the unit, including empty results and multi-query requests. Query count,
result count and extracted-text token budgets are not billing multipliers.
Failed requests do not incur this tariff. These facts were checked against
[official pricing](https://docs.perplexity.ai/docs/getting-started/pricing) on
2026-11-03. Agent tool calls and sandbox sessions have different billing units.

The common runtime consumer must:

1. Select the base price only when the native top-level parameter is absent.
   When present, require a string with an own entry in `parameterRates.rates`.
   Unknown/malformed values cannot select a cheap default. Do not inspect tool
   names, nested JSON or user text for tariff selection.
2. Reserve exactly one selected request price before egress under hard budgets.
   Freeze the tariff version, selected rate and original route/accounting facts.
   Preserve explicit policy-fixed precedence and label it `policy_fixed`.
3. Settle the request rate from complete validated successful-response evidence,
   independently of token counters. A documented failed request costs zero;
   interrupted or uncertain delivery retains a conservative reservation with an
   explicit basis, rather than fabricating success or zero cost.
4. Reject tariff use for unqualified methods, formats or lifecycle protocols.
   Keep model-token settlement and other charge components separate.

The compiler requires both current Perplexity search variants and checks the
base/default relationship. It rejects streaming, async, passthrough-model and
query-override uses. Runtime/schema/client types must agree before a manifest
adds this field or advertises upstream-dollar budget coverage. Source-only tests
and `policy_fixed` requests do not supply that accounting proof.

Credit schedules are a separate pending contract. A credit quantity alone does
not establish USD cost without a qualified account/plan conversion and all
billable feature components. Unknown credit-to-dollar rates remain fail-closed.
