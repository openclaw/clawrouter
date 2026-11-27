# Fresh-package Fusion comparison

The cheap-first cascade solved **6/6** qualifying tasks, matching strong-only
and exceeding independent cheap-only (**4/6**). It used **55.88% less model
cost**, but took **24.68% more workflow time**. It therefore **failed** the
prospective requirement to match or improve strong-only latency.

This is a cost/latency tradeoff, not a qualified overall improvement. Routing
defaults remain unchanged. The [sanitized records](fusion-fresh-package-study.json)
retain all 18 arms, 20 calls and ten candidate qualification outcomes. A
receipt-only replay reproduced every outcome and cost without model calls,
while preserving the original measured times.

## Results

| Strategy | Full success | Estimated model cost | Workflow time |
| --- | ---: | ---: | ---: |
| Independent cheap-only | 4/6 | $0.011844 | 97.60 s |
| Independent strong-only | 6/6 | $0.141935 | 122.48 s |
| Cheap-first cascade | 6/6 | $0.062617 | 152.70 s |

All calls cost **$0.216396** under frozen usage tariffs. These are estimates,
not reconciled provider invoices. Cache-neutral costs were $0.144451 for
strong-only and $0.079239 for cascade: **45.14% lower**. Local verification
infrastructure has additional, unpriced cost.

Two rejected cascade drafts triggered successful fresh strong fallbacks.
There were zero lost strong successes and zero accepted answers that failed
the held-out tests. Independent cheap-only failed the safe-access task and
the undefined-property task. The latter passed on the cascade’s separate
cheap draw, so that difference cannot be credited to collaboration. On the
typed-array task, independent cheap-only passed while the cascade needed
fallback. One independent draw is noisy evidence.

| Task | Cheap | Strong | Cascade | Fallback |
| --- | --- | --- | --- | --- |
| [fix: implement safe option for toJSON and make other accesses safe](https://github.com/BridgeAR/safe-stable-stringify/commit/132e76cad22529011f7b517070f5d857dbca7fc1) | Fail | Pass | Pass | Yes |
| [fix: correct overflow info for arrays with maximumBreadth (#61)](https://github.com/BridgeAR/safe-stable-stringify/commit/66517e725672aa843f2b859012a78f03a7bf3004) | Pass | Pass | Pass | No |
| [fix(typed-array): serialize non-finite floating-point values (#73)](https://github.com/BridgeAR/safe-stable-stringify/commit/25b3110f88edac7fee70e2e604848c365d9b2286) | Pass | Pass | Pass | Yes |
| [fix: enforce maximumDepth for nested objects with array replacers (#64)](https://github.com/BridgeAR/safe-stable-stringify/commit/a8df6a14cb25522dd851087e265c57cb6ff3cad2) | Pass | Pass | Pass | No |
| [Also handle cloneProtoObject in mergeObject (#45)](https://github.com/fastify/deepmerge/commit/bc2075c0993bb15e98c87a21ff7d44bbda59ae59) | Pass | Pass | Pass | No |
| [feat: add onlyDefinedProperties option (#77)](https://github.com/fastify/deepmerge/commit/aa0137863598ccb351fba5f6c1ac75b65d27dccb) | Fail | Pass | Pass | No |

## What the timing shows

The cascade added 30.22 seconds in aggregate: 17.91 seconds inside recorded
model calls and 12.31 seconds outside them. The latter includes request
preparation, admission, accounting, decoding, public verification and cleanup;
it does not isolate any one component. The prior staging and selected-model
preflight changes were enabled. They do not remove the extra call and
verification work when a draft fails.

Times cover live arms, including all per-call setup and public checks. They
exclude later held-out grading and receipt replay. Six tasks and one draw
per arm do not establish statistical significance or reliable tail latency.

## Frozen method and exclusions

The models were `openai/gpt-6-luna` and `openai/gpt-6.1-terra`, both with medium
reasoning and an 8,192-token output limit. Cheap-only used the exact cascade
draft settings in an independent call. Strong-only used one call. The cascade
could make one fresh strong call after public rejection; it did not pass the
failed draft or feedback into that fallback. Arm order was fixed by hash
before inference. Generated answers received full-test grading only after
every live arm completed.

The gate required at least strong-only success, more success than cheap-only,
zero lost strong successes or false accepts, at least 20% lower estimated and
cache-neutral cost, and workflow time no greater than strong-only. Quality
and both cost tests passed; time failed.

Ten runtime candidates were frozen before qualification: six from
`safe-stable-stringify` and four from `@fastify/deepmerge`. Six qualified.
Three excluded baselines changed assertion counts; the array-merge baseline
produced invalid TAP. Their failures remain in the data. Four additional
newer stringify candidates were excluded before the runtime freeze because
their module wrappers were outside the existing fixture policy. No candidate
was replaced after runtime qualification.

Correct reference code had to pass full and public original tests. Broken
parent code had to fail both with valid TAP and unchanged assertion counts.
Public tests withheld original groups selected before inference. Models
received the remaining tests and original source, and could edit only
`index.js`; they could not alter tests or add dependencies.

The local exposure screen checked 21,505 saved protocol, manifest and call
journal files, totaling 2,326,636,697 bytes, for repository identities, revisions
and complete serialized production sources. No matches were found. This
addresses reuse within this campaign; historical public code may be in model
training data. It is not training-data decontamination.

Execution reused the pinned Node 24.22.1 Linux/ARM64 image. The original
TAP 16.3.10 tools stayed unchanged; Tape 5.7.5 and its locked dependencies
were installed once in isolated temporary scratch with lifecycle scripts
disabled, then bundled alongside TAP. The cached, verified `clone` 2.1.2
helper was reused. Original assertions ran without runtime networking and
with protected tests. This is an adapted harness, not each upstream project’s
original package-manager environment. Private responses and harness sources
are not bundled; the public data supports arithmetic checks, not independent
runtime reproduction.

## Recompute the totals

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync('docs/fusion-fresh-package-study.json'));
assert.equal(r.records.length, 18);
assert.equal(r.calls.length, 20);
assert.equal(r.candidates.filter(x => x.qualified).length, 6);
for (const strategy of ['cheap', 'strong', 'cascade']) {
  const rows = r.records.filter(x => x.strategy === strategy);
  const calls = r.calls.filter(x => x.strategy === strategy);
  assert.equal(new Set(rows.map(x => x.caseId)).size, 6);
  assert.equal(rows.filter(x => x.passed).length, r.summary[strategy].passed);
  const sum = (xs, key) => xs.reduce((n, x) => n + x[key], 0);
  assert.equal(sum(rows, 'costMicros'), r.summary[strategy].costMicros);
  assert.equal(sum(calls, 'costMicros'), sum(rows, 'costMicros'));
  assert.ok(Math.abs(sum(rows, 'elapsedMs') - r.summary[strategy].elapsedMs) < 1e-6);
}
assert.equal(r.calls.reduce((n, x) => n + x.costMicros, 0), r.actualExperimentCostMicros);
assert.equal(r.summary.routingLead, false);
assert.equal(r.summary.qualifiedProductionGain, false);
assert.ok(r.summary.elapsedRatio > r.policy.maxElapsedRatio);
console.log(r.summary);
JS
```
