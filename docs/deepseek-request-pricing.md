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

`RequestCostReceipt.basis` now permits `manifest_request` separately from
`provider_reported`. No calculated receipt is emitted by this change.
The published `ValidatedNativeUsage` only contains token inspection and an
optional receipt; it cannot yet carry codec-complete native `billableRequests`
and the admitted pricing version. Shared runtime must publish that trusted
observation contract before the pure receipt calculator can consume it.
Caller JSON, raw response reparsing and a shadow trust marker are not substitutes.

The pending calculation is exactly 750 for validated native nonempty and zero
for validated complete native empty, against the frozen admitted tariff and
matching version. Invalid, mismatched, missing or interrupted evidence yields
no receipt, retaining the reserve. A proven unsent dispatch can settle zero in
the shared path; a generic failed request cannot. Receipt version mismatch and
complete-result settlement tests depend on that published interface and are
not claimed here.

Focused tests cover strict definition validation, the actual codec's empty and
filtered observations, request-count independence, immutable value behavior,
unknown outcomes, compiler/admission closure and provider-reported/fixed-policy
isolation. They do not prove shared admission freezing, durable settlement or
hard-dollar runtime activation. No provider YAML or snapshot changes are made.
