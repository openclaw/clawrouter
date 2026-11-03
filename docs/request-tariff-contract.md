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

## Conditional xAI Responses outcome charge

The second closed variant adds a possible outcome charge to an independently
qualified inference bound. It does not borrow Perplexity's free-error rule.

```yaml
requestPricing:
  unit: request
  version: xai-responses-outcome-2026-11-03
  effectiveAt: "2026-11-03"
  source: https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee
  outcome: xai.responses_violation
  maximumAdditionalMicros: 50000
  receipt: xai.usage.cost_in_usd_ticks
```

[Current pricing](https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee)
charges $0.05 for Responses violations detected before generation; detection
after generation still incurs generation cost. This is independent of optional
server tools. `requestOutcomeReserve` in `worker/pricing.ts` adds 50,000 USD micros
to the ordinary inference reserve and rejects unknown bounds or integer overflow.
The sum is conservative; it is not a claim that every request incurs both charges.

The qualified native charge signal is **`usage.cost_in_usd_ticks`** on the original
complete Response. [Cost tracking](https://docs.x.ai/developers/cost-tracking) and
the [Responses reference](https://docs.x.ai/developers/rest-api-reference/inference/responses)
define this as the actual per-request total, with 10,000,000,000 ticks/USD.
`requestOutcomeCost` accepts complete `completed` or `incomplete` response objects
with a safe nonnegative integer receipt, rounds up to whole USD micros, and returns
`{ costMicros, basis: "provider_reported", pricingVersion }`. Do not add tokens,
tool fees or another $0.05 to that whole bill. A total above the reservation must
remain visible; never clamp it to fabricate compliance with an incorrect bound.

The inspected primary error/reference documentation does **not** identify a
unique pre-generation violation error code. No such code is invented here.
An arbitrary 4xx, `error.code`, refusal, user text, tool/function name or a total
of exactly $0.05 cannot establish that outcome. Naked error bodies, missing or
unsafe ticks, unknown statuses, partial streams and transport loss return `null`.
That means unknown cost, not free failure. A valid explicit zero receipt is
separate evidence; zero tokens or an absent receipt are not.

The shared runtime owner must bind these exports to existing admission,
observation and settlement, with the following invariants before activation:

- Freeze the selected tariff/version and ordinary inference bound with the
  original provider, model, caller and credential. Keep all independent tool,
  tier, media and ancestry bounds. A post-request cost receipt cannot prove a
  pre-egress bound. The first declaration is global `https://api.x.ai` only;
  regional tariffs need separate qualification.
- Bypass the model's `request_fee` gap only when this exact runtime path handles
  the complete request charge. Preserve `unpricedCosts: [request_fee]` until
  admission and settlement are wired. This PR changes neither bundled manifests
  nor discovery, and does not claim hard-budget parity.
- Validate native response identity and completeness before passing its body to
  `requestOutcomeCost`. For SSE, pass the original terminal Response once, after
  complete framing; never sum running receipts or accept caller-supplied usage.
  `incomplete` is a native terminal status, distinct from incomplete transport.
- After dispatch, no `response.ok === false` shortcut may refund a reservation.
  Unknown charges retain the full conservative reservation with an explicit
  basis. Only proven pre-dispatch failure may release it as unsent. Preserve
  dispatch acknowledgment, uncertainty, idempotency and exactly-once outbox rules.
- Keep `policy_fixed` precedence and its separate label. Do not report fixed
  policy charges or retained reservations as measured upstream bills.

Synthetic receipt/error fixtures exercise the arithmetic and evidence boundary.
No violation-triggering live prompts or fabricated violation error codes are
needed. Shared runtime and client types remain owned by their respective lanes.
