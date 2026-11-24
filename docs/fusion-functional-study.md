# Functional fusion needs a matched direct control

An eight-task coding pilot matched Luna→Terra revision against Terra direct,
Terra revising its own draft, and Sol 6.2 direct. Fusion matched Sol at lower
model cost, but Terra alone matched its score for less. This is not evidence
of a fusion gain. Production behavior and defaults remain unchanged.

## Frozen comparison

The cohort contained four medium and four hard LeetCode tasks, unused in the
previous experiments. Selection used a fixed task-identity hash before model
calls. The existing cached LiveCodeBench shard supplied 22 public and 128
selected private tests. Every supplied input passed task-specific contract
checks. Two independent reference implementations checked their corresponding
outputs; other outputs rely on the dataset. Positive lookup and negative
controls passed for all eight tasks before inference.

All three models received the same problem, typed functional signature and
public examples, with medium reasoning effort and an 8,192-token output bound.
Each response had to define a standalone Python `solve` function. All roles
were told the unchanged sandbox limits: 160 MiB address space including the
interpreter, five CPU seconds across the complete batch, and a two-second RPC
response deadline. Calls reuse one candidate process within a batch.

Terra then revised Luna's saved draft and, separately, its own saved draft.
Both revision arms used identical instructions and received the respective
candidate and public-test feedback. No private results were available until
all 40 calls finished. Invalid drafts still received one revision, with no
extra retry. An audit replay reproduced every saved grade and cost total.

## Results

| Arm | Passed | Model cost (USD) |
| --- | ---: | ---: |
| Luna direct | 7/8 | $0.008032 |
| Terra direct | 8/8 | $0.050809 |
| Sol 6.2 direct | 8/8 | $0.099172 |
| Luna draft → Terra revision | 8/8 | $0.056489 |
| Terra draft → Terra revision | 8/8 | $0.096225 |

Fusion cost 43.04% less than Sol, but 11.18% more than Terra direct for the
same score. It therefore failed the predeclared development screen, which
required improvement over Terra direct, no lost Sol successes, at least the
self-revision score, at least 20% saving against Sol, and lower cost than
self-revision. A cheaper strong-model comparison alone would have hidden the
better direct baseline.

Each revision arm includes both its seed and revision cost. The experiment's
40 unique calls cost $0.251886; shared seeds are billed only once in that
experiment total. Prices use recorded provider token usage and frozen rates,
including the [official Terra pricing](https://developers.openai.com/api/docs/models/gpt-6.1-terra).
Hardware, local grading and operational costs are excluded.

## The one Luna failure was an interface mismatch

Luna's solution to `find-the-minimum-amount-of-time-to-brew-potions` defined
`minTime` instead of the explicitly required `solve`. The original score
remains a failure. A separate, post-hoc diagnostic changed only that function
name and passed all 19 public-plus-private tests with the same runtime limits.
No model was called for this diagnostic. With that mechanical correction,
all eight Luna algorithms passed the sampled tests; this is not an official
replacement score or evidence of unseen-task reliability.

This distinction matters: the observed revision rescue repaired an interface
mismatch. It did not establish an algorithmic advantage from combining models.
Future algorithm-focused protocols should predeclare how declared entrypoint
names are adapted and report strict instruction-following separately.

## Diverse-output follow-up

A separate, prospectively frozen pilot used six unused tasks: three medium and
three hard. Selection deliberately covered lists, nested lists, booleans,
strings and integers; it was not a random population sample. Typed canonical
input hashes selected 95 private cases while retaining all 17 public cases.
All 257 supplied cases passed input and output-structure checks. Independent
references checked 199 exact outputs and another 42 caption minimum costs;
caption lexicographic tie-breaking and the remaining answers retained dataset
trust. Positive and negative sandbox controls passed before model calls.

This pilot applied a deterministic, public-signature-only entrypoint adapter
equally to all three direct arms and both revision arms before public checks.
It retained original strict scores separately. No output actually required
adaptation, so the strict and adapted results were identical. Effort, token
limits, sandbox limits, matched revision instructions and the development
screen remained as described above. Every inference call finished before
private grading.

| Arm | Passed | Model cost (USD) |
| --- | ---: | ---: |
| Luna direct | 3/6 | $0.005821 |
| Terra direct | 6/6 | $0.041700 |
| Sol 6.2 direct | 6/6 | $0.048564 |
| Luna draft → Terra revision | 6/6 | $0.061997 |
| Terra draft → Terra revision | 6/6 | $0.067075 |

Fusion cost 48.67% more than Terra direct and 27.66% more than Sol direct,
with no additional correct answers. It again failed the development screen.
All three Luna failures were on the hard tasks. Its alternating-permutation
solution passed the three public examples but failed nine full-batch
assertions, so public success alone would not have identified every failure.

The 30 unique calls cost $0.177636. An audit replay reproduced the scores and
accounting. [Per-task results and provenance](fusion-functional-diverse-study.json)
keep this pilot separate from the eight-task result. This evidence does not
justify more tuning of the same always-revise policy; the cheaper direct
control remains necessary for any subsequent collaboration claim.

## Compact algorithm outlines on the exposed cohort

A separate development screen reused the same six diverse-output tasks above.
They were already exposed; these are not new confirmation cases. It tested
role decomposition instead of revision: an algorithm outline followed by
Luna implementation. Fresh Luna and Terra direct controls used the same low
reasoning effort. A Luna-outline/Luna-implementation arm matched the workflow
while changing only the planner model.

Every planner received the original problem, signature, public examples and
runtime limits. Outlines had a 1,536-token output cap; implementations and
direct solutions had an 8,192-token cap. Workers received the original problem
and the untrusted outline. No draft or test feedback entered another request.
All 36 calls finished before public and full grading. All 12 outlines were
valid, and every arm used the strict `solve` interface without adaptation.

| Arm | Passed | Model cost (USD) |
| --- | ---: | ---: |
| Luna direct | 5/6 | $0.002998 |
| Terra direct | 6/6 | $0.022605 |
| Luna outline → Luna implementation | 5/6 | $0.005541 |
| Terra outline → Luna implementation | 5/6 | $0.024502 |

The mixed workflow cost 8.39% more than Terra direct and lost one of its
successes. It did not improve the aggregate score over either Luna control.
The frozen screen required both Terra and the mixed workflow to pass all six
tasks, a strict gain over both Luna controls, and at least 20% savings versus
Terra. It failed those conditions.

Terra outlines alone cost $0.020864, or 92.30% of its direct solutions. Even a
free implementation would therefore fall short of the 20% savings target for
these saved outlines. Shorter requested output did not make this planning
stage cheap enough. This result does not justify another implementation-only
variation of the same plans.

The unique calls cost $0.055646. Both planned-arm totals include planner and
implementation charges. An independent replay reproduced every grade and
accounting total. [Per-task outcomes and provenance](fusion-functional-outline-study.json)
retain all rows and distinguish this low-effort screen from the earlier
medium-effort revision experiments. The same reference-coverage limitations
apply. No production policy, deployment or latency claim follows from it.

## Sparse correction needs a public-fallback control

A later screen used two hard tasks: `lexicographically-smallest-generated-string`
and `count-substrings-divisible-by-last-digit`. They were excluded from the
earlier cohorts. All 86 raw cases passed input and output-contract checks;
bounded independent references verified 52 exact answers. The other 34 answers
retain dataset trust. Six public and 32 private cases were selected before
model calls. Positive lookup and negative controls passed for both tasks.

The second task needed three fixture batches. Each batch kept the same 160 MiB
candidate address space, five-second CPU budget and two-second RPC deadline.
The 256 KiB outer payload and 128 KiB RPC message limits stayed intact. Batches
restart the candidate, so this evaluation requires pure functions and does not
measure a single-process workload or end-to-end latency. Larger cases that do
not fit an individual RPC message remain excluded.

Initial low-effort Luna and Terra calls used an 8,192-token output bound. Luna
passed one task and Terra passed both. Luna's digit-substring answer used the
wrong entrypoint. A separate diagnostic applied the existing public-signature
adapter; it still failed five of 19 tests, including a public example. This was
an algorithmic error as well as an interface failure.

Two subsequent development experiments reused those exposed tasks and saved
controls. Each applied the same entrypoint adapter to all arms, retained strict
grades, and escalated only when the adapted Luna seed failed public tests.
Every new model call finished before private grading.

| Policy | Passed | Model cost (USD) |
| --- | ---: | ---: |
| Luna seed | 1/2 | $0.001532 |
| Terra direct | 2/2 | $0.014157 |
| Luna seed → Terra direct on public failure | 2/2 | $0.006134 |
| Luna critique → Luna repair on public failure | 1/2 | $0.002689 |
| Terra critique → Luna repair on public failure | 1/2 | $0.005222 |
| Luna exact edits on public failure | 1/2 | $0.002037 |
| Terra exact edits on public failure | 2/2 | $0.006229 |

The critique experiment gave both critics the same problem, draft, public
feedback and runtime limits, with a 512-token output cap. Luna exhausted that
cap on reasoning and returned no critique; its repair therefore received null
guidance, with the cost retained. Terra returned a concrete diagnosis, but
Luna's rewrite introduced a new error and still failed the task.

The exact-edit experiment removed the rewriting model. Editors returned up to
four source replacements, applied in order only when each old string matched
exactly once. Invalid or incomplete edits failed closed, with no retry. Both
editors received the same prompt and low reasoning effort. Their output caps
had equal maximum token cost: 7,680 Luna tokens or 768 Terra tokens, each worth
$0.003840 at the frozen output rates. Both responses completed.

Terra's edits repaired the algorithm. That workflow cost 56.00% less than Terra
solving both tasks directly, but 1.55% more than the simpler public-test fallback
for the same score. The predeclared gate required two successes, an improvement
over the cheap editor, and at least 20% savings against that fallback. It failed
the cost requirement. This is a demonstrated correction on an exposed task,
not a qualified fusion advantage.

The ten unique calls across the baseline and both interventions cost
$0.025738. Policy rows include their cached seed costs; those shared seeds are
charged only once in the unique-call total. Independent replays reproduced all
grades and accounting. [Outcomes and provenance](fusion-functional-edit-study.json)
retain the separate experiments without raw model text or private fixtures.
No production policy, deployment or latency claim follows from these results.

## Six hard tasks: behavioral agreement with fallback

A separate development screen tested three independent low-effort Luna
candidates per task. It selected the first candidate in a cluster of at least
two that passed the public examples and produced identical outputs on 24
fixed synthetic inputs. Without such a cluster, it used Terra. Probe inputs
came from public constraints, with no expected answers or hidden test labels.
All new calls finished before grading. Selections were fixed before full-test
results were read.

| Policy | Passed | Accounted model cost (USD) |
| --- | ---: | ---: |
| First Luna sample | 4/6 | $0.003974 |
| Second Luna sample | 3/6 | $0.003836 |
| Third Luna sample | 3/6 | $0.004238 |
| Terra direct | 6/6 | $0.026880 |
| First Luna, then Terra on public failure | 5/6 | $0.007251 |
| Three-sample majority, then Terra | 6/6 | $0.018568 |

The majority policy accepted four tasks and fell back on two. It matched
Terra's score at 30.92% lower accounted model cost, including all three Luna
calls and conditional Terra calls. It met the predeclared development gate:
6/6, better than each cheap sample and the public-only cascade, and at least
20% cheaper than Terra. A repeat audit reproduced all grades, selections and
accounting. This is a development lead, not production qualification.

Four tasks were new to the screen; two were exposed in earlier experiments.
The six tasks contributed 110 selected full-test cases, including 14 public
examples. All 254 original case contracts were checked. Independent bounded
references checked 139 outputs; larger reference-unchecked outputs retain
dataset trust. The 20 new calls cost $0.030941. Four reused baseline calls cost
$0.007987, for $0.038928 across the 24 unique completions used by this study.
These call totals are distinct from conditional policy costs.

The separate framed transport preserves the existing CPU, memory and network
limits while admitting larger fixtures. Public-signature normalization was
frozen uniformly before inference. Synthetic agreement can preserve shared
errors, and no claim is made that these tasks were absent from model training.
No deployed latency measurement or production-path benchmark was performed.

Cached posthoc ablations found that all three two-sample pair policies also
scored 6/6, at $0.020815, $0.017949 and $0.024296 respectively. One pair was
cheaper than the frozen three-sample policy. Those results did not choose or
retune the frozen policy and do not establish which policy generalizes best.
A fresh comparison must include two-sample and adaptive sampling controls.

The [structured outcomes](fusion-behavior-majority-study.json) include public
synthetic inputs, output fingerprints, decisions and costs. The published
selector tests replay those decisions and totals. Raw model outputs and
private test fixtures are excluded; evidence hashes alone are not a complete
model-generation reproduction kit. Production defaults remain unchanged.

## Limits and next gate

These small studies are smoke tests, not sufficient confirmation. The sample was new
to this experiment, not demonstrated absent from model training. Results apply
to this adapted functional Python evaluation, not an official LiveCodeBench
score. Lookup controls qualify transport and assertions, not full algorithm
correctness or coverage. Mutable provider names are not pinned weights.

The current gateway supports an adviser→aggregator structure but does not run
these public tests. This pilot's feedback-bearing revision is therefore not
an exact production-path benchmark. It also does not measure deployed latency.
No image, dataset, model weights or additional compute resource was acquired.

The [structured results](fusion-functional-study.json) contain per-task grades,
costs and provenance hashes, without raw model text or private fixtures. Hashes
identify retained evidence; they are not a standalone reproduction kit. Further experiments must not reuse these exposed tasks as fresh confirmation
or treat a cheaper-than-Sol result as a collaboration win.
