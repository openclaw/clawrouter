# OpenAI reporting evidence, 2 November 2026

Source baseline: main `6fceb88` (discovery fix since the 28 October audit). No live user usage or paid provider requests were read or made. The available desktop has no signed-in browser; Hannes's exact traffic path remains unconfirmed.

## Current API contracts

Retrieved 2026-11-02, official OpenAI reference:

- [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions): prompt_tokens_details.cache_write_tokens is an **optional integer (default: 0)**, described as the unadjusted number of prompt tokens written to cache. completion_tokens_details.reasoning_tokens is optional; reasoning is already included in completion tokens for billing and context limits.
- [Create Responses](https://developers.openai.com/api/reference/resources/responses/methods/create): usage.input_tokens_details.cache_write_tokens is an integer, not documented as an optional default-zero counter. output_tokens_details.reasoning_tokens is the output reasoning subset. Example payloads include cache_write_tokens: 0.

These are distinct contracts. They do not establish that a missing Responses counter is zero, that the private subscription transport follows the API counter contract, or that a missing served tier matches the requested tier. The candidate deliberately does not change settlement normalization, even for the documented Chat default.

## Still-reachable current accounting paths

worker/pricing.ts actualModelCost requires cacheWrite when the frozen rate card declares cacheWriteInput; resolveRates requires a recognized served tier when serviceTiers exist. worker/proxy-accounting.ts accountingReceipt retains reservation estimates for reserve/unmetered paths, but soft mode records unknown zero when observed usage cannot be fully priced. Hosted fee/usage gaps remain unknown unless the producer explicitly records a genuine known component in reporting_known_cost_micros. A positive unpriced debit may be a retained reservation, not measured partial cost. A tool declaration is not evidence that its unreported fees are zero.

The preserved scratch cost-probe.mjs rerun on current source still reproduces these paths. Focused regression tests in usage-report-counters.test.mjs and reporting-estimate.test.mjs freeze both amount and cost_basis semantics.

## Candidate behavior

- Capture optional reasoning as a subset of output; no extra output or cost is added.
- Preserve actual_cost_micros, cost_basis, and all budget debit/settlement expressions.
- Where complete input/output counts exist but served tier or cache-write allocation is unavailable, optional reporting-only estimates can use the **frozen admission card**. Missing tier uses maximum declared tier pricing; unknown cache writes use the maximum of disjoint input/write allocations. This is a disclosed estimate, not a guaranteed upper bound on any provider invoice. Explicitly unsupported served tiers and missing input/output remain unknown. Hosted-tool gaps never become a token-only total through this estimator.
- Optional reporting_estimated_cost_micros and reporting_estimate_reason are separate evidence. No absent counter is written as zero, and no reporting estimate is passed into a budget ledger.
- Historical projection reads only retained accounting evidence. It never applies today's price to old events or invents missing reasoning/counters. No production backfill has been executed.

## Interpretation

Calculated/fixed subtotals, estimates, upper-bound rates, partial known amounts, and unknown coverage remain separate, as do API and subscription list-price equivalents. No single headline total combines those values. Recorded budget charges appear only as a separate detail value; they are not a provider invoice.
