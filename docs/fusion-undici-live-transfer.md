# Live Undici cascade transfer

A cheap-first cascade and independent strong-only control both solved **3/3**
newly selected Undici tasks. The live cascade used **58.85% less model cost**
and **17.68% less measured workflow time**. One cheap draft failed public
verification and triggered a successful fresh strong fallback. All selected
answers passed the withheld full tests, and receipt-only replay reproduced
every outcome and cost.

This is a three-task pilot on a repository already used in development. It
passes the declared development screen, not production qualification or a
statistical generalization claim. The [sanitized data](fusion-undici-live-transfer.json)
retains every arm, including the task where cascading cost more and took longer.
The earlier [SemVer study](fusion-semver-transfer.md) measured replayed costs;
this study actually executed the conditional cascade and measured its public
verification overhead.

## Results

| Upstream repair | Strong | Cascade | Fallback | Strong model cost | Cascade model cost | Strong time | Cascade time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [PONG backpressure](https://github.com/nodejs/undici/commit/b217373bb024cd93f85eb5b3ffd25684855f60f8) | Pass | Pass | No | $0.042131 | $0.003692 | 44.20 s | 19.73 s |
| [Response error body limit](https://github.com/nodejs/undici/commit/105b5d4fac4e2a9072291a0dbca8bff3bcefd50e) | Pass | Pass | Yes | $0.008130 | $0.036027 | 20.49 s | 35.21 s |
| [HTTP/2 timeout backpressure](https://github.com/nodejs/undici/commit/34b27da5ba07ea4cd21e50de56f88373733de8d4) | Pass | Pass | No | $0.061153 | $0.006129 | 25.15 s | 19.01 s |
| **Total** | **3/3** | **3/3** | **1/3** | **$0.111414** | **$0.045848** | **89.84 s** | **73.95 s** |

Seven model calls cost $0.157262 across both arms. These are usage-based
estimates using frozen published tariffs, not a reconciled provider invoice.
On a cache-neutral basis, strong cost $0.115163 and cascade $0.038443, a
**66.62% reduction**. Normalization prices all input tokens at the frozen
uncached rate. It does not estimate cache-neutral latency.

The body-limit task is an important counterexample: the cascade's rejected
draft plus fallback cost 4.43 times the direct control and took 1.72 times as
long. Its strong control received more cached input. Even after cost
normalization, cascading cost 7.61% more on that task. Aggregate savings do
not guarantee savings for an individual request.

## Fixed protocol

The models were `openai/gpt-6-luna` and `openai/gpt-6.1-terra`, each with medium
reasoning, an 8,192-token output limit and a 180-second request timeout. Both
arms received identical original source and public-test context. Strong-only
made one direct call. Cascade made one cheap call, verified it, and bought at
most one fresh strong call on rejection. The fallback received the original
task, without the rejected draft or feedback. This demonstrates useful
verification and escalation, not information-sharing synergy between models.

Task order was frozen before inference. Arm order alternated strong/cascade,
cascade/strong, strong/cascade. The maximum was nine calls, with a $2 study cap
and $0.50 per-arm cap. Actual dispatch used seven calls. An independent
cheap-only arm was not run; do not treat the cascade's two accepted cheap
drafts as a complete cheap-only benchmark.

Candidates returned strict anchored edits to declared source files. Context
contained editable originals, their direct production dependencies, public
tests and recursively required test helpers from the parent revision. Models
could not edit tests or add dependencies. Type and documentation changes in
the upstream commits were outside the runtime JavaScript task.

All three candidates qualified before inference. Their unchanged baselines
failed, reference repairs passed, and both executed matching test counts with
zero skips. Public/full counts were respectively 2/3, 13/14 and 4/5. One
deterministic test group was withheld per task. Tests were not relaxed after
observing model output. All full tests ran only after every live arm finished.

The exact selected IDs and commits were absent from 853 saved campaign
protocols and 170 call journals checked before freezing. Undici itself had
been used extensively in the campaign; this is new-task transfer within an
exposed repository, not a new-repository or training-data decontamination claim.

## Timing, audit and limits

Reported time sums the live arms, including request admission and metadata
checks, API time, decoding, and public-test verification. It excludes later
full grading and receipt replay. Sandboxes reused the cached Node 24.22.1
Linux/ARM64 image and lock-qualified test libraries, with networking disabled
and test files protected. No new compute allocation, model download or
dependency installation was required.

The replay audit reused the seven saved responses, reran public and full
verification, and reproduced the original records exactly. It preserved the
original measured times; replay is not a second latency measurement. Evidence
hashes and per-call usage are in the data file. Raw responses and the private
benchmark harness are not bundled, so the public artifact supports arithmetic
checks rather than independent runtime reproduction.

This sample supports a live development lead: quality matched, model cost fell
by at least 20% on both price bases, one escalation succeeded, and total time
was below 1.2 times control. Three tasks and one draw per arm cannot establish
failure rates or a stable speedup. Public tests are a partial specification;
local verification has unpriced infrastructure cost. Timing varies with
provider load and caching. Production defaults and deployed routing are
unchanged.

## Recompute published totals

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync('docs/fusion-undici-live-transfer.json', 'utf8'));
assert.equal(r.records.length, 6);
assert.equal(r.calls.length, 7);
for (const strategy of ['strong', 'cascade']) {
  const rows = r.records.filter(x => x.strategy === strategy);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(x => x.caseId)).size, 3);
  const sum = key => rows.reduce((n, x) => n + x[key], 0);
  assert.equal(rows.filter(x => x.passed).length, r.summary[strategy].passed);
  assert.equal(sum('costMicros'), r.summary[strategy].costMicros);
  assert.equal(sum('normalizedMicros'), r.summary.costComparison[strategy].normalizedMicros);
  assert.equal(sum('elapsedMs'), r.summary[strategy].elapsedMs);
  for (const row of rows) {
    const calls = r.calls.filter(x => x.caseId === row.caseId && x.strategy === strategy);
    assert.equal(calls.length, row.escalated ? 2 : 1);
    assert.equal(calls.reduce((n, x) => n + x.costMicros, 0), row.costMicros);
    assert.ok(row.publicPassed && row.full.valid && row.full.passed);
    const task = r.cases.find(x => x.id === row.caseId);
    assert.equal(row.full.tests, task.expectedTests.full);
  }
}
assert.equal(r.records.filter(x => x.escalated).length, r.summary.escalations);
assert.equal(r.calls.reduce((n, x) => n + x.costMicros, 0), r.actualExperimentCostMicros);
console.log(r.summary);
JS
```
