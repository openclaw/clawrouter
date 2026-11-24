# Verified cascade saves model cost but misses the latency gate

A seven-task live comparison passed all tasks with both Terra direct and a
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

## Limits

This is one sample per arm on seven medium tasks from one provider's model
pair. It does not establish heterogeneous-provider fusion, a general learned
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
