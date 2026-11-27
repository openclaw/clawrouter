# Cost-matched random controls

`compareRandomControl` in `scripts/fusion-random-control.mjs` computes a
query-independent control from existing paired evaluation records. It makes no
model calls. Supply the normal `evaluateFusion` input, the candidate strategy,
and two to eight fixed control strategies. The default split is `test`; pass
`development` explicitly for development records.

For each control, trials are averaged within each case, then cases receive equal
weight. A fixed mixture uses the same strategy probabilities for every request.
The helper maximizes expected score subject to expected model cost no greater
than the candidate's mean cost. It considers affordable fixed controls and all
two-control mixtures crossing that budget. One linear cost constraint needs at
most two controls at an optimum. Ties prefer lower cost, then lower mean latency.
Failed attempts stay in the evaluation; incomplete pairs are rejected.

For example, a control costing 10 with score 0 and one costing 110 with score 1
have expected cost 60 and score 0.5 under a fair coin flip. A router with those
same averages has not shown a score advantage over query-independent selection.
The coin chooses one fixed control strategy per request; it does not execute
both controls or choose the better answer after grading. A control strategy may
itself contain multiple calls, whose full cost and workflow time must be included.

This is a retrospective envelope: mixture weights are fitted to the supplied
outcomes. It is a diagnostic control, not an evaluated deployment policy.
Freeze weights on development data before measuring them on new tasks. The
reported latency is an expected mean, not a tail-latency guarantee or a constraint
in the optimization. A candidate cheaper than every supplied control returns
`control: null` and null deltas; that is a missing affordable comparison, not a
win. No result qualifies production use or establishes statistical significance.

## Replay of published development results

The following replays use the published usage-derived cost estimates without additional
inference. Scores are equal-case means. Repeated measurements do not increase
the number of distinct tasks. These comparisons are retrospective and do not
establish independent sampling or confidence intervals. Both studies explicitly
used previously exposed tasks. Their fixed controls can make up to two calls;
these are comparisons against randomized control workflows, not single-call models.

| Published study | Distinct tasks / paired samples | Cascade score | Random-control expected score | Cascade mean time | Control expected mean time |
| --- | ---: | ---: | ---: | ---: | ---: |
| [One-cheap repeats](fusion-one-cheap-repeats.json) | 12 / 36 | 100% | 79.95% | 16.77 s | 15.46 s |
| [Anchored transfer](fusion-anchored-transfer30.json) | 30 / 30 | 96.67% | 89.33% | 30.21 s | 21.16 s |

The mixtures choose strong with probabilities 0.39837 and 0.68555 respectively;
otherwise they choose cheap. Both match the cascade's mean estimated API cost.
The observed cascades exceed these controls' expected scores by 20.05 and 7.34
percentage points, but remain slower. This supports further investigation of
selective verification, not a production gain or a reason to relax the existing
no-slowdown requirement. No confidence claim follows from these point estimates.

To reproduce either row from the repository root:

```js
import { readFileSync } from 'node:fs';
import { compareRandomControl } from './scripts/fusion-random-control.mjs';

const study = JSON.parse(readFileSync('docs/fusion-anchored-transfer30.json'));
const records = study.records.map(row => ({
  caseId: row.caseId, domain: 'undici', trial: row.repeat ?? 1,
  strategy: row.strategy, configurationId: row.strategy,
  score: row.passed ? 1 : 0, costMicros: row.costMicros,
  latencyMs: row.elapsedMs, callCount: row.callCount ?? row.attempts ?? 1,
  status: 'completed',
}));
console.log(compareRandomControl({
  version: 1, evaluationId: 'retrospective', datasetRevision: 'published',
  graderRevision: 'published', split: 'development', records,
}, 'cascade', ['cheap', 'strong'], 'development'));
```

Completed failed tests have score zero. Transport-incomplete records cannot be
converted to completed observations with this example; stop and reconcile them
first. The two cited artifacts contain completed paired observations.

The October 2026 preprint [Dynamic LLM Routers are Often
Misguided](https://arxiv.org/abs/2610.02762) compares commercial routers against
cost-matched random selection and motivates this control. Its reported results
do not establish how ClawRouter performs. [GitHub's Fusion
documentation](https://docs.github.com/en/copilot/concepts/models/copilot-fusion)
also describes adding review calls selectively and considering cache boundaries;
our comparisons must include those calls and actual workflow time.
