# Fusion with exact-source anchor recovery

Enabling exact-source anchor recovery produced 9/9 cascade and strong-only
successes, versus 7/9 for independent cheap-only. The cascade used **68.61%
less estimated model cost** and **15.71% less aggregate workflow time** than
its strong-only control. The repeated-development gate still **failed**:
round one was slower, and round three had no quality advantage over cheap-only.

This is an exposed-cohort development check on three historical LRU-cache
tasks, each sampled three times. It does not qualify production behavior or
nine independent tasks. [Sanitized records](fusion-anchor-recovery-study.json)
retain all 27 arms and 28 calls.

## Results

| Strategy | Full success | Estimated model cost | Workflow time |
| --- | ---: | ---: | ---: |
| Independent cheap-only | 7/9 | $0.004027 | 59.98 s |
| Independent strong-only | 9/9 | $0.031441 | 95.85 s |
| Cheap-first, one strong repair | 9/9 | $0.009868 | 80.79 s |

The run cost $0.045336. Cache-neutral costs were $0.162934 for strong-only
and $0.038170 for the cascade, a 76.57% reduction. Verification infrastructure
is unpriced. One rejected cascade draft received a successful strong repair;
there were zero false accepts and zero lost strong successes.

| Round | Cheap | Strong | Cascade | Estimated savings | Cache-neutral savings | Cascade/strong time | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 2/3 | 3/3 | 3/3 | 30.01% | 49.75% | 1.205x | Fail: latency |
| 2 | 2/3 | 3/3 | 3/3 | 85.71% | 89.60% | 0.671x | Pass |
| 3 | 3/3 | 3/3 | 3/3 | 88.87% | 90.20% | 0.620x | Fail: cheap-only quality tie |

The frozen gate requires the aggregate and every round to match strong-only
quality, exceed independent cheap-only quality, lose no strong successes,
accept no incorrect output, save at least 20% in both cost measures, and take
no longer than strong-only. Attractive pooled numbers do not override a failed
round.

## What changed

The [preceding strict-anchor study](fusion-lru-repeat-study.md) rejected seven
cheap/draft batches for an incorrect line number. A zero-call diagnostic
corrected those positions against unique exact source matches; every recovered
batch passed the original public and full tests. That observation motivated
this separately frozen development experiment.

Every arm now enables the existing opt-in
[unique-source recovery helper](https://github.com/openclaw/clawrouter/pull/1353).
When the supplied line number is wrong, the helper accepts relocation only if
the unchanged search text occurs exactly once in the frozen original file and
starts at a line boundary. Valid anchors remain unchanged. Source digests,
allowed paths, edit bounds, overlap checks, public tests and held-out tests
remain mandatory. It performs no fuzzy matching or replacement-text repair.

The change applies equally to cheap-only, strong-only and both cascade stages.
Original prompts, model settings, task order and tests remain the same. Each
arm receives new independent model output; previous answers are not reused.
GPT-6 Luna supplies cheap attempts and GPT-6.1 Terra supplies strong attempts,
with medium reasoning and an 8,192-token output limit. Full grading begins
after all live arms finish. Neither tests nor snapshots are regenerated.

## Interpretation and limits

This run demonstrates aggregate cost and quality gains within its own controls.
It also shows that exact anchor recovery does not eliminate every failure or
fallback. The earlier saved-output diagnostic cannot predict success on every
new draw. Differences from the earlier run do not isolate the treatment's
effect size: the model outputs and provider cache state differ between runs.

The three remaining rejected cheap/draft batches failed the uniqueness check.
Their source text matched multiple locations, so the decoder kept rejecting
them instead of choosing a location by proximity. This guard remains intact.

Workflow time includes admission, request preparation, durable accounting,
decoding, public verification and cleanup. It excludes subsequent full grading
and receipt replay. A complete model-free outcome and cost replay matched all
records and preserved the original measured times; resumed timing is not
eligible for a gain claim.

The sample contains three already exposed tasks from one repository, selected
by the preceding ten-task qualification. Repetitions measure run variability,
not generalization to new tasks. Full tests mean the selected original suites,
not every upstream test. Private replay artifacts are retained, but the
sanitized records alone are not a turnkey independent reproduction.

No runtime default or deployment changes accompany this report. A reliable
production gain remains unqualified.
