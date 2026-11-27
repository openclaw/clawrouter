# Fractional-score false-accept study

The public-test cascade accepted an incorrect cheap answer. Independent cheap-only
and cascade drafts each passed all 22 public tests but failed the withheld test;
the independent strong-only answer passed all 23. The quality gate failed, so the
lower cost and observed time do not qualify a Fusion gain or a default change.

## Frozen comparison

One historical task from [the paired-loss fix](https://github.com/openclaw/clawrouter/commit/47dad40e9cfba52a9b349b392d1687a15e26e496)
was qualified using its original source and author task brief. Bounded static
tuple-group support made the previously excluded test file partitionable.
Reference full/public/hidden runs passed with exact counts of 23/22/1; the parent
failed 3/2/1 respectively with those counts intact. No replacement task was added.

Three independent draws ran in fixed order: cheap-only, strong-only, then a cheap
draft with at most one fresh strong fallback on public rejection. There was no
cheap repair or reused control. All inference and public routing finished before
full grading; hidden feedback never entered generation. The cascade accepted its
first draft, so it made no fallback call.

## Results

| Arm | Public tests | Full tests | Model cost (USD) | Workflow time |
| --- | --- | --- | --- | --- |
| Cheap-only | 22/22 | 22/23 | 0.001203 | 10.279 s |
| Strong-only | 22/22 | 23/23 | 0.010229 | 13.033 s |
| Cascade | 22/22 | 22/23 | 0.001135 | 10.441 s |

The three calls cost $0.012567 in total. Actual and cache-neutral accounting agree
for each arm. Costs use frozen tariffs and recorded usage, not invoice
reconciliation. Workflow time includes generation, public verification and caller
overhead, but excludes final hidden grading.

Both cheap outputs violated the same requirement: fractional scores must not
receive a binary-loss confidence bound. The strong output handled that domain.
These are two false accepts on one task, not a population failure-rate estimate.

The frozen development gate required preserved strong-only quality, improvement
over cheap-only, at most 80% of strong-only cost in both accounting views, and at
most 120% of its workflow time. Cost and time gates passed; quality preservation
and incremental quality failed. Development, population and production
qualification all remain false.

## Interpretation and provenance

Public-test success is incomplete acceptance evidence. A fallback cannot repair a
draft the controller never rejects. This case supports investigating verification
coverage; adding this now-exposed test and rerunning this task would be a
development repair, not independent confirmation of a better policy.

This is one historical task and one draw per arm, with a fixed execution order.
It establishes neither a general model ranking nor a latency advantage. No
serving policy, Worker behavior or routing default changes with this report.

The [sanitized record](fusion-fractional-score-study.json) preserves counts,
per-call accounting, gates and private evidence hashes. Hashes identify retained
evidence; they do not make private inputs independently reproducible. Raw source,
prompts, completions and local paths are omitted.
