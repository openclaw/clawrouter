# Check cascade feasibility before another trial

A cheap-first cascade can save model cost while increasing user wait time.
Check those targets separately before paying for a larger experiment. The
[calculator](../scripts/fusion-cascade-feasibility.mjs) estimates the initial
acceptance rate needed under a simple sequential mean-cost model. It does not
qualify a router or predict correctness.

Let `p` be the chance that the initial cheap attempt is accepted, `I` its cost
or time, `F` the mean fallback cost or time **conditional on rejection**, and
`T` the target. The planning inequality is:

```text
I + (1 - p) * F <= T
```

For positive fallback work, the required rate is
`max(0, 1 - (T - I) / F)`. If the initial stage alone exceeds the target, no
acceptance rate can satisfy it. Zero fallback work needs no minimum rate when
the initial stage fits. The calculator reports separate cost and latency
thresholds and takes their maximum.

The defaults require 20% lower model cost and no additional mean latency than
direct strong execution. Supply the complete initial and fallback workflow
times, including verification, accounting and cleanup. Include every paid call
in cost, including rejected attempts. Do not substitute API time for workflow
time or assume fallback timing matches an independent control without stating
that assumption. The model excludes overlap, cancellation, latency percentiles,
and any dependence of initial duration on its outcome.

## Run the calculator

Save measured or explicitly assumed means in a JSON file:

```json
{
  "cheap": { "costMicros": 100, "latencyMs": 4 },
  "fallback": { "costMicros": 1000, "latencyMs": 10 },
  "strong": { "costMicros": 1000, "latencyMs": 10 },
  "costSavingFraction": 0.2,
  "latencyRatio": 1
}
```

```sh
node scripts/fusion-cascade-feasibility.mjs input.json
```

This example needs 30% initial acceptance for cost and 40% for latency. Both
targets therefore need at least 40% under these assumptions. `null` marks an
impossible target; zero means no minimum rate is required by that inequality.
All costs must use the same units, as must all times. A rate of one means every
initial attempt must be accepted.

## Example from a development pilot

A small historical
[dotenv repair](https://github.com/motdotla/dotenv/commit/d57e0bc5824a37c27c3209f688edf35eb8d82505)
compared independent Luna-only, Terra-only and cheap-first draws three times per
arm. Each request received the same original editable source and public tests.
No cache reads or writes were reported. Complete workflow times include public
verification; final full-test grading followed all calls.

| Arm | Full passes | Model cost, microUSD | Mean workflow ms |
| --- | ---: | ---: | ---: |
| Independent cheap-only | 0/3 | 2,897 | 6,428.699 |
| Independent strong-only | 3/3 | 27,680 | 10,397.883 |
| Cheap-first, fresh strong on rejection | 3/3 | 21,324 | 13,961.305 |

The cascade used two fallback calls. There were no public false accepts in this
sample. Its cost was 22.96% lower but its workflow was 34.27% slower. One
cascade initial passed; none of the three independent cheap controls passed.
Those small samples do not establish different underlying success rates.

For an illustrative planning calculation, use the independent cheap means and
**assume** a rejected task's fallback has the independent strong means. The
calculator requires 30.47% initial acceptance for cost and 61.83% for latency.
That is an assumption-dependent target, not a confidence interval, a measured
conditional fallback distribution, or a promise that 62% acceptance will be
sufficient in deployment.

The frozen experiment protocol is
`36d176d4af4b8df642a8dab42c246eef55688dd6925ea044ce3f154f9a5cf299`;
its audit is
`5cf4112fe35c51d4068099c80313aae5b564c341f74b217fb46bb7492e4a0942`.
Raw artifacts remain private. Costs use recorded usage and frozen tariffs,
not an independently reconciled invoice. The historical source may be in
training data. This is one exposed repair task, not nine independent tasks or
a population accuracy estimate.

Use the calculation to reject implausible development plans. Advancing still
requires separate full-correctness checks, representative independent tasks,
and prospectively measured cost and latency. Public acceptance alone can
accept an incorrect repair. No serving default or deployment changes follow
from this calculator or pilot.
