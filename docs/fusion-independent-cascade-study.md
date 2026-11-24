# Verified cascade gains and failed fresh-task confirmation

A tuned seven-task run met the development gate, but confirmation on six new
task identities lost one direct-model success and failed latency. This policy
is not qualified for production. The individual results follow.

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
rejects generalizing that gain to this new cohort. A possible next experiment
is a bounded repair using acceptance feedback; that policy has not been shown
to improve these results.

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
