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

## Limits and next gate

Eight tasks are a smoke test, not sufficient confirmation. The sample was new
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
