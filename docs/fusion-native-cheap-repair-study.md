# Native Fusion: cheap-repair policy comparison

**Keep the current cheap → strong → strong policy.** Replacing its first strong
fallback with a second cheap attempt solved 29/30 tasks, versus 30/30 for both
the current policy and strong-only. The candidate saved 17.12% against the
current policy and took 11.05% more mean workflow time. It fails the predeclared
quality and 20% savings gates. No serving policy or default changes.

| Arm, up to three calls | Full-suite passes | False accepts | Model cost | Mean workflow time |
| --- | ---: | ---: | ---: | ---: |
| Candidate: cheap → cheap → strong | 29/30 | 0 | $0.063159 | 8.568 s |
| Current: cheap → strong → strong | 30/30 | 0 | $0.076203 | 7.716 s |
| Strong → strong → strong | 30/30 | 0 | $0.217653 | 7.518 s |

The paired regression is `process-warning-11c73b622aa2`: the candidate exhausted
three calls without a public pass. The current policy passed after its strong
fallback; strong-only passed on its first call. The candidate has fewer strong
attempts available after a failed cheap repair. This run does not establish
that this mechanism caused the regression; model outputs are stochastic.

## Method and uncertainty

The study reuses all 30 qualified historical development tasks from the
[three-attempt confirmation](fusion-native-three-attempt-study.md), spanning
14 repositories. It uses one draw per task and arm, not three repeats. The
models remain `openai/gpt-6-luna` and `openai/gpt-6.1-terra`, with low reasoning
and respective output limits of 4,096 and 8,192 tokens. Three fixed ten-task
groups rotate arm order with offsets 0, 1 and 2. Every arm stops on the first
public pass. Each repair receives the latest failed artifact and bounded public
feedback. All 90 workflows completed inference before any full-suite grading.

Native execution checks syntax and exact test counts. Full tests include the
same withheld groups as the predecessor; most check preservation. These tasks
have previous exposure and do not establish unseen-regression performance.
The [machine-readable evidence](fusion-native-cheap-repair-study.json) includes all
110 call charges, paired outcomes, source revisions and private receipt digests.
Raw requests, responses and private drivers are omitted; this permits arithmetic
verification, not independent end-to-end reproduction.

The screen requires no paired task regression against either control, zero
false accepts, at least 20% lower model cost and no more than 20% higher mean
workflow time than the current policy. Ratios use totals over complete paired
arms. Workflow time includes request setup, inference, accounting, syntax
preflight, public native verification and cleanup; it excludes initial runtime
admission and later full grading. It is not service latency.

A prespecified repository-cluster bootstrap retains every paired task within
each sampled repository: 10,000 draws, seed 20261128, xorshift32, sorted repository
names and percentile indices `floor(p * (draws - 1))`. The 95% intervals are:

- Cost savings versus current policy: **−11.45% to 41.31%**.
- Mean workflow slowdown: **2.58% to 23.74%**.
- Quality difference: **−13.04 to 0 percentage points**.

One historical draw cannot establish quality equivalence. These intervals
describe this small cohort and do not remove selection or prior-exposure bias.
Recompute the summary and verify charges with:

```sh
node --test test/fusion-native-cheap-repair-study.test.mjs
```

## Accounting and decision

This run used **$0.357015**, bringing usage-derived campaign spending to
**$334.560769 of $400**, leaving **$65.439231**. Its maximum reservation was
$25.852749, not a charge. All attempts are counted. Frozen input/output tariffs
per million tokens are $0.10/$0.50 for cheap and $1/$5 for strong; each call is
rounded up to microdollars. No cache reads or writes were recorded. These are
usage estimates, not independently reconciled invoices.

The current cascade still costs less than strong-only in this matched run,
but the rejected policy adds a quality failure for a modest further saving.
Retain the current opt-in policy. Further work should first broaden independently
qualified hidden regressions or reduce measured verification overhead without
weakening checks. Repeated tuning on this cohort cannot qualify production.
