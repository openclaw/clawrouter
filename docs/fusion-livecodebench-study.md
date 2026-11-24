# Small-model review on an adapted coding cohort

On 2026-11-24, a fixed 12-task development study found a useful candidate:
a small model drafts, a stronger model reviews, and the small model repairs
once if requested. It passed all 12 tasks for 33.7% less model cost than the
strong direct control. This is exploratory evidence, not a production-qualified
gain or an official LiveCodeBench score. Production Fusion is unchanged.

Subsequent cohorts did **not** establish a quality-preserving cost advantage.
A [later cheap-reviewer study](fusion-reviewer-study.md) also failed fresh
replication despite an exploratory Terra result.
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
policy beats a public-test-gated cascade. The retrospective
[fallback comparison](#fallback-policy-replay) below tests this using the saved
responses; a prospective comparison is still needed.

The experiment made 54 unique paid calls: 24 direct, 24 review and six repair.
Their combined cost was $0.197199. Policy totals each include the small draft;
the experiment reused that draft across the two review arms and billed it only
once. Consequently, summing policy totals would double-count shared calls.
Per-task scores, costs and candidate hashes are in the
[structured result](fusion-livecodebench-study.json).

## Fallback policy replay

The public result now includes each candidate's public-test verdict, copied
from its hash-verified terminal audit. Run the standalone replay without
credentials, model calls, datasets or dependencies:

```sh
node scripts/fusion-fallback-replay.mjs
node --test test/fusion-fallback-replay.test.mjs
```

The replay selects using only the public verdict and scores that selection
against the saved full grade. Every attempted candidate is charged, including
failed and truncated responses. Fusion already includes the weak seed, review
and any repair, so fallback adds only the strong direct cost. The output binds
the input JSON bytes with SHA256 and checks row totals against the published
arm totals. An input hash identifies the supplied file; it is not independent
attestation of its contents.

On the input-validated 11-task cohort:

| Retrospective policy | Tasks passed | Model cost (USD) | Change from strong direct |
| --- | ---: | ---: | ---: |
| Strong direct | 11/11 | $0.107324 | — |
| Weak draft, strong fallback on public failure | 10/11 | $0.060767 | 43.4% less |
| Fusion, strong fallback on public failure | 11/11 | $0.138083 | 28.7% more |

The first fallback misses the same public-passing wrong answer that defeated
the predeclared gate. The second recovers the truncated repair, but loses the
cost advantage. In the initial development cohort, public-gated weak fallback
also reaches 12/12 at $0.059129, below always-review's $0.073766. The original
development result therefore does not demonstrate that review adds value over
this simpler baseline. Cohorts remain separate; the confirmation cohort's
known invalid input remains in its reported rows and qualification warning.

A separate hidden-label diagnostic escalates exactly when the saved weak
candidate is wrong. It reaches 11/11 at $0.067567 on the input-validated cohort,
but requires the hidden answer and is **not a deployable policy**. This leaves
room for a useful error detector in principle, without providing one. It is not
a measured routing gain, a latency estimate or a reason to ship the current
gate. All replays reuse saved responses after observing the results; new
inference can behave differently. Production Fusion is unchanged.

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

## Input-validated follow-up

A third cohort used all 11 untouched exact-output tasks remaining in the
bounded pool: three medium and eight hard. It was not balanced by dropping
harder tasks. Handwritten input-contract checks matched the public problem
statements and passed every supplied input: 27 public and 404 private cases.
Three independent reference solvers also matched all supplied outputs for
those three tasks; expected outputs for the other eight still rely on the
dataset. The frozen runtime sample used all 27 public and 164 private cases.
One task supplied only four private cases.

| Policy | Tasks passed | Model cost (USD) |
| --- | ---: | ---: |
| Luna direct | 8/11 | $0.019949 |
| Sol 6.2 direct | 11/11 | $0.107324 |
| Luna draft, Sol 6.2 review, optional Luna repair | 10/11 | $0.110843 |
| Luna draft, Luna review, optional Luna repair | 8/11 | $0.035141 |
| Public-gated strong review and small repair | 9/11 | $0.077607 |

The fifth policy was declared before inference and projected from the same
calls: retain a public-passing small draft; otherwise use its strong-review
and small-repair result. Its cost includes the complete chosen path. This
projection required no extra API calls and does not establish its independent
execution latency or cache behavior. All 48 actual calls were charged once:
22 direct, 22 review and four repair, costing $0.233359 total.

Always-review cost 3.3% more than strong direct and lost one strong success.
The gate cost 27.7% less but lost two strong successes. Self-review preserved
the small model's 8/11 score at higher cost. Neither review policy passed the
quality-preservation requirement. Independent replay matched all distinct
grades and the full call ledger.

The failure modes were concrete. The small draft for AtCoder `arc194_d`
passed public examples but failed four private assertions. Strong review
repaired it; the public gate retained the wrong draft. For `arc194_e`, the
small draft and both small-model repairs exhausted the 8,192-token limit,
while strong direct passed. Both models used the frozen medium reasoning
effort. No limit was raised after the result, and no failure was dropped.

These results retire the fixed policies from further paid tuning on these
used cohorts. The first study remains a development lead that failed to
become a general quality/cost advantage. This follow-up supports choosing
strong direct when preserving quality on this cohort; it does not justify a
production Fusion default. Future policy changes need separate development
and fresh confirmation data.

## What to do next

Keep this as a candidate for a caller-side coding workflow, not a new default
routing policy. The current `clawrouter/fusion` adviser/synthesizer implementation
is a different topology; these results do not measure it.

The input-validated follow-up failed quality preservation. Do not repeat these
unchanged policies on used cohorts as fresh evidence. Develop a materially
different policy before spending on another confirmation, and validate the
new task inputs before inference.
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
