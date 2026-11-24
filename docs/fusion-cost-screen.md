# Fusion cost screen

Prompt cache order can make a more expensive cascade appear cheaper on the invoice.
`scripts/fusion-cost-screen.mjs` requires at least 20% savings on both actual billed
cost and cache-neutral cost before a paired comparison passes its cost screen.

Cache-neutral cost prices all input tokens at the frozen model's ordinary input
rate and output tokens at its output rate. It removes cache read discounts and
cache write premiums. It is a counterfactual comparison, not an invoice, a budget
reservation, or a claim that caching has no production value. Use the same frozen
model prices and token accounting conventions for both arms.

Pass every call receipt for one arm to `auditedFusionCosts(stages)`, including
rejected drafts, retries and calls whose artifacts fail validation. Each stage
must have `status: 'audited'`, nonempty `records` with integer `costMicros` and
`normalizedMicros`, and an exact `newCostMicros` total. The helper checks arithmetic;
the caller must authenticate the receipts and prove the stage list is complete.
An unresolved call or missing usage cannot be treated as zero cost.

Pass complete paired rows to `screenFusionCosts(records, taskCount)`. Each row
contains `id`, `strategy` (`strong` or `cascade`) and both cost totals. Duplicate,
missing or invalid costs fail closed. A zero control denominator is ineligible.

Freeze `costBasis: 'invoice-and-cache-neutral-v1'` in new experiment protocols
before generating outcomes. Do not change historical protocol semantics or
rewrite archived results. A supplemental calculation on old receipts must be
labelled retrospective. Passing this cost screen still requires separate quality,
latency and independent held-out confirmation before any promotion.
