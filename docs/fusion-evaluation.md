# Evaluate Fusion strategies

Use matched, held-out tasks to decide whether a Fusion strategy earns its extra
calls. Compare the strongest single model, a cheaper single model, and the
candidate workflow. Keep failures in the dataset. This tool analyzes completed
runs; it makes no API calls and does not execute generated code.

```sh
node scripts/evaluate-fusion.mjs runs.json --baseline single
```

The command emits JSON to stdout. Input is limited to 16 MiB and 50,000 records.
Unknown fields are rejected. Do not include prompts, answers, secrets or raw
reasoning. Store those separately only when their retention is authorized.

## Input contract

The following tiny synthetic example demonstrates the format. It provides no
evidence that a strategy is better.

```json
{
  "version": 1,
  "evaluationId": "synthetic-example",
  "datasetRevision": "synthetic-v1",
  "graderRevision": "exact-match-v1",
  "split": "test",
  "records": [
    { "caseId": "case-a", "domain": "code", "trial": 1, "strategy": "single", "configurationId": "single-v1", "score": 1, "costMicros": 10, "latencyMs": 100, "callCount": 1, "status": "completed" },
    { "caseId": "case-a", "domain": "code", "trial": 1, "strategy": "panel", "configurationId": "panel-v1", "score": 1, "costMicros": 30, "latencyMs": 250, "callCount": 3, "status": "completed" }
  ]
}
```

- Pin the dataset, grader and full strategy configuration in external versioned
  records. The configuration must identify provider model revisions, prompts,
  reasoning effort, tools, timeouts, retry limits and sampling parameters.
  The analyzer checks consistent identifiers; it cannot prove those external facts.
- Use at least two strategies. Every case/trial must have one record for every
  strategy. Case domains and strategy configurations must remain consistent.
  Missing pairs, duplicates and mixed configurations are errors.
- Use a positive integer trial index. Repeated runs retain the same case ID.
- Score each result between zero and one using executable checks or independently
  audited grading. Runtime failures use `status: "error"` and score zero.
  An incorrect but successfully returned answer is `completed` with its graded score.
- Record total billed `costMicros`, complete end-to-end `latencyMs`, and all
  attempted `callCount` calls, including failed advisers, retries and discarded
  drafts. A rejection before dispatch can have zero calls.
  If cost or grading is unknown, finish that measurement before comparing:
  do not encode unknown as zero or silently drop the run.

## Read the report

Quality, average cost, average latency and average calls give each case equal
weight, averaging repeated trials within a case first. Total cost includes all
runs. Error rate and p50/p95 latency describe individual runs; percentiles use
the nearest-rank definition. Domain scores and the worst-domain score expose
capabilities that an overall average can hide.

Pairwise wins, ties and losses compare case-averaged scores to the selected
baseline. The score delta has a reproducible 2,000-resample paired bootstrap
interval over cases, with seed 42. A single case produces a null interval.
This descriptive interval is not a power analysis or proof of generalization:
correlated tasks, biased graders and contaminated test sets still invalidate a
claim. Predeclare tolerances, use enough independent cases per domain, and
confirm the selected configuration on a fresh holdout.

Choose a measured quality/cost tradeoff, subject to latency and worst-domain
retention constraints. Never promote a configuration solely because a judge
prefers its prose. Keep tuning data separate from the test split.

Related primary sources:
[TRINITY](https://arxiv.org/abs/2512.04695),
[Conductor](https://arxiv.org/abs/2512.04388),
[inflation-aware routing](https://arxiv.org/abs/2608.13571), and
[FusionEval](https://arxiv.org/abs/2610.30162).
