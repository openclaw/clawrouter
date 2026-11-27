# Native Fusion: three-attempt confirmation

The verified cheap-first cascade solved **90/90 samples**, matching strong-only;
cheap-only solved **85/90**. It used **52.71% less model cost** than strong-only,
with **15.80% more mean workflow time**. This passes the predeclared point-estimate
screen. It does not qualify production routing: these are three repeats of
30 previously exposed historical tasks, and the latency uncertainty exceeds
the screen's limit.

The [machine-readable evidence](fusion-native-three-attempt-study.json) contains
all 270 workflows, all 324 call charges, public source revisions, exact native
test counts, and four protocol/result/audit digest sets. Digests identify private
receipts; the private drivers, requests and raw receipts are not bundled. The
report supports arithmetic inspection, not independent end-to-end reproduction.

| Arm | Full-suite passes | False accepts | Successful repairs | Model cost | Mean workflow time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cheap → strong → strong repair | 90/90 | 0 | 22 | $0.304387 | 8.182 s |
| Strong-only, up to three attempts | 90/90 | 0 | 2 | $0.643593 | 7.066 s |
| Cheap-only, up to three attempts | 85/90 | 0 | 16 | $0.094482 | 8.428 s |

A successful repair means a workflow passed after a failed earlier attempt.
It is not a count of improvements over the independent strong control. All
allowed calls are charged, including rejected source and failed repairs.

## Method and comparison

The 30 tasks span 14 repositories: 12 use Tape, eight Mocha and ten `node:test`.
Each task has three paired trials and three arms. The models are
`openai/gpt-6-luna` and `openai/gpt-6.1-terra`, with low reasoning and maximum
output limits of 4,096 and 8,192 tokens respectively. Every arm stops at its
first public pass and permits at most three calls. Cascade uses the cheap model
first, then strong repair, then one repair of the latest failed strong draft.
The independent controls use their own model throughout.

Protocols were frozen before new inference. All inference completed before
final full-suite grading. Native fixtures run serially in a cached local
runtime. All arms use syntax preflight, exact assertion-count checks, and the
same public/full test split. The full suite adds one withheld group per task. For 28 tasks that group is
marked unchanged and primarily checks preservation; the remaining two are
not marked unchanged. Most full suites add one check, while the content-type
group adds 48. Public tests already expose bug regression checks, so aggregate
full-suite success does not establish performance on unseen bug regressions. Rejected
artifacts remain failures; missing full-suite counts remain null.

The public [native adapter](fusion-router.md) supplies the three-call opt-in
landed in [PR #1481](https://github.com/openclaw/clawrouter/pull/1481).
The benchmark's syntax preflight is a separate harness check. A complete syntax
failure can reject a candidate before native verification; an invalid or
incomplete native receipt still stops the adapter. No production route or
serving default changes in this study.

The screen requires aggregate quality at least both controls, zero false
accepts, at least 20% model-cost savings and at most 20% mean slowdown against
strong-only. Ratios use totals across complete paired arms, not averages of
per-task ratios. Workflow time includes request setup, inference, usage
accounting, syntax preflight, public native verification and cleanup. Initial
runtime admission and later full-suite grading are excluded. These are local
workflow measurements, not service latency or throughput measurements.

## Failed predecessor and uncertainty

The previous two-call study on the same tasks solved **88/90** cascade samples,
versus **90/90** strong-only and **84/90** cheap-only. It failed quality parity,
despite 59.32% lower cascade cost and 15.23% more mean time than strong-only.
Two cheap-only timings were unavailable and were not imputed. Its aggregate
digest and all arm summaries remain in the evidence.

The new study changes both syntax preflight and the call ceiling, and uses new
model draws. It is not a controlled estimate of either change alone. Two
cascade trials for the process-warning task used their third call after a
syntax-invalid strong fallback, then passed public and full tests. These are
observed recoveries within this run, not a guarantee of future recovery.

A paired task bootstrap retains all three repeats and all arms together
(10,000 draws; seed 20261128; Python `random.Random`; percentile indices
`int(p * (draws - 1))`). Its 95% interval is **34.43–70.05% cost savings** and
**−0.82–32.46% slowdown**. The latency interval crosses the 20% limit. All observed
cascade/strong task outcomes tie, so the bootstrap quality difference is
zero throughout; this does not establish population equivalence. Thirty tasks
are not ninety independent tasks, and tasks within repositories are correlated.
Historical selection and prior exposure further limit generalization.

## Separate transfer smoke check

Three historical `parseurl` tasks, disjoint from the 30-task roster, each ran
three times per arm under the same three-call policy. They are not certified
unseen tasks and belong to one repository.

| Arm | Full-suite passes | Model cost | Mean workflow time |
| --- | ---: | ---: | ---: |
| Cascade | 9/9 | $0.003428 | 4.509 s |
| Strong-only | 9/9 | $0.029585 | 5.022 s |
| Cheap-only | 9/9 | $0.003373 | 4.408 s |

All 27 workflows passed on their first call, with zero false accepts. Cascade
was 88.41% cheaper and 10.22% faster than strong-only, but cheap-only also solved
every sample. This smoke check demonstrates cheap-model sufficiency here,
not an added collaboration-quality benefit. Of eight source candidates,
three Vary tasks were excluded for a missing cached dependency and two
media-typer tasks for unsupported dynamic native-test identities; only these
three parseurl tasks qualified. No dependency installation expanded the sample.

## Accounting and next gate

The main study cost **$1.042462**, followed by **$0.036386** for the separate
transfer smoke. Cumulative campaign cost is **$334.147608 of $400**, leaving
**$65.852392**. The main study's $64.826052 maximum reservation was a bound,
not a charge. Costs derive from recorded uncached token usage at frozen tariffs:
cheap input/output $0.10/$0.50 and strong $1/$5 per million tokens, rounded up
to microdollars per call. No cache reads or writes were recorded. These are
usage-derived estimates, not independently reconciled invoices.

The useful result is an opt-in verified workflow that matched this strong
control at materially lower model cost. Promotion requires a frozen evaluation
on new, independently selected tasks with meaningful hidden regressions and a
latency bound that passes under uncertainty. This report does not supply that
qualification or authorize deployment.
