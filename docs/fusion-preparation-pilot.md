# Fusion preparation and repair feedback pilots

A small native repair pilot found cheaper, faster cheap-first results than the
strong model, but no fallback was used. A separate timing comparison reduced
mean workflow time while failing quality parity. These results support further
testing of cheap-first routing and verifier preparation; they do not establish
a model collaboration gain or qualify a serving default.

## Prepared cascade

Each model request starts preparation of one fresh, protected native test
fixture alongside inference. Verification waits for both. A rejected initial
proposal triggers a fresh strong-model call with its own fixture. Model
accounting finishes even if preparation fails, and cleanup finishes before the
measured stage ends. There is no speculative paid fallback.

Two previously exposed tasks, [Pino error
serialization](https://github.com/pinojs/pino-std-serializers/commit/a8f47a7dbf5ea8cf517d44d65fc74104c917193d)
and [warning emission and
spying](https://github.com/fastify/process-warning/commit/11c73b622aa29fc427d85476edb29d64687bcd87),
were each run three times per strategy. Arm order rotated; all model draws were
independent. Luna used low reasoning and a 4,096-token output ceiling; Terra
used low reasoning and 8,192. All arms received the same original editable
source and public tests. Cold-cache accounting reported no cache reads or
writes. Full grading happened after all model calls.

| Strategy | Full passes | Rescues | Estimated API cost, USD | Mean workflow seconds |
| --- | ---: | ---: | ---: | ---: |
| Luna, fresh Terra on public failure | 6/6 | 0 | 0.003604 | 5.480 |
| Direct Terra | 6/6 | 0 | 0.034164 | 7.724 |
| Independent Luna-only | 4/6 | 0 | 0.003769 | 5.787 |

The cascade sample cost 89.45% less and ran 29.05% faster than Terra. All six
cascade initials passed, so its observed behavior was cheap-only. Independent
cheap controls failed two warning repairs. The difference between cheap draws
cannot be attributed to orchestration or establish an accuracy improvement.
Pino passed every draw; warning passed 3/3 cascade, 3/3 strong and 1/3 cheap.
Eighteen calls cost $0.041537. No public acceptance failed full grading.

Workflow time includes request setup, model calls, accounting, fixture
preparation, public verification and cleanup. Initial runtime admission and
final grading are excluded. This run has no concurrent on-demand-preparation
control; changes from [earlier cost pilots](fusion-native-cost-pilot.md) cannot
be causally attributed to preparation overlap.

## Timing comparison before cascade integration

A separate controlled pilot compared sequential preparation with preparation
overlapping inference. Both used the same prepared verifier, Luna settings,
public prompts and cold-cache behavior. The two timing arms used independent
model draws, with three draws per task per arm and balanced arm order. These
were the same two exposed tasks, not new evaluation tasks.

| Timing arm | Full passes | Estimated API cost, USD | Mean workflow seconds | Mean API seconds |
| --- | ---: | ---: | ---: | ---: |
| Sequential | 6/6 | 0.003603 | 5.666 | 4.025 |
| Overlap | 5/6 | 0.003726 | 5.373 | 4.266 |

Overlap reduced observed mean workflow time by 5.17%, while API time increased.
Pino passed 3/3 in each arm, with mean workflow time falling from 3.430 to
2.927 seconds. Warning passed 3/3 sequential and 2/3 overlap, with mean workflow
time falling from 7.902 to 7.819 seconds. One overlap model response failed
public verification; no failed response was accepted. This sample fails the
quality-parity gate. Twelve calls cost $0.007329.

Before inference, eight reference/baseline and full/public pairs across the
two tasks matched between the existing and prepared verifier. Invalid edits
and fixture reuse were rejected; abandoned preparations and completed fixtures
were removed. This establishes the tested verifier behavior, not model-quality
parity or a deployment guarantee.

## Conditional repair feedback did not help

Three previously rejected warning proposals were tested with independent fresh
retry, proposal plus failed-test labels, or proposal plus bounded native error
details. Each proposal/arm had three draws, with rotated ordering and unchanged
requests across repetitions. These are conditional repairs of exposed failures,
not 27 independent tasks or complete live workflow measurements.

| Retry arm | Full passes | Valid artifacts | Estimated API cost, USD | Mean API seconds |
| --- | ---: | ---: | ---: | ---: |
| Fresh request | 5/9 | 7/9 | 0.007069 | 6.565 |
| Proposal and labels | 3/9 | 8/9 | 0.007326 | 5.915 |
| Proposal and error details | 4/9 | 9/9 | 0.007705 | 5.889 |

Detailed errors improved artifact validity in this sample but did not beat
fresh retries on final correctness. There were no public false accepts.
Twenty-seven calls cost $0.022100. Further repetitions on these same failures
were stopped; detailed feedback was not promoted.

## Evidence and limits

[Machine-readable summaries and individual rows](fusion-preparation-pilot.json)
include hashes of frozen private protocols, results and audits. Raw artifacts
remain private, which limits external reproduction. Costs use recorded usage
and frozen tariffs, not an independently reconciled invoice. Repeated samples
are small and correlated by task, and historical source may be in training
data. None of these experiments supplies a population confidence bound.

The native verifier uses exact leaf-test counts: Pino 19 public/20 full;
warning 5 public/6 full. Pino withholds an unchanged group. Warning withholds a
new spy group, not an unchanged regression group; related requirements remain
public. Other warning unit files, Jest, TypeScript and coverage are excluded.

No production code, routing defaults or deployment are changed by this report.
The private prepared-verifier experiment remains opt-in. The broader
30-unseen-task, three-repetition qualification target remains unmet.
