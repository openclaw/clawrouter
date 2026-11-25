# Single-draw Fusion transfer summaries

`summarizeTransfer` in `scripts/fusion-repeatability-summary.mjs` summarizes one
draw on every declared task. Accounting batches do not create extra repeats.
The default cohort has 30 unique task IDs and exactly 90 outcomes: one each for
`strong`, `cascade`, and `cheap`. An explicitly different cohort size must be
declared through `expectedTasks` before evaluating the results.

Each row supplies `caseId`, `strategy`, `costMicros`, `normalizedMicros`,
`elapsedMs`, `publicPassed`, `fullValid`, `fullPassed`, and `passed`. Do not add
`repeat`; use `summarizeRepeatability` for repeated draws. Missing, duplicate,
unknown, inconsistent, or non-finite observations fail validation. Normalize
costs to the same cache-neutral pricing basis before calling the helper.

The development screen requires no false accepts or lost strong successes,
quality at least as high as strong and higher than cheap, both cost ratios at
most 0.8, and a workflow-time ratio at most 1.2. One loss vetoes the screen even
if a rescue elsewhere makes the aggregate pass counts equal.

This helper validates supplied observations, not their provenance. Before using
it for a report, verify the frozen cohort, source and protocol hashes, completed
replay audits, and chained cost receipts. Report prior task exposure and shared
source groups separately. A passing screen does not establish fresh-task
generalization or production quality; `qualifiedProductionGain` stays false.
