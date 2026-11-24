# Small-model review on an adapted coding cohort

On 2026-11-24, a fixed 12-task development study found a useful candidate:
a small model drafts, a stronger model reviews, and the small model repairs
once if requested. It passed all 12 tasks for 33.7% less model cost than the
strong direct control. This is exploratory evidence, not a production-qualified
gain or an official LiveCodeBench score. Production Fusion is unchanged.

A disjoint confirmation did **not** reproduce the cost advantage: fusion cost
2.4% more than strong direct. It also exposed an invalid upstream private input,
so it cannot qualify the policy for promotion. See [the follow-up](#disjoint-confirmation).

## Results

| Policy | Tasks passed | Model cost (USD) | Calls per task |
| --- | ---: | ---: | --- |
| Luna direct | 9/12 | $0.016683 | 1 |
| Sol 6.2 direct | 12/12 | $0.111332 | 1 |
| Luna draft, Sol 6.2 review, optional Luna repair | 12/12 | $0.073766 | 2–3 |
| Luna draft, Luna review, optional Luna repair | 11/12 | $0.028784 | 2–3 |

Model ids were `openai/gpt-6-luna` and `openai/gpt-6.2-sol`. These identify the
requested provider models, not immutable weight snapshots. Prices and model
behavior can change. Costs come from recorded provider usage and the frozen
pricing configuration; they exclude local grading, hardware and operations.

The strong-review policy recovered all three weak-control failures without
losing a strong-control success. One weak draft and its self-review repair were
truncated; both were charged and counted as failures. None of the weak drafts
that passed public tests failed the private tests in this sample. The study
does not establish that reviewing public passes is necessary or that this
policy beats a public-test-gated cascade. Such cascades had false accepts in
other workloads, so that comparison needs a separate prospective evaluation.

The experiment made 54 unique paid calls: 24 direct, 24 review and six repair.
Their combined cost was $0.197199. Policy totals each include the small draft;
the experiment reused that draft across the two review arms and billed it only
once. Consequently, summing policy totals would double-count shared calls.
Per-task scores, costs and candidate hashes are in the
[structured result](fusion-livecodebench-study.json).

## Fixed protocol

The source was the official
[LiveCodeBench code-generation-lite dataset](https://huggingface.co/datasets/livecodebench/code_generation_lite),
revision `0fe84c3912ea0c4d4a78037083943e8f0c4dd505`, file `test6.jsonl`.
Its SHA256 is `bb4c364f71921c4495a6ad15abe1a927350b720009f4933e2e71f8af0f6fd1f5`.
The [upstream evaluator](https://github.com/LiveCodeBench/LiveCodeBench)
remains authoritative for official benchmark results.

Before inference, the adapter fixed six medium and six hard tasks by a salted
identity hash. It screened all 175 rows and excluded 163 by explicit admission
rules or fixed stratum limits. Admission required AtCoder/Codeforces stdin
problems, no starter code, bounded question and fixture sizes, and exact token
outputs. The full exclusion roster remains in the local cohort receipt.
All public examples were visible: 34 in total. Sixteen distinct private inputs
per task were selected by input hash: 192 in total. No private test result was
available until all model calls finished.

This adapts programs to `solve(input_text: str) -> str`, using Python's standard
library. A task passes only when its candidate passes every selected public and
private assertion. Invalid or incomplete outputs remain failures. The existing
network-isolated, resource-bounded Python runtime executed the candidates.
A known-output lookup control and a blank negative control qualified transport
and assertion behavior. They did not validate algorithm correctness or establish
coverage of each problem's maximum constraints.

Both reviewer arms saw exactly the same small-model draft, problem and public
verdict. Reviews used a structured change/no-change decision with a concise
repair plan. Each could request one Luna repair. A repair that regressed a
public-passing draft was discarded in favor of that draft, with its cost still
charged. No private-test-based candidate selection or corrective retry occurred.
Direct and reviewer order alternated by task. Output bounds were 8,192 tokens
for source and 4,096 for review; the request timeout was 180 seconds.

The predeclared development screen required more successes than the weak
control, no lost strong successes, at least the strong control's total successes,
and cost at most 80% of strong direct. It passed that screen. Independent replay
matched every distinct saved grade and the complete call ledger. The structured
result records the source, protocol, qualification and terminal-audit hashes.
The full local experiment sources and raw receipts are not published in this
report, so those hashes are provenance anchors, not a standalone reproduction kit.

## Disjoint confirmation

A second fixed cohort used the next six medium and six hard tasks in the same
identity-hash order, excluding every first-cohort task. The inference prompts,
models, review policy and one-repair limit stayed unchanged. Before inference,
the adapter excluded output contracts permitting arbitrary valid solutions and
normalized case only where the problem explicitly allowed it. All 36 public
and 192 selected private fixtures passed transport/assertion qualification.

| Policy | Raw tasks passed | Model cost (USD) |
| --- | ---: | ---: |
| Luna direct | 8/12 | $0.019190 |
| Sol 6.2 direct | 9/12 | $0.075106 |
| Luna draft, Sol 6.2 review, optional Luna repair | 10/12 | $0.076897 |
| Luna draft, Luna review, optional Luna repair | 9/12 | $0.032345 |

All 52 paid calls are retained: 24 direct, 24 review and four repair, costing
$0.165158 in total. Independent replay matched the grades and call ledger.
Fusion lost none of strong direct's successes, but cost 2.4% more; it failed
the predeclared quality-and-cost development screen. These are raw observed
results, not a clean confirmation or a combined benchmark score.

Post-run diagnosis found a private input for AtCoder `abc392_f` that violates
the statement's `1 <= P_i <= i` insertion-position constraint. All four arms
fail this case. It remains in the original result; no row was dropped and no
score was recomputed to improve the result. The initial lookup control could
pass this malformed fixture, which shows why transport/assertion qualification
alone is insufficient. Semantic qualification for this cohort is now negative.
A subsequent admission guard checks this known problem's size, token count and
insertion ranges across all supplied fixtures before sampling. Its focused
regressions pass; it is not a general validator for all dataset constraints.

Another shared failure, AtCoder `abc390_d`, reproduced two `MemoryError`s for
the small direct candidate under the unchanged sandbox limits. That result
remains a failure. No extra memory, longer timeout or paid repair was introduced
after viewing private results. Two weak candidates passed public checks but
failed the full check, again showing the limits of public-only acceptance.

The [structured result](fusion-livecodebench-study.json) retains the confirmation
rows, costs and diagnostic status alongside the first study. Requested model
ids are mutable, this remains adapted evaluation, and the new result does not
establish a production latency or cost advantage.

## What to do next

Keep this as a candidate for a caller-side coding workflow, not a new default
routing policy. The current `clawrouter/fusion` adviser/synthesizer implementation
is a different topology; these results do not measure it.

Qualify fixture validity on a clean disjoint cohort before another paid run.
The first disjoint attempt exposed a data defect; it must not be used as
promotion evidence. Repeat the unchanged policy on qualified data before tuning it.
Include the same direct and self-review controls, plus a separately declared
public-test-gated cascade. Measure complete end-to-end execution latency and
all charged calls. Use repeated trials to expose sampling variance, then test
repository tasks with realistic tool and context costs. Promote only after the
quality/cost advantage transfers without unacceptable latency or lost strong
successes.

Twelve task outcomes are too few to establish generalization. The data may be
in model training, the exact-token adaptation differs from upstream evaluation,
and selected private fixtures do not cover all original tests or large inputs.
No latency win, cross-provider advantage, learned routing benefit, or production
saving is claimed.
