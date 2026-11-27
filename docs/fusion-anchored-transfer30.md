# Anchored edits: thirty-task development transfer

The complete cohort **fails the declared gain screen**. Cascade and strong-only
each solve 29/30 tasks, with no lost strong-only successes or observed public
false accepts. Cascade uses **27.41% less model cost**, but **77.86% more workflow
time**. Cheap-only solves 22/30. This is a development result, not a production
gain.

All three batches passed saved-call and isolated-runtime replay. The report
retains all thirty tasks and ninety outcomes, including the unsuccessful task.

| Accounting batch | Strong | Cascade | Cheap | Cascade cost / strong | Cascade time / strong |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 10/10 | 10/10 | 7/10 | 0.5309 | 2.0147 |
| 2 | 9/10 | 9/10 | 7/10 | 0.5906 | 1.1483 |
| 3 | 10/10 | 10/10 | 8/10 | 1.1405 | 2.6286 |
| Complete cohort | 29/30 | 29/30 | 22/30 | 0.7259 | 1.7786 |

## Fixed comparison

This follows the [stable-feedback baseline](fusion-transfer30-baseline.md) on
the same previously exposed tasks. It changes the edit representation to
numbered source anchors, with exact text, original-source hashes and atomic
nonoverlapping edits. It retains the task order, original public/full fixtures,
models, routing policy and attempt limits. The models remain
`openai/gpt-6-luna` and `openai/gpt-6.1-terra`.

The cascade gets one cheap attempt, then a fresh strong fallback with at most
one repair if public checks reject the draft. Strong-only and cheap-only each
get at most two attempts. This is one draw on thirty tasks in three disjoint
accounting batches, not three repeats. The cohort spans twenty source files in
one previously exposed repository. No fresh-task generalization is established.

The screen requires zero false accepts, zero lost strong successes, quality at
least strong and above cheap, recorded and cache-neutral model-cost ratios at
most 0.8, and workflow-time ratio at most 1.2. It fails the time gate. The third
batch also costs more than strong-only; favorable batches do not replace the
complete-cohort result.

The prior lost-success case, `undici-0160a719063f`, passes all eighteen full
tests in both strong and cascade arms in this draw. That is not evidence that
anchors alone fixed the reasoning error: model outputs are new stochastic draws.
`undici-bee01389d78a` still fails public checks in all three arms and remains in
the denominator.

## Costs and timing

The 123 calls total **$0.649063** in usage-derived model-cost estimates: strong
$0.350010, cascade $0.254089 and cheap $0.044964. Cache-neutral costs are
$0.350013, $0.254091 and $0.044965. Cascade saves about **$0.003197 per task**
against strong-only before verification costs. Campaign spend is
**$320.502433 of $400**, leaving **$79.497567**. No new download or compute
allocation was made for this study.

Summed workflow time is 509.48 seconds for strong-only and 906.17 seconds for
cascade. It includes visible verification and orchestration. Independent full
grading and replay audit run afterward and are excluded. These serial local
wall times do not establish service latency, CPU cost, throughput or end-to-end
dollar savings.

The next isolated comparison replays the saved final artifacts with ordinary
and early-stop verification in fresh sandboxes, retaining the existing
five-second Node test deadline. That comparison makes no model calls and can
establish verifier behavior only. Its timings must not be substituted into this
study or described as a new model trial.

## Recompute and scope

The [sanitized data](fusion-anchored-transfer30.json) includes every outcome,
public source revision and protocol/result/audit hash. It excludes prompts,
completions, credentials and private machine paths.

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeTransfer } from './scripts/fusion-repeatability-summary.mjs';
const report = JSON.parse(readFileSync('docs/fusion-anchored-transfer30.json', 'utf8'));
assert.equal(report.audited, true);
assert.deepEqual(summarizeTransfer(report.records, report.taskIds), report.summary);
console.log(report.summary);
JS
```

This checks published arithmetic, not runtime provenance. Reproducing the
isolated checks requires the retained fixtures and receipts. No service is
deployed and no production defaults change. This caller-side cascade remains
separate from the Worker ensemble endpoint.
