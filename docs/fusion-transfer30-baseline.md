# One-cheap cascade: thirty-task development transfer

The complete thirty-task cohort **fails the declared gain screen**. Cascade and
strong-only each solve 27/30 tasks, but the cascade loses one strong-only success
and recovers a different task. It uses **40.18% less model cost** and **28.06% more
workflow time**. Cheap-only solves 24/30. Equal aggregate accuracy hides the lost
success; it does not establish quality preservation.

All three accounting batches passed saved-call and isolated-runtime replay
with unchanged outcomes and costs. Audited evidence supports this negative
result; it does not qualify a production gain.

| Accounting batch | Strong | Cascade | Cheap | Cascade cost / strong | Cascade time / strong | Lost strong successes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 9/10 | 9/10 | 8/10 | 0.5781 | 1.1944 | 0 |
| 2 | 9/10 | 8/10 | 8/10 | 0.7143 | 1.1402 | 1 |
| 3 | 9/10 | 10/10 | 8/10 | 0.4997 | 1.5656 | 0 |
| Complete cohort | 27/30 | 27/30 | 24/30 | 0.5982 | 1.2806 | 1 |

These are three disjoint accounting batches of ten tasks, **not three repeats**.
There are thirty unique base revisions in one previously exposed repository,
spread over twenty source files. Thirteen files contribute one task, four
contribute two, and three contribute three. None of the twelve tasks in the
[earlier repeat study](fusion-one-cheap-repeats.md) is included. The cohort is
nevertheless previously exposed development data, not fresh confirmation.

## Fixed comparison

Each task receives one cheap attempt. A failed public check invokes a fresh
strong model, which may repair its own rejected attempt once. Strong-only and
cheap-only controls each get at most two attempts. Models remain
`openai/gpt-6-luna` and `openai/gpt-6.1-terra`. The study retains the original
thirty-task order, public/full test partition, runtime and qualification.
Reference fixes pass the declared checks; original sources fail their regression
checks. All thirty qualified tasks and all ninety outcomes are retained.

The screen requires zero public-check false accepts, zero lost strong-control
successes, cascade quality at least strong and above cheap, both recorded and
cache-neutral model-cost ratios at most 0.8, and workflow-time ratio at most 1.2.
It fails both the lost-success and time gates. There are zero observed public
false accepts; that is not a guarantee for other tasks.

An earlier attempt stopped after a replay mismatch in a Node warning process ID.
Its 43 calls and $0.190716 remain in campaign accounting, excluded from this
study's efficacy analysis. This replacement changes only warning-PID
normalization in feedback, preserving raw evidence and test verdicts. It does
not replace an unfavorable model draw with a favorable draw from that attempt.

## Failure evidence

On `undici-0160a719063f`, strong-only passes all eighteen full tests. Cascade
fails one and cheap-only fails two. The cascade incorrectly resumes a partial
206 response without a usable content-range. Both strong-only and the cascade's
fresh strong fallback received byte-identical saved request bodies and the same
model; they are independent draws. This loss therefore does not establish
contamination by the cheap draft. Source-anchored edits can fix ambiguous edit
locations, but they do not directly fix this reasoning error.

`undici-bee01389d78a` fails public checks in all three arms with decoded, applied
patches. Its deduplication/retry timeouts remain failures. The report retains
null artifacts and every unsuccessful attempt's model cost.

## Costs and time

All three arms make 123 model calls, totaling **$0.609314** in usage-derived
estimates: strong $0.355527, cascade $0.212688, cheap $0.041099. Cache-neutral
costs are $0.355531, $0.212689 and $0.041101 respectively. Model-only savings
are **$0.0047613 per task** against strong-only, before verification costs.
Campaign spend after the study is **$319.853370 of $400**, leaving **$80.146630**.
No new model download or compute allocation was made for this study.

Summed workflow time is 616.65 seconds for strong-only and 789.70 seconds for
cascade. Summed recorded model-call time decreases by 23.56 seconds, while
remaining workflow wall time increases by 196.61 seconds. The latter includes
public verification, orchestration and local overhead; it is not a measured CPU
bill. Hidden full grading and replay audit run afterward and are excluded from
workflow timing. These serial local timings do not establish service latency,
throughput or end-to-end dollar savings.

Source-file cluster bootstrap intervals are descriptive: the cascade accuracy
difference interval spans approximately -9.09 to +9.68 percentage points, cost
ratio 0.438 to 0.719, and time ratio 0.944 to 1.817 (2,000 draws, seed 42).
Resampling keeps related tasks together. Twenty source groups within one exposed
repository do not support a general production noninferiority claim.

## Recompute and scope

The [sanitized data](fusion-transfer30-baseline.json) contains every outcome,
public source revision, accounting batch and protocol/result/audit
hash. It excludes prompts, completions, credentials and private machine paths.
The source revision and qualification hash identify the retained local evidence.

Recompute the complete-cohort summary with:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeTransfer } from './scripts/fusion-repeatability-summary.mjs';
const report = JSON.parse(readFileSync('docs/fusion-transfer30-baseline.json', 'utf8'));
assert.equal(report.audited, true);
assert.deepEqual(summarizeTransfer(report.records, report.taskIds), report.summary);
console.log(report.summary);
JS
```

This checks public arithmetic, not saved-call or runtime provenance. Full replay
requires the retained fixtures and private receipts. No service is deployed and
no production defaults change. This caller-side verified cascade is separate
from the Worker ensemble endpoint. The next controlled study changes only the
edit representation on the same full cohort; it must retain these failures and
must not be described as fresh-task confirmation.
