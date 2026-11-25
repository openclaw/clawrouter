# Cheap reviewers for coding-model cascades

This study tests whether a cheap acceptance review can keep a small model's
correct answer and escalate its mistakes to a stronger model. The earlier
[always-review study](fusion-livecodebench-study.md) failed to establish a
reproducible cost advantage. Production Fusion remains unchanged.

## Reviewer-cost experiment

A new, fixed cohort contained 13 untouched tasks: two medium and eleven hard.
These were previously excluded only by the 16,000-byte fixture bound. The
adapter admitted up to 65,536 fixture bytes while preserving all public tests
and the same input-hash selection of up to sixteen private inputs per task.
All 555 supplied inputs passed problem-specific contract checks. Independent
solvers verified all supplied outputs for three tasks; other outputs still
rely on the dataset. The execution sample contained 35 public and 208 private
tests. Positive lookup and blank negative controls passed for every task.

Luna and Sol 6.2 produced direct solutions with the same medium effort and
8,192-token bound. Public-passing Luna solutions received separate Luna and
Sol acceptance reviews, each at low effort and 512 tokens. Reviews returned
only an acceptance flag and short reason. Invalid, incomplete or negative
verdicts selected the saved strong direct answer; there was no repair. All
inference finished before private grading.

| Policy | Passed | Model cost (USD) | Saving versus strong |
| --- | ---: | ---: | ---: |
| Luna direct | 8/13 | $0.019698 | — |
| Sol 6.2 direct | 13/13 | $0.124634 | — |
| Luna acceptance review, otherwise strong | 13/13 | $0.121926 | 2.17% |
| Sol acceptance review, otherwise strong | 13/13 | $0.120234 | 3.53% |

Neither cascade met the predeclared 20% saving screen. Sol accepted all eight correct Luna answers it reviewed and rejected both
incorrect answers it reviewed. Three other incorrect seeds failed public
tests and bypassed review. Its review cost consumed most of that advantage. Luna falsely rejected
three correct answers. The 46 unique calls cost $0.182088; shared direct calls
are billed once in the experiment and included in each applicable policy total.

## Exposed-cohort Terra diagnostic

A follow-up substituted GPT-6.1 Terra for Sol in the same ten public-passing
review requests. Only model and request identity changed. This used an already
observed cohort, so it is a diagnostic, not fresh confirmation. The ten new
calls cost $0.021405. Direct answers and grades were reused.

| Diagnostic policy | Passed | Model cost (USD) | Saving versus strong |
| --- | ---: | ---: | ---: |
| Terra acceptance review, otherwise strong | 13/13 | $0.113681 | 8.79% |
| Luna review, then Terra on rejection, otherwise strong | 13/13 | $0.099654 | 20.04% |

The second result cleared the cost threshold by only $0.0000532. It is a weak
lead, with no independent quality guarantee. Terra's frozen token rates were
half the strong model's rates; token prices alone do not establish cheaper
completed tasks. The model's [official documentation](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
is the price source. Model identities are mutable provider names, not pinned
weights.

## Fresh replication fails the quality screen

Before new inference, the policy was frozen as Luna review, then Terra review
on rejection or invalid output, with strong fallback otherwise. The eight
untouched tasks comprised two medium and six hard problems excluded from the
previous cohorts. All supplied inputs passed declared contract checks; two
independent solvers verified the outputs for their respective problems. The
sample retained all 23 public and 128 hash-selected private tests. Fixture
admission rose to 120,000 bytes; candidate memory, CPU, RPC and time limits did
not change. Hashing the trusted lookup control's input keys reduced duplicate
fixture storage without changing candidate execution.

| Policy | Passed | Model cost (USD) |
| --- | ---: | ---: |
| Luna direct | 4/8 | $0.013214 |
| Sol 6.2 direct | 8/8 | $0.071072 |
| Luna review, then Terra if needed, otherwise strong | 7/8 | $0.053303 |

The cascade cost 25.00% less but lost one strong-model success. It failed the
predeclared quality-and-cost screen. All 24 unique calls cost $0.095201, and an
independent replay reproduced every saved grade and the complete call ledger.
Five seeds passed public examples, five Luna reviews ran, and three of those
required Terra reviews. No private result affected these decisions.

The false acceptance was AtCoder `abc389_f`: Terra approved the algorithm and
its resource complexity, but the candidate produced nine runtime errors across
the full 19-test batch after passing all three public examples. No extra
repair, changed limit or discarded test rescued its original score. This
result rejects the exposed-cohort lead as sufficient evidence to ship.
A post-audit diagnostic reproduced nine `MemoryError`s with unchanged limits.
The candidate exited normally after catching them and used about 1.19 CPU
seconds; this was not a CPU timeout. The original prompts did not state the
160 MiB sandbox limit. Future runtime-aware prompts must disclose that limit
and be evaluated separately; this diagnosis does not revise the failed result.

Even an unattainable perfect post-seed escalation decision would cost
$0.057364 on this cohort: only 19.29% less than strong direct, before paying
any reviewer. That uses hidden correctness labels and is not deployable. It
shows that a 20% target is impossible for this fixed seed-then-fallback family
on this sample; improving the reviewer alone cannot meet it. Avoiding the
seed on unsuitable tasks is a separate hypothesis requiring new validation.

## Measurement limits

Costs use recorded provider usage and the frozen pricing configuration. They
exclude hardware, local grading and operations. Policies select from saved
responses; these totals do not measure a deployed cascade's end-to-end latency
or guarantee the same completions when called later. No hidden labels enter
review prompts or selection. Every attempted seed, used review and selected
fallback is charged, including invalid responses.

The source dataset is the same pinned
[LiveCodeBench code-generation-lite](https://huggingface.co/datasets/livecodebench/code_generation_lite)
revision documented in the earlier study. This is an adapted Python
`solve(input_text) -> str` evaluation, not an official LiveCodeBench score.
The existing network-isolated candidate runtime retained its 160 MiB address
space, five-second CPU allowance and bounded RPC messages. Lookup controls
verify transport and assertion behavior, not algorithm correctness or complete
constraint coverage. No new image, model weights or dataset was downloaded.

Per-task scores, costs, selected candidates and provenance hashes are in the
[structured result](fusion-reviewer-study.json). Raw prompts, completions and
private fixtures are not included. Hashes identify retained source and audit
receipts; they are not a standalone reproduction kit or independent attestation.

A subsequent [functional collaboration pilot](fusion-functional-study.md) adds
a matched Terra-direct and Terra-self-revision control. Fusion matched the
strong model, but did not beat the cheaper direct control.
