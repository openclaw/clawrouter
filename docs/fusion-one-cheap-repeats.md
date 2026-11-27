# One cheap attempt, verified strong fallback

Across three development draws, the cascade and strong control each solved
**36/36 paired samples**; cheap-only solved **24/36**. The cascade used
**50.92% less model cost** with **8.06% more workflow time** than strong-only.
All three draws passed the declared cost, time and quality gates, with zero
cascade false accepts and zero lost strong-control successes.

This is a repeatable efficiency lead on **twelve exposed tasks**, not higher
accuracy than the strong model or production qualification. All three draws
passed saved-call and isolated-runtime replay with unchanged verdicts and costs.

| Draw | Strong solved | Cascade solved | Cheap solved | Cascade cost / strong | Cascade time / strong | Efficiency gates |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 12/12 | 12/12 | 8/12 | 0.5418 | 0.9403 | Pass |
| 2 | 12/12 | 12/12 | 8/12 | 0.4774 | 1.1573 | Pass |
| 3 | 12/12 | 12/12 | 8/12 | 0.4556 | 1.1435 | Pass |
| Aggregate | 36/36 | 36/36 | 24/36 | 0.4908 | 1.0806 | Pass |

The cascade escalated five times per draw. A separate cheap control can succeed
when the cascade's independently generated cheap draft fails; these are matched
tasks, not shared samples. The third draw also contains a cheap-control full-test
timeout, retained as a failure with its cost. No completed draw was replaced by
a more favorable rerun.

## Accounting

The three draws made 147 model calls at a total estimated cost of **$0.621608**:
strong $0.378010, cascade $0.185525, cheap-only $0.058073. Cumulative experimental
spend is **$319.053340 of $400**, leaving **$80.946660**. Earlier campaign spend is
not attributed to these draws. The two follow-up draws cost $0.412759 combined,
within their $20 additional cap. No new model, dataset, package or compute
resource was acquired for these draws.

## Method

This development study tests one cheap attempt on each of twelve historical
Undici repairs. If public verification rejects it, a fresh strong attempt runs
without the rejected draft. That strong attempt can use one repair if its own
verification fails. Strong-only and cheap-only controls each allow two attempts.
The models are `openai/gpt-6-luna` and `openai/gpt-6.1-terra`.

The twelve tasks span ten source files, with at most two tasks per file. They
include every eligible task from two earlier screens plus a separately qualified
garbage-collection fixture. The original screens qualified six of fourteen and
five of eighteen candidates; their exclusions remain exclusions. Reference
patches pass all declared tests, and original sources fail their regression
checks. The public tests drive escalation; separate full tests grade outcomes.

These tasks were already exposed in the
[combined pilot](fusion-cross-cohort-pilot.md). That pilot missed its cost gate.
The new policy changes both admission and cheap-attempt count, so this study
cannot isolate their individual effects. It tests the combined policy.

After the first development draw, two further draws were predeclared with fixed
order seeds. Each run retained every outcome and completed its saved-call and
runtime replay before its successor began. The models, tasks, public/full tests,
context and controller settings stayed fixed. These are twelve unique tasks
sampled three times, not thirty-six independent tasks.

The predeclared repeatability screen requires zero false accepts or losses of
strong-control successes in every repeat; aggregate cascade quality at least
strong and above cheap; aggregate model-cost ratio at most 0.8 on both recorded
and cache-neutral tariffs; aggregate workflow-time ratio at most 1.2; and the
efficiency gates in at least two repeats. All three repeats must be present.

The [machine-readable report](fusion-one-cheap-repeats.json) retains all 108
outcomes, including invalid artifacts and the timeout, with protocol, result
and audit hashes for each draw. To recompute its summary without model calls:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeRepeatability } from './scripts/fusion-repeatability-summary.mjs';
const report = JSON.parse(readFileSync('docs/fusion-one-cheap-repeats.json', 'utf8'));
const summary = summarizeRepeatability(report.records, report.taskIds, {
  expectedTasks: 12,
  costBasis: 'invoice-and-cache-neutral-v1',
});
assert.deepEqual(summary, report.summary);
console.log(summary);
JS
```

This recomputes the public analysis. Replaying inference or isolated tests also
requires the retained source, fixtures and private call receipts.

## Caller-side integration

The existing [verified workflow helper](../scripts/fusion-verified-workflow.mjs)
can express this policy with at most three model calls:

```js
const result = await runVerifiedWorkflow({
  strategy: 'cascade',
  draftAttempts: 1,
  fallbackMode: 'fresh',
  fallbackAttempts: 2,
  models: { draft: cheapModel, repair: strongModel },
  invoke,
  verify,
  signal,
});
```

`invoke` must reserve a conservative budget before dispatch, honor cancellation
and return `{ artifact, costMicros }`. It receives a stage and model, plus the
previous artifact and verification feedback only for a repair. `verify` must run
isolated checks and return boolean `runtimePassed` and `compilerPassed` fields.
Only checks available to the caller should influence escalation. Keep held-out
grading separate. A provider error or uncertain charge stops the workflow.

The caller still owns adapters, prompt construction, verification, accounting
and artifact storage. This helper is separate from the Worker `ensemble`
endpoint. The study does not validate that endpoint, deploy a service, or change
production routing defaults.

## Measurement limits

Costs are usage-derived estimates under frozen tariffs, not independently
reconciled invoices. They include rejected drafts and repairs. Cache-neutral
costs prevent discounted prompt reuse from establishing the cost gate.
Workflow time includes inference and public verification but excludes later
full-test grading and audit replay. Ratios divide summed complete arm costs and
times; they are not means of per-task ratios. Serial local measurements do not
establish service latency or throughput.

Repeated draws measure variability on exposed tasks. They do not establish
independent-task generalization, pretraining novelty, stronger accuracy than
the strong control, or savings on tasks without effective verification. Transfer
to a separate qualified corpus remains necessary before broader use.
