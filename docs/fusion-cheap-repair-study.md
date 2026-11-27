# Cheap repair before strong fallback

A five-task development trial retained 5/5 correct outcomes while reducing
estimated model cost by 52.1% against its strong-only control. Its measured
workflow time was 6.5% higher. This is a development cost result, not independent
confirmation or a production recommendation.

The [complete sanitized data](fusion-cheap-repair-study.json) includes both
trials, all 30 outcomes, call counts, costs, times and source/protocol/result/audit
hashes. Both trials completed replay audits.

| Policy and trial | Strong correct | Cascade correct | Cheap-only correct | Cascade cost vs strong | Cascade time vs strong |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fresh fallback, initial exploratory trial | 5/5 | 5/5 | 4/5 | 3.7% higher | 27.3% higher |
| Cheap repair, later development trial | 5/5 | 5/5 | 4/5 | 52.1% lower | 6.5% higher |

The first policy escalated every admitted cheap draft to a fresh strong call.
It preserved quality but failed the cost and latency screen. The later policy
allowed one verified cheap repair before that fallback. All three admitted
cases finished without a strong call in that trial; the other two cases kept
the existing strong bypass. Consequently, this result demonstrates cheaper
execution, not a measured benefit from model collaboration. Neither trial is
marked as a production gain.

The later trial used the same tasks after the first results were known. It is
outcome-informed development. Each policy has only one sample per task, and the
trial order differs. The numbers do not isolate the repair option from model
randomness. New tasks and repeated comparisons are required before promotion.

The parent screen tested 12 cached fixtures and qualified five, missing its
six-task target. Seven exclusions remain excluded. Reference public/full tests
had to pass, while baseline public/full tests had to fail with matching test
counts and no skips. All five retained cases use explicitly cached manifest
dependency fixtures; they do not establish original-lockfile compatibility.

Every attempt, including failed drafts and repairs, contributes to model cost.
The estimates use frozen tariffs and recorded token usage; provider invoices
were not independently reconciled. Workflow time includes model dispatch,
decoding and public verification. Final full-suite grading is outside that
interval. The two trials added $0.097008 to the experiment ledger.

`draftAttempts: 2` in the [caller-side workflow](fusion-router.md) exposes the
bounded repair option. Callers must reserve for all allowed attempts, retain
failures and qualify their own verifier. Defaults remain unchanged.
