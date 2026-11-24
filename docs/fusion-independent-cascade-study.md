# Verified cascade gains and failed fresh-task confirmation

A tuned seven-task run met the development gate, but confirmation on six new
task identities lost one direct-model success and failed latency. This policy
is not qualified for production. A subsequent repair run recovered all six tasks,
but still failed latency. The individual results follow.

The first seven-task live comparison passed all tasks with both Terra direct and a
Luna-first verified cascade. The cascade used 72.88% less model cost and made
one successful fallback, but took 25.43% longer in aggregate. It passed the
frozen quality-and-cost screen and failed the frozen latency gate. This is a
small development result, not production qualification.

## Protocol and verification

The seven medium programming tasks were selected before model calls. Their
hashed identities were absent from cached result JSON and JSONL files at
selection. This establishes novelty within that cache, not independence from
model training or every prior private experiment. All seven remain in the
denominator; there was no selection based on model outcomes.

The tasks cover pizza grouping, circular equal-value queries, constrained
painting, subarray frequency adjustment, meeting free time, leftmost fruit
placement, and value-filtered top-k sums. Both arms receive identical task
prompts, low reasoning effort and an 8,192-token output limit. Direct-first
and cascade-first order alternates. Terra direct makes one call. The cascade
verifies a Luna draft and buys at most one fresh Terra answer when acceptance
fails. Fallback sees the original task, without the draft or verifier feedback.

Each task has original public examples plus 16 generated acceptance checks.
Bounded independent enumeration or simulation produced the generated labels.
Separate seeds produce 16 held-out generated cases, excluding acceptance and
original inputs. Full grading also includes 16 source-private cases per task.
No full-grading outcome influences a live decision. Large source-private labels
retain the dataset's trust assumptions; independent reference agreement was
checked only where the reference could run within its declared bounds.

Positive and negative controls passed before inference. Candidate execution
uses the existing network-disabled sandbox with 160 MiB memory, five CPU
seconds and a two-second frame deadline. Small acceptance checks and generated
holdouts are batched; each source-private case uses a separate worker. This
execution contract differs from earlier fully isolated per-case experiments,
so their latency totals are not directly comparable. Source-private cases
include list inputs of 100,000 elements.

## Result

| Arm | Passed | Model cost (USD) | Aggregate live time |
| --- | ---: | ---: | ---: |
| Terra direct | 7/7 | $0.013256 | 43.75 s |
| Luna → conditional Terra | 7/7 | $0.003595 | 54.88 s |

The cascade used seven drafts and one fallback; direct used seven calls.
All 15 calls cost $0.016851. Both arms passed 351 full-grading cases, for 702
total cases. There were no false acceptances or lost direct successes. The
pizza task needed the fallback; the other six kept their cheap drafts.

The gate required both arms to pass all seven tasks, zero false acceptances,
at least 20% lower model cost, at least one actual rescue and live elapsed
time at most 1.2 times direct. The observed ratio was 1.2543, so the overall
development gate remains false. The rescue is a failed draft corrected by a
fresh strong call; it does not mean the cascade beat direct model accuracy.

Live elapsed includes admission, provider metadata, generation, decoding,
acceptance verification and persistence. It excludes final private grading.
The failed pizza draft alone used 1,739 output tokens and 15.97 seconds of
API time before a 2.82-second fallback. The other six drafts used 271–386
output tokens. This motivates a separately frozen draft-cap experiment;
it does not change this run's recorded outcome.

## Capped-draft follow-up

A separately frozen tuning run lowered only the cheap draft's output cap from
8,192 to 768 tokens. It used all seven of the same now-exposed tasks, fresh
model generations, unchanged strong and fallback settings, and the same
verifiers and full-grading cases. The cap was chosen after inspecting the first
run: successful drafts used 271–386 tokens, while the failed draft used 1,739.
This is post-hoc policy tuning, not independent confirmation.

| Arm | Passed | Model cost (USD) | Aggregate live time |
| --- | ---: | ---: | ---: |
| Terra direct | 7/7 | $0.012401 | 44.44 s |
| Capped Luna → conditional Terra | 7/7 | $0.003102 | 43.97 s |

Both arms again passed all 351 full-grading cases, with zero false acceptances
or lost direct successes and one actual rescue. The cascade's model cost was
74.99% lower. Its elapsed ratio was 0.9895, meeting the unchanged 1.2 limit.
It therefore passed the frozen development gate. The 1.05% timing difference
is too small and too lightly sampled to establish a robust speedup.

The pizza draft hit its 768-token limit. The adapter rejected the incomplete
response, counted its $0.000456 charge, and requested a fresh fallback. The
other six drafts passed without fallback. The run used 15 calls costing
$0.015503. An offline replay reproduced every grade and cost. The
[capped-run evidence](fusion-capped-cascade-study.json) retains this result
separately from the original latency failure.

For this type of caller-side workflow, an output cap belongs in the provider
adapter. Reserve its full possible charge before dispatch. A provider response
that ends at the cap must become an explicit unusable artifact with its billed
cost; never accept partial code as successful or turn a transport failure into
an automatic retry. A strong fallback must still pass the same task checks.
The value 768 is workload-specific evidence, not a production default for all
programming tasks.

## AtCoder prompt limitation

A later adapter audit found that all AtCoder runs below inherited a system
instruction asking for a single integer answer. That conflicts with the
required list outputs for Bib and Coming of Age, and the `Yes`/`No` output for
Twice Subsequence. The verifiers used the correct task outputs, and the saved
metrics remain intact, but the contradictory prompt limits interpretation.
These runs do not establish performance under a correct output contract.
The effect of this defect on individual successes and failures is unknown.

## Fresh-task confirmation failed

The 768-token draft policy was then frozen unchanged on six exact-output
AtCoder medium tasks whose identities were absent from cached result files.
No prompt or cap was tuned on these tasks. The tasks cover permutation lookup,
seat swaps, repeated subsequences, cycle removal, pair counting and sequential
transfers. The seventh fresh medium task required floating-point tolerance and
was excluded by the declared exact-output contract before any model calls.

| Arm | Passed | Model cost (USD) | Aggregate live time |
| --- | ---: | ---: | ---: |
| Terra direct | 6/6 | $0.013049 | 43.96 s |
| Capped Luna → conditional Terra | 5/6 | $0.007066 | 55.62 s |

The cascade lost one direct success and took 26.54% longer, despite 45.85%
lower model cost. Both quality and latency gates failed. It made two fallbacks:
one rescued the transfer problem; the seat-swap fallback failed acceptance.
There were no false acceptances. The seat-swap answer counted overlapping
adjacent windows, while the passing direct answer required disjoint windows.

All six identities remained in the result. The verifier used 15 original
public examples, 16 generated acceptance cases and 16 disjoint generated
holdouts per task. Full grading added up to 16 hash-selected source-private
fixtures per task. One seat-swap input contains 60 subcases. Four oversized
source fixtures were excluded prospectively by the unchanged transport bounds;
that limits coverage. The large seat-swap fixture was retained. Before model
calls, all 216 raw input contracts were checked and 157 tractable cases matched
bounded independent references. Positive and negative sandbox controls passed.

The 14 dispatched calls cost $0.020115. An offline replay reproduced the full
grades and costs. The [confirmation evidence](fusion-cascade-confirmation-study.json)
retains the failed outcome. It does not erase the earlier tuned gain, but it
rejects generalizing that gain to this new cohort.

## Acceptance-feedback repair follow-up

A separately frozen follow-up kept all six now-exposed AtCoder tasks and the
same acceptance and full-grading cases. It changed the fallback to receive the
rejected candidate and a counterexample from the public or generated acceptance
cases. No held-out or source-private result entered the repair prompt. The
workflow still allowed at most two model calls. Counterexample extraction ran
in a separate isolated execution, and its time counted against the cascade.

| Arm | Passed | Model cost (USD) | Aggregate live time |
| --- | ---: | ---: | ---: |
| Terra direct | 6/6 | $0.013209 | 42.22 s |
| Capped Luna → feedback repair | 6/6 | $0.008084 | 57.63 s |

Both arms passed all 288 full-grading fixtures. There were two rescues, zero
false acceptances and zero lost direct successes. The quality-and-cost screen
passed: model cost was 38.80% lower. The elapsed ratio was 1.3651, failing the
unchanged 1.2 limit. The development gate and production qualification remain
false. All 14 calls cost $0.021293; offline replay reproduced the outcomes and
accounting.

Both escalations followed drafts truncated at 768 output tokens. The adapter
rejected them as unusable, so the fallback received null candidate code and
rejection metadata, not a concrete counterexample. This result demonstrates
quality recovery through a strong fallback; it does not demonstrate that a
counterexample improved a live answer. The four usable drafts needed 210,
450, 288 and 361 output tokens.

The two fallback tasks took 20.61 s and 17.02 s, versus 9.44 s and 8.16 s for
their direct controls. Sequential model generation dominates that difference;
removing duplicate verification alone cannot establish a latency gain.
This is post-hoc tuning on an exposed cohort, not independent confirmation or
proof that feedback caused the difference between stochastic generations. The
[repair evidence](fusion-feedback-repair-study.json) preserves this result
alongside the earlier fresh-answer failure.

## Smaller draft cap with single-pass verification

A further frozen tuning run capped the cheap draft at 512 tokens and used one
framed acceptance execution to obtain both a verdict and any counterexample.
All six exposed tasks remained. Strong calls, final grading and the original
quality, cost, rescue and latency gates were unchanged. Both comparison arms
used the same acceptance verifier. Separate offline checks matched decisions
and first counterexamples for 36 saved answers and controls.

| Arm | Passed | Model cost (USD) | Aggregate live time |
| --- | ---: | ---: | ---: |
| Terra direct | 6/6 | $0.012339 | 41.36 s |
| 512-token Luna → conditional Terra | 6/6 | $0.007779 | 53.87 s |

Both arms passed all 288 grading fixtures. There were two rescues, no false
acceptances and no lost direct successes. The 14 calls cost $0.020118.
Model cost was 36.96% lower, but elapsed time was 30.24% higher. The development
gate still failed. An offline replay reproduced the outcomes and accounting;
[the 512-token evidence](fusion-framed-512-study.json) retains the result.

Both failed drafts consumed all 512 tokens as reasoning tokens and produced
no usable code. Reducing the cap shortened the wasted attempts, but did not
remove the sequential-call penalty. This motivates a separate effort-setting
test; it does not justify loosening the latency gate or claim a benefit from
concrete counterexample feedback. Changes in model-generation timing between
runs cannot be attributed solely to the verifier or cap from these samples.

## Lower draft reasoning setting

The next frozen tuning run changed only the cheap draft's reasoning effort
from `low` to `none`. It kept the 512-token cap, verifiers and strong settings.
The known conflicting stdin prompt remained, so the result is diagnostic.

| Arm | Passed | Model cost (USD) | Aggregate live time |
| --- | ---: | ---: | ---: |
| Terra direct | 5/6 | $0.012459 | 42.17 s |
| Luna without reasoning → conditional Terra | 6/6 | $0.007889 | 44.91 s |

The cascade passed all 288 grading fixtures, with no false acceptances or lost
direct successes. Direct failed acceptance on seat swaps. The 14 calls cost
$0.020348. The cascade used 36.68% less model cost and 6.52% more live time.
The frozen development gate still evaluates false because it required both
arms to pass all six tasks. Offline replay reproduced grades and accounting.
[The evidence](fusion-none-reasoning-study.json) retains the failed control.

There were two rescues. The seat-swap draft was still truncated; the transfer
draft completed and the fallback received its public-example counterexample.
This exercises the feedback path, but does not prove feedback caused a benefit.
The control had one attempt while the cascade could make two. A corrected
prompt and a matched strong-model self-repair control are required before a
fairer workflow comparison. This exposed, single-sample result is not a
production qualification.

## Corrected output contract and matched repair control

A subsequent pilot corrected the output instruction and allowed the strong
control the same opportunity to repair a rejected answer. Both arms could
make at most two calls, stopped after acceptance, and used the same bounded
feedback. The six task identities were already exposed.

| Arm | Passed | Model cost (USD) | Aggregate live time |
| --- | ---: | ---: | ---: |
| Terra, with conditional self-repair | 6/6 | $0.012446 | 50.92 s |
| Luna → conditional Terra repair | 5/6 | $0.007379 | 46.37 s |

The cascade used 40.71% less model cost and 8.93% less live time, but lost one
strong-model success. All quality and promotion gates remain false. The 14
calls cost $0.019825; offline replay reproduced grades and accounting.
[The per-arm evidence](fusion-corrected-paired-study.json) retains every row.

The transfer simulation passed small acceptance checks but exceeded the
full grader's execution limit on a larger case. Source inspection found a
quadratic loop. That invalid result remains a failure even though the other
completed cases agreed. It motivates public-constraint scale checks before
acceptance; a cheaper run with this failure is not a viable quality gain.
The corrected prompt and stronger control were introduced together, so this
pilot cannot isolate their individual effects.

## Public scale acceptance

The next pilot added constructive N=60,000 public-constraint checks for all
six tasks. Small cases agree with independent references; the six efficient
reference solutions pass in the existing sandbox. Replaying the previous
answers exposed both the transfer simulation and an O(N×M) subsequence
implementation. Source-private cases do not supply the scale fixtures.

| Arm | Passed | Model cost (USD) | Aggregate live time |
| --- | ---: | ---: | ---: |
| Terra, with conditional self-repair | 6/6 | $0.012606 | 46.26 s |
| Luna → conditional Terra repair | 6/6 | $0.012643 | 67.31 s |

Both arms passed full grading, with zero false acceptances and zero lost
strong successes. The cascade escalated four times: three drafts were complete
and one was truncated. Its model cost was 0.29% higher and live time was 45.50%
higher. This restores quality in this sample but fails both economic and
latency goals. The 16 calls cost $0.025249. Offline replay reproduced grades
and accounting; [the evidence](fusion-public-scale-study.json) retains every arm.

This remains one sample on exposed tasks. Different model generations prevent
attributing the entire change between runs to the added checks. No production
or repository-work qualification follows from the result.

## Cheap repair diagnostic

Before adding another workflow stage, a six-call diagnostic compared a fresh
Luna answer with one Luna repair for each of the three complete drafts rejected
by the scale pilot. Both arms used no reasoning and a 1,024-token output cap.
Repair also received the rejected code and public acceptance feedback. The
fourth rejected draft was truncated, so it supplied no executable repair seed.

Fresh answers passed 2/3; repairs passed 0/3. Fresh cost $0.000746, repair
$0.000794. All six outputs were complete. Full grading and an offline audit
confirmed the result; [the evidence](fusion-cheap-repair-probe.json) retains
every selected case. The total six-call cost was $0.001540.

This does not support adding a cheap repair stage. It also does not establish
that repair is generally harmful: the cases were already exposed failures,
there was one sample per arm, and this was not an executed cascade. The two
fresh successes do not isolate an effect from the larger output cap.

## Larger draft and fresh fallback follow-ups

Two final tuning comparisons kept the same six exposed tasks and public-scale
checks, with a 1,024-token Luna draft and an 8,192-token Terra attempt. Every arm
allowed at most two calls. Full grading and offline replay remained separate
from public acceptance.

| Policy | Strong passed | Cascade passed | Cost ratio | Live time ratio |
| --- | ---: | ---: | ---: | ---: |
| Repair from rejected code and public feedback | 6/6 | 5/6 | 0.9204 | 1.4215 |
| Independent fresh strong fallback | 6/6 | 6/6 | 0.5650 | 1.2098 |

The [larger-draft repair run](fusion-scale-1024-study.json) lost one strong
success and failed all promotion gates. Its 15 calls cost $0.024064. No public
false acceptance occurred: the failed fallback was rejected by public checks.

The [fresh-fallback run](fusion-fresh-fallback-study.json) passed all six tasks
in both arms, with zero false accepts or lost strong successes and three
successful escalations. Cascade model cost was $0.007249 versus $0.012831 for
the strong baseline, a 43.50% reduction. Live arm time was 57.58 seconds versus
47.60 seconds, a 20.98% increase. Its 15 calls cost $0.020080.

The original latency limit is 1.2 times the baseline. The observed 1.2098 ratio
fails that limit: this is a quality-matched cost result, not a development or
production qualification. Do not round it into a pass. Stochastic differences
between runs also prevent attributing the entire improvement to fresh fallback.
These comparisons close tuning on these six tasks. The next qualification must
use practical repository work and a separately frozen policy and task set.

## Real repository repair development check

The next comparison used two actual repository fixes: returning DuckDuckGo
read errors promptly and returning a MiniMax authorization failure while
cleanup is pending. Inputs contained the original source and tests plus an
explicit public reproducer. The original fix suites remained separate from
model inputs. Broken and corrected source were qualified before model calls;
both source versions compiled.

| Arm | Full suites passed | Model cost (USD) | Aggregate live time |
| --- | ---: | ---: | ---: |
| Terra, with conditional fresh retry | 2/2 | $0.032523 | 55.26 s |
| Luna → conditional fresh Terra | 2/2 | $0.003227 | 31.17 s |

Both cheap drafts passed public checks and the full suites without fallback.
There were zero false accepts or lost strong successes. Model cost fell 90.08%
and live time fell 43.59%, but this is a cheap-execution result: no collaboration
was needed and the actual-rescue gate remains false. These are two
operator-exposed development tasks, not independent confirmation.

[The per-arm evidence](fusion-real-repair-study.json) retains all four outcomes.
Offline replay matched grades, test counts, failure identities, artifacts and
accounting. Raw TAP logs varied with test timings; both raw runs were retained,
and only that log text and its hash were excluded from comparison. A separate
audit rebound every stage to its frozen request and accounted for all costs.
The four model calls cost $0.035750. No production defaults changed.

## Harder repository stress check

The next [frozen development study](fusion-real-stress-study.json) selected all
three tasks on which the prior 17-task matrix had a strong-only success. This
is outcome-informed stress testing, not an independent sample. The tasks cover
OpenRouter transcription, Bedrock embeddings and a Deepgram query-bound repair.
The same public tests, declared API context, arm budget and deadline applied to
both arms. Full tests ran only after all model calls finished.

| Arm | Full suites passed | Model cost (USD) | Aggregate live time |
| --- | ---: | ---: | ---: |
| Terra, with conditional fresh retry | 2/3 | $0.045021 | 77.34 s |
| Luna → conditional fresh Terra | 1/3 | $0.057043 | 101.06 s |

Cascade cost 26.70% more and took 30.68% longer. Both escalations passed public
checks, but only one passed the full suite. Two cascade answers were false
accepts; one lost a strong-model success. The eight calls cost $0.102064.
All promotion gates failed. Offline replay reproduced the grades, artifacts,
accounting and recorded timing with no additional model calls. Raw TAP text
and its digest were retained separately from stable grade fields.

Inspection also found that the public Deepgram subset omitted an unchanged
baseline test body. A subsequent fixture correction restored that existing
coverage without exposing new held-out checks. The corrected public suite
passed on the reference and both saved answers, and rejected the original
broken source. It therefore improves fixture realism but does **not** repair
the observed false acceptance: the missed restriction is new. This diagnostic
used no additional model calls and is not an improved end-to-end result.

The two earlier cleanup successes do not establish hard-task capability.
Public acceptance coverage remains an unresolved limit on this cascade.

## Verification overhead

A separate [model-free paired benchmark](fusion-shared-verifier-study.json)
compared separate runtime-test and TypeScript sandboxes with one shared,
protected sandbox that performs both checks serially. The source and runtime
pins, test protection, compiler options and cleanup requirements stayed fixed.
Six saved final answers and two deliberate failure controls ran twice each,
with the execution order reversed between trials.

All 16 pairs produced identical test grades and compiler verdicts/diagnostics.
The controls retained runtime rejection and compiler-only rejection. Aggregate
verification time fell from 38.395 seconds to 25.153 seconds, a 34.49% reduction.
This is a local verifier measurement, not an end-to-end model result. It does
not establish lower inference cost, fix false acceptance or qualify fusion for
production. No model calls were used for this benchmark.

## Limits

Each study uses one sample per arm from one provider's model pair. It does not establish heterogeneous-provider fusion, a general learned
router, performance on hard tasks or population-level reliability. The
task-specific verifiers also require engineering effort. Hardware, engineering
and operational costs are excluded from the model-cost figures.

The [sanitized per-arm evidence](fusion-independent-cascade-study.json)
contains source, protocol, result and audit identities, plus grades, timings
and costs. An independent replay reproduced the saved grades and accounting
without further model calls. Raw prompts, completions and private paths are
not published. Earlier failed studies remain valid evidence; this result
does not replace them. No Worker behavior, production defaults or deployment
changes are part of this report.
