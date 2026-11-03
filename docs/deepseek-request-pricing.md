# DeepSeek Search request tariff foundation

The [published Search rate](https://api-docs.deepseek.com/guides/search/)
is USD 0.00075 per native nonempty request, effective November 1, 2026 at
00:00 Beijing time. A complete native empty result costs zero. The existing
codec records these facts and distinguishes native result count from filtered
consumer-visible destinations. This tariff applies to model-less native
`deepseek.search`, POST `https://api.deepseek.com/v1/tools/search`.

`DeepSeekSearchRequestPricing` and the standalone schema definition pin the
protocol, source, effective time, version and exact 750/0 microUSD rates.
`deepSeekSearchReserve` validates that definition and returns the maximum
single-dispatch reserve of 750 microUSD. Count, token estimates and filtered
results do not multiply or reduce this maximum. A source mutation must not
change the immutable tariff selected at admission.

This foundation does not add the definition to the active `RequestPricing`
union or manifest endpoint schema. Existing shared tariff selection assumes
that every non-image/non-outcome variant has successful-response parameter
rates; its owner must first publish explicit native Search narrowing. The
compiler still rejects this tariff on an endpoint, and the early Search
hard-dollar denial remains intact. Explicit `policy_fixed` costs remain
separate, including an explicitly configured zero.

`RequestCostReceipt.basis` distinguishes `manifest_request` from
`provider_reported`. The pure `deepSeekSearchCost(pricing, usage)` helper consumes
`ValidatedNativeUsage.nativeRequestUsage` from the qualified shared contract in
[PR762](https://github.com/openclaw/clawrouter/pull/762), landed as
`dd68a52a0f846d7f359c8bc3ddec7cbc6c3ab5c0`. The slot binds operation
`deepseek.search`, the admitted pricing version and native `billableRequests`
(0 or 1). Only a successful, codec-complete native observation can populate it.
The calculator does not parse raw provider responses or caller conditions.

The helper emits exactly 750 microUSD for validated native nonempty and zero
for validated complete native empty, against the frozen admitted tariff and
matching version. Invalid, mismatched, missing or interrupted evidence yields
no receipt, retaining the reserve. A proven unsent dispatch can settle zero in
the shared path; a generic failed request cannot. Published tariff calculation
is not an upstream invoice receipt or a policy-fixed price. The helper returns
a receipt without mutating the usage observation or tariff.

Focused tests cover strict definition validation, actual codec empty/nonempty
and filtered observations, request-count/token independence, frozen tariff
behavior after source mutation, version mismatch, unknown/error outcomes,
compiler/admission closure and provider-reported/fixed-policy isolation.
Calculator fixtures build the published slot from actual complete codec output;
they do not claim that the runtime producer is activated.

Shared observation propagation, tariff-selector narrowing, admitted freezing and
durable settlement remain separately owned integration work. The active pricing
union and early hard-dollar denial are unchanged. No provider YAML, snapshot,
common dispatch or settlement changes are made.
