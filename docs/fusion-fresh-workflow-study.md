# Interrupted fresh-fallback study

The fresh-fallback cascade was cheaper, but lost a strong-only success and
failed replay. It does not qualify as a successful confirmation or a production
policy. The [recorded data](fusion-fresh-workflow-study.json) preserves the
failure, incomplete schedule, original timing and all recorded model charges.

## Recorded outcomes, not a completed confirmation

The protocol planned 30 tasks × three trials × three arms. Execution stopped
after 240 of 270 rows: 20 tasks have three paired trials and ten have two.
Seven batches (210 rows) passed independent replay. The eighth batch contains
30 original graded rows but failed replay; the ninth was never started.
Neither missing rows nor failed replay are treated as successful observations.

| Arm | Original full successes | Recorded model charges | Sum of original workflow seconds |
| --- | ---: | ---: | ---: |
| Strong-only | 80/80 | $0.645966 | 941.187 |
| Fresh-fallback cascade | 79/80 | $0.282093 | 1,037.658 |
| Cheap-only | 75/80 | $0.077894 | 938.843 |

Those are raw observed totals. Equal-task weighting, averaging available trials
within each task, gives 55.4% lower cascade cost and 10.7% higher latency than
strong-only. Cache-neutral equal-task cost is also 55.4% lower. These descriptive
ratios include the unreplayed batch and are not a completed-study efficacy claim.
One individual batch took 2.18 times the strong-only time; it is retained.

There were five paired cascade wins over cheap-only: four used a successful
strong fallback and one used a different successful cheap sample. One paired
loss offsets those wins. That loss was a publicly accepted draft whose full
grade failed. Counts of fallback use alone are not counts of collaboration gains.

The admitted stratum contains 26 tasks and 70 recorded runs per arm: strong-only
70/70, cascade 69/70 and cheap-only 65/70. The four bypass tasks contribute ten
runs per arm, all successful. Original-lock environments contribute 53 runs per
arm (53/52/48 successes for strong/cascade/cheap); the ten manifest-fixture tasks
contribute 27 runs per arm, all successful.

## Why replay stopped

The affected task repairs ETag revalidation in `lib/handler/cache-handler.js`.
The cheap draft set a revalidation-only entry's stale time to `now`. The cached
interceptor tests `now > staleAt`; reuse in the same millisecond therefore
appears fresh and skips revalidation. The strong answer used `now - 1`.

The original public check passed, but full grading failed the ETag-reuse test.
That test was already public: this was unstable public verification, not missing
held-out coverage. Replay rejected the same draft and tried to take a fallback
that the original run never made. The absent recorded request stopped the audit
and serial driver. No fallback was synthesized and no paid call was retried.

A separate, model-free probe of the unchanged public suite reproduced 59/60
passing tests for the saved draft. A second diagnostic fixed `Date.now()` only
inside the existing ETag-reuse test: the draft again passed 59/60, while the saved
strong answer passed 60/60. Both passed syntax checks. These exposed-task probes
explain the boundary failure; they do not replace the original verdict or count
as fresh confirmation. Their hashes are included in the data artifact.

The no-lost-strong-success and no-false-accept gates both fail. The one-sided
95% task-loss upper bound is 14.9%, above the declared 5% margin. Source-clustered
intervals span cost ratios 0.243–0.642 and latency ratios 0.795–1.519; interruption
and the failed replay further limit interpretation. No default is promoted.

## Frozen comparison

This prospective study tests the fresh-fallback policy suggested by the
[earlier offline replay](fusion-fallback-repair-study.md). Its 30 tasks had no
recorded prior model calls in this experiment campaign. They span 22 source
files in one repository, Undici. The plan assigns three paired trials of
strong-only, cheap-only and the cascade: 270 planned workflow outcomes.

The small model is `gpt-6-luna`, with low reasoning effort and a 4,096-token
output limit. The strong model is `gpt-6.1-terra`, with low reasoning effort and
an 8,192-token output limit. Both controls can repair their own rejected
candidate once. The fixed admission policy sends 26 tasks through a cheap
draft and bypasses that draft for four tasks. An admitted cascade accepts a
draft only after public verification. On rejection, it starts the strong
workflow from the original context, without the rejected cheap artifact or
its feedback. That strong workflow can repair its own candidate once.

This gives admitted cascades at most three model calls; controls and bypass
cascades have at most two. Failed, invalid and exhausted attempts remain in
the results and accounting. All arms receive the same initial task context.
The executor supplies bounded invalid-edit feedback consistently across arms.
Private full grades never select the next model, change admission or replace
a task. The policy, task roster, order and budget were frozen before inference.

Twenty tasks use their original lock-based test environments. Ten use an
explicit cached manifest fixture because the historical lock was absent.
Fixture preparation checks the original package manifest and dependency
versions. All arms for a task use the same environment. Report these strata
separately; they do not establish interchangeable dependency environments.

## Evidence and limits

Every batch must complete an independent model-free replay before its successor
starts. Replay checks the original requests, candidates, public decisions,
full grades and accounting; it does not make replacement model calls. The
first batch's initial replay timed out after 24 recorded full grades. A
targeted diagnostic and a separately retained instrumented full replay passed
without candidate substitutions. The original failure remains recorded;
its cause was not established.

The development screen requires at least 20% lower model cost, no observed
lost strong-only successes and no more than 20% latency overhead. This is an
observed screen, not a statistical equivalence claim. Report the one-sided
95% bound on tasks with any lost strong success against the predeclared 5%
margin. Repeated trials are paired within tasks; source-clustered intervals
keep related tasks together. Thirty tasks cannot establish a loss probability
below 5% even if no losses occur, and source dependence further limits
generalization.

Historical public repairs may occur in model training data. Locally unexposed
tasks are not proof of training-data independence. This is one repository and
a bounded edit executor, not a general coding-agent benchmark.

Model costs use recorded usage at frozen tariffs, with cache-neutral totals
reported separately. They are not a separately reconciled provider invoice.
Workflow latency uses the original execution, including public verification;
model-free replay time is excluded. Private prompts, model responses and test
fixtures are not published. The public rows reproduce analysis, not inference
or private grading.

The caller-side API already supports this workflow with fresh fallback and
`fallbackAttempts: 2`. This report changes no Worker route, default or
deployment. A measured development gain alone does not authorize production
promotion.
