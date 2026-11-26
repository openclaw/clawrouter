# Six-case Fusion pilot and uninterrupted repeat

The caller-side cascade matched the strong model on all six repairs in both
draws. The first draw used **29.00% less model cost**, but its interrupted
execution cannot qualify timing. The uninterrupted repeat used **62.32% less
model cost** and **21.15% less workflow time**. Both draws passed saved-request,
usage-accounting and isolated-runtime replay audits.

These are six tasks, not twelve independent tasks. The repeat uses the same
exposed cases. This is pilot evidence, not production qualification.

| Draw | Strong | Cascade | Cheap | Strong model cost | Cascade model cost | Cascade cost / strong | Workflow time / strong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial, recovered | 6/6 | 6/6 | 5/6 | $0.122851 | $0.087225 | 0.7100 | Unqualified |
| Uninterrupted repeat | 6/6 | 6/6 | 5/6 | $0.122781 | $0.046259 | 0.3768 | 0.7885 |

Neither draw had an observed cascade false accept or lost strong-model success.
The cascade escalated three times initially and once in the repeat. Escalation
counts are public-workflow recoveries; they do not mean three extra successes
over the cheap-only control. The cascade gained one full-test success over
cheap-only in each draw.

## Cases and qualification

The six cases cover six source files in Undici. Each had a passing reference
fix, a failing unchanged baseline, a public test subset and additional held-out
tests before model evaluation. All eligible cases from three completed
model-free qualification groups entered the pilot: one large-artifact case,
three repaired test-fixture cases and two baseline-census cases.

The earlier ten-case screen qualified zero cases. Missing test packages and
baselines that left handles open prevented useful verdicts. Separately pinned
follow-ups used exact lockfile packages and retained the original source and
tests. Two unchanged baselines used Node's `--test-force-exit` only after their
complete suites finished. Reference fixes and generated candidates never used
that option. Qualification still required matching complete test counts, no
skips, passing references and failing baselines. A reference timeout and a
baseline that passed were retained as exclusions.

The [data file](fusion-six-case-pilot.json) identifies every selected public
source revision, fixture hash and full/public test count. The six cases had no
recorded prior model exposure at the initial freeze. This does not establish
absence from model training data.

## Fixed policy and the interruption

The models were `openai/gpt-6-luna` and `openai/gpt-6.1-terra`. The cascade made
one cheap attempt, then used a fresh strong fallback with at most one repair
when public verification rejected it. Strong-only and cheap-only each had at
most two attempts. All arms received the same original source and full public
test text. Anchored edits targeted the immutable original files.

Public verification used the original five-second Node test deadline and
first-failure diagnostic selection. Full grading retained the original tests
and ran after model evaluation. A public pass alone was not a final success.

The first draw stopped after three paid calls when a repair request exceeded
its byte limit before candidate compaction ran. The fix moved lossless
candidate compaction before that check. It changed diagnostic representation,
not the candidate submitted to tests. Replay verified that all three already
sent request bodies were unchanged. Recovery audited and reused their receipts
without sending those calls again. The entire first draw remains in cost and
quality accounting, but its timing and routing-lead claim are unqualified.

The second draw used the fixed construction from the start, with the same
cases, model settings, attempt limits and order seed. It completed without
recovery. Its summed workflow times were **56.63 seconds for strong-only** and
**44.65 seconds for cascade**. Model calls, public verification and orchestration
are included; independent full grading and audit replay are excluded.

## Cost and interpretation

All 44 model calls across both draws cost **$0.414932** in usage-based model-cost
estimates, including the interrupted prefix. Recorded and cache-neutral costs
agree. Cumulative campaign cost was **$321.766303 of $400**, leaving **$78.233697**.
No new compute resource or model download was allocated for these draws.

The uninterrupted repeat passes the declared pilot screen: no false accepts or
strong losses, quality at least strong and above cheap, model-cost ratios at
most 0.8, and workflow-time ratio at most 1.2. It does not establish production
generalization. Six selected repairs in one repository, two stochastic draws
and one qualified timing sample cannot establish service latency, throughput,
verifier operating cost or total dollar savings. The difference between the
two cost ratios also shows why the best draw should not stand alone.

This report extends the [thirty-task development result](fusion-first-failure-transfer30.md).
It does not activate a service or change production defaults. The caller-side
cascade remains separate from the Worker ensemble endpoint.

## Recompute

The sanitized data retains all 36 outcomes and both protocol/result/audit
digests. It excludes prompts, completions, credentials and private paths.
Unqualified initial timing is omitted rather than mixed into the repeat.

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeTransfer } from './scripts/fusion-repeatability-summary.mjs';
const report = JSON.parse(readFileSync('docs/fusion-six-case-pilot.json', 'utf8'));
assert.equal(report.audited, true);
const ids = report.cases.map(c => c.id);
for (const study of report.studies) {
  assert.equal(study.records.length, ids.length * 3);
  const costs = Object.fromEntries(['strong', 'cascade', 'cheap'].map(strategy =>
    [strategy, study.records.filter(r => r.strategy === strategy)
      .reduce((sum, r) => sum + r.costMicros, 0)]));
  assert.equal(Object.values(costs).reduce((a, b) => a + b), study.newCostMicros);
  console.log(study.name, costs, costs.cascade / costs.strong);
  if (study.timingQualified) {
    console.log(summarizeTransfer(study.records, ids, { expectedTasks: 6 }));
  } else {
    assert.ok(study.records.every(r => !Object.hasOwn(r, 'elapsedMs')));
  }
}
JS
```

This recomputes published arithmetic, not runtime provenance. Replaying the
isolated checks requires the retained fixtures and receipts identified by the
hashes. A larger independent workload remains necessary.
