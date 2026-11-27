# Fusion after a failed compact attempt

Reader-plus-handoff can save model cost after compact-only execution fails.
In two pairs on one HTTP/2 repair, both fallback policies passed the full suite.
The reader-plus-handoff policy cost **34.94% less** than direct full-context
fallback, including the same failed compact attempt in each policy's cost.
Its median paired workflow ratio was **1.28**, so it was slower.

This is a conditional development result on an exposed task. It does not
qualify production routing. Earlier transfer results in this follow-up show
why the reader should not be called unconditionally: compact-only execution
solved both additional tasks at lower cost and latency than the handoff.

The [sanitized results](fusion-fallback-study.json) include all **24 new calls**
in five experiments, at estimated model cost **$0.576789**. They extend the
[earlier 16-call study](fusion-compact-handoff-study.md); they do not replace its
results. Models and frozen prices are unchanged: same-provider
`openai/gpt-6-luna` and `openai/gpt-6.1-terra`, with low reasoning effort.

## Compare the fallback, including its failed first attempt

The [pool-saturation repair](https://github.com/nodejs/undici/commit/55bf29469dc86deb6e6e5522fba934e9d7cb4adb)
has 14 public and 16 full tests. Each pair generates one fresh compact attempt.
That exact attempt and its public verification result are shared by both
policies. Both compact attempts failed. The suffixes then run in opposite
orders across the two pairs:

- Direct fallback: one strong call with the original full context.
- Reader-plus-handoff: one cheap call with that same full context. On public
  rejection, one compact strong call receives the actual reader draft and
  public failure feedback. Neither policy receives the failed compact draft.

A reader draft that cannot be used permits a flagged full-context escape.
Its cost remains charged, and it does not count as a mixed-model rescue.
Neither pair used that escape. Both readers failed public verification;
both handoffs and both direct fallbacks passed all 16 full tests.

| Pair | Policy | Estimated model cost, including prefix | Workflow time |
| --- | --- | ---: | ---: |
| 1 | Reader plus handoff | $0.033330 | 54.019 s |
| 1 | Direct full-context fallback | $0.053403 | 45.483 s |
| 2 | Reader plus handoff | $0.036509 | 54.147 s |
| 2 | Direct full-context fallback | $0.053938 | 39.269 s |

The policy totals are $0.069839 versus $0.107341. The median of the two
paired time ratios is 1.28327. The prospectively frozen economy screen passes:
both policies pass both full suites, at least one true reader-to-strong rescue,
at least 30% lower aggregate model cost, median paired time at most twice the
control and each handoff workflow at most 90 seconds. Latency parity fails.

The experiment made eight physical calls, costing $0.148056. Summing the two
policy totals gives $0.177180 because each policy comparison includes the same
compact prefix. The physical spend ledger charges those two shared prefixes
once. The result file lists unique physical calls separately from policy
references to them. No reported savings come from dropping a failed call.

## Transfer results that limit the claim

Two additional task identities were screened with compact-only, reader-first
handoff and full-context controls. All three final routes passed both suites
on each task. Both readers initially failed, so both handoffs were real rescues.
Yet compact-only execution dominated handoff on both cost and time.

| Task | Route | Estimated model cost | Workflow time | Full tests |
| --- | --- | ---: | ---: | ---: |
| HTTP/2 stream cap | Compact-only | $0.028785 | 24.772 s | 9 pass |
| HTTP/2 stream cap | Reader plus handoff | $0.035015 | 46.138 s | 9 pass |
| HTTP/2 stream cap | Full context | $0.052073 | 22.474 s | 9 pass |
| HTTP/2 initial SETTINGS | Compact-only | $0.028569 | 9.872 s | 14 pass |
| HTTP/2 initial SETTINGS | Reader plus handoff | $0.034565 | 19.659 s | 14 pass |
| HTTP/2 initial SETTINGS | Full context | $0.049419 | 11.408 s | 14 pass |

The [stream-cap task](https://github.com/nodejs/undici/commit/8d2bd41e58711af0ca85053b3510218ece7632be)
needed a declared 30-second per-test deadline because an original stress test
requires at least 12.5 seconds from its workload and service delay. The original
five-second reference failure remains recorded. The new deadline applies
equally to reference, baseline and candidate runs; no tests were removed.
The full suite has nine tests and the public suite has eight.

The [SETTINGS task](https://github.com/nodejs/undici/commit/dd2bd50a6ce78e3ad4f352aff1c62935abcac27b)
has 14 full and 13 public tests. Its fixture reused cached dependencies matching
the original lock. Reference suites passed and unchanged baselines failed
before either new task entered model evaluation. A separate aborted-stream
candidate had no holdout group and remained excluded.

The stream-cap handoff missed the unchanged economy time limit: 2.05295 times
the full-context control. The SETTINGS handoff passed that screen against full
context, but neither task established value over compact-only execution.

## Actual compact-first behavior

A separate development smoke exercised compact-first execution on the earlier
pool and cache tasks. The policy stops after a public-accepted compact answer.
Otherwise it calls the reader, then hands off only if the reader also fails.
Both final policy answers passed their full suites.

| Task | Compact-first policy cost | Full-context control cost | Policy/control time ratio |
| --- | ---: | ---: | ---: |
| Pool saturation | $0.036715 | $0.038611 | 3.16572 |
| Cache redirect | $0.027731 | $0.055947 | 0.95845 |

On the pool task, the policy's compact attempt and reader both failed; its
handoff passed. A separate compact-only control failed public verification,
so its full score is unmeasured. The policy saved only 4.91% and took over
three times as long as a full-context call with no compact prefix. This is
why comparing the two fallback policies from the same prefix matters.

On the cache task, the policy's first compact answer passed all 15 full tests.
It made no reader or handoff call. The compact-only and full-context controls
also passed. That 50.43% saving is context reduction, not mixed-model fusion.
The two-task aggregate saving is 31.85% at 1.97508 times the summed workflow
time; this aggregate was exploratory, not a preregistered acceptance gate.

## Limits and next decision

These five experiments cover four task identities from one repository. The
paired fallback comparison uses one already exposed task twice, not two
independent tasks. None of this meets the original qualification target of
30 unseen practical tasks with three trials and task-clustered uncertainty.
The two additional task identities were not certified unseen.

All calls were explicitly uncached, with zero recorded cache reads or writes.
Full grading followed all inference in each experiment; hidden feedback never
entered requests. Full acceptance requires the expected count, zero skips,
passing assertions and syntax. Timings include source checks, model calls,
accounting and public verification, but exclude final full grading. The shared
prefix duration is included in both paired policy timings; sequential waiting
for the other suffix is excluded. These are local workflow timings, not
service throughput or concurrent-request latency.

Prices are frozen usage estimates, not reconciled invoices; verification
compute is excluded. Cumulative campaign spending and unresolved reservations
are $325.929855 of $400, leaving $74.070145. Sanitized calls, grade counts and
protocol/result/audit hashes allow arithmetic checks. Omitted private requests
and runner state prevent independent reproduction from this report alone.

The next decision is whether the fallback advantage holds across a broader,
prospectively chosen task mix. Keep compact-first direct fallback as a control,
include unusable drafts and failed calls, and retain the slower-workflow cost.
This remains a caller-side repair study. It changes no Worker ensemble behavior,
production default or deployed service.
