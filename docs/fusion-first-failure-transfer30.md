# First-failure feedback: thirty-task development transfer

The complete cohort **passes the declared development screen**. All three
batches passed exact saved-request, cost and isolated-runtime replay audits.

Full grading across thirty tasks gives **29/30 for both cascade and strong**,
with no lost strong-only successes or observed cascade false accepts. Cheap-only
solves 19/30. Cascade uses **38.84% less model cost** and **2.35% less workflow
time**, clearing the declared development screen. This is not a production gain.

| Accounting batch | Strong | Cascade | Cheap | Cascade cost / strong | Cascade time / strong |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 10/10 | 10/10 | 6/10 | 0.7005 | 1.0580 |
| 2 | 9/10 | 9/10 | 7/10 | 0.4528 | 0.9201 |
| 3 | 10/10 | 10/10 | 6/10 | 0.6624 | 0.9723 |
| Complete cohort | 29/30 | 29/30 | 19/30 | 0.6116 | 0.9765 |

## Fixed comparison

This follows the [anchored-edit comparison](fusion-anchored-transfer30.md) on
the same thirty previously exposed Undici tasks. It keeps the original public
and full test fixtures, source anchors, model pool, attempt limits and order.
The models are `openai/gpt-6-luna` and `openai/gpt-6.1-terra`.

The cascade gets one cheap attempt, followed by a fresh strong fallback and at
most one strong repair. Strong-only and cheap-only each get at most two
attempts. All three arms use failure-stop public verification with the original
five-second Node test deadline. Full grading remains unchanged.

Repair prompts explicitly select the first complete test failure, then
normalize temporary loopback URL ports. The verifier retains its original
acceptance checks and raw output. Tests may finish while cancellation travels
through the runner, so full output can have different trailing failures and
counts even when the first assertion is unchanged. Selecting that assertion
keeps useful error, expected/actual, location and stack information without
depending on the cancellation tail. Unsupported output keeps its raw feedback.
Generic process wrappers do not replace the original syntax/import diagnostic.
The selector is tracked in [the first-failure helper PR](https://github.com/openclaw/clawrouter/pull/1340);
the [loopback-port helper](fusion-feedback-ports.md) is already merged.

This policy was qualified without model calls against eight repair contexts,
twice each, from the interrupted failure-stop trial: fifteen retained raw
replays plus the one missing repeat. The original failed trial stays
unqualified; its invoices remain in cumulative spend. Passing that diagnostic
check permits this new study, not retroactive acceptance of old requests.

## Costs and timing

The 117 calls total **$0.600842** in usage-derived model-cost estimates: strong
$0.343049, cascade $0.209793 and cheap $0.048000. Cache-neutral totals are
$0.343052, $0.209795 and $0.048002. The estimated model-cost saving is about
$0.004442 per task before verifier costs. Cumulative campaign spend is
**$321.351371 of $400**, leaving **$78.648629**, including the excluded failed
trial's $0.248096. No new download or compute allocation was made.

Summed workflow time is 552.11 seconds for strong-only and 539.16 seconds for
cascade. The smaller model alone takes 379.13 seconds but loses ten successes
relative to the cascade. Cheaper output alone does not satisfy the quality gate.

## Interpretation

The thirty tasks form one development draw in three disjoint accounting
batches, not three repeats. They span twenty source files in one previously
exposed repository. No fresh-task generalization is established.

The screen requires no false accepts or lost strong successes, quality at
least strong and above cheap, recorded and cache-neutral model-cost ratios at
most 0.8, and workflow-time ratio at most 1.2. The complete cohort determines
the result; favorable batches do not replace it.

Workflow timing includes model calls, public verification and orchestration.
Independent full grading and replay audit run afterward and are excluded.
These serial local measurements do not establish service latency, CPU cost,
throughput or total dollar savings. New model responses are stochastic, so
differences from the earlier draw cannot be attributed solely to the verifier
or feedback changes.

No service is deployed and no production defaults change. This caller-side
cascade is separate from the Worker ensemble endpoint.

## Recompute

The [sanitized data](fusion-first-failure-transfer30.json) retains every outcome,
public source revision and protocol/result/audit hash. It excludes prompts,
completions, credentials and private machine paths.

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeTransfer } from './scripts/fusion-repeatability-summary.mjs';
const report = JSON.parse(readFileSync('docs/fusion-first-failure-transfer30.json', 'utf8'));
assert.equal(report.audited, true);
assert.deepEqual(summarizeTransfer(report.records, report.taskIds), report.summary);
console.log(report.summary);
JS
```

This recomputes published arithmetic, not runtime provenance. Reproducing the
isolated checks requires the retained fixtures and receipts. The failed shared
task remains in the denominator. The result supports a larger independent
evaluation; it does not establish generalization to unseen repositories.
