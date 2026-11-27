# Fusion with independent cheap and strong controls

A cheap-first cascade solved **7/7** qualifying tasks, matching the independent
strong-only control and exceeding the independent cheap-only control's **2/7**.
The cascade used **51.33% less model cost** than strong-only and took **5.99% more
measured workflow time**. Three rejected drafts triggered successful fresh
strong fallbacks. No accepted cascade answer failed the held-out tests.

This passes the prospectively declared development gate on seven small-module
tasks across two repositories. It does not qualify production defaults. The
[sanitized data](fusion-independent-controls.json) retains all 21 arms, all 24
calls, every failed cheap-only answer and the excluded eighth candidate.
It extends the [three-task Undici pilot](fusion-undici-live-transfer.md) with
a matched, independent cheap-only control and repositories newly used in this
campaign.

## Results

| Strategy | Full success | Model cost | Measured workflow time |
| --- | ---: | ---: | ---: |
| Independent cheap-only | 2/7 | $0.009997 | 113.75 s |
| Independent strong-only | 7/7 | $0.140470 | 239.92 s |
| Cheap-first cascade | 7/7 | $0.068362 | 254.28 s |

All 24 calls together cost **$0.218829**. These are usage-based estimates under
frozen tariffs, not reconciled provider invoices. On a cache-neutral basis,
strong-only cost $0.137066 and cascade cost $0.082587: **39.75% less**. This
normalization prices all input tokens at the frozen uncached rate; it does not
normalize latency. Local verification infrastructure has additional, unpriced
cost.

| Upstream task | Cheap-only | Strong-only | Cascade | Fallback | Strong cost | Cascade cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [Constructor handlers](https://github.com/davidmarkclements/rfdc/commit/8c6bfec5610aa47eee23f624db692c751a56268f) | Fail | Pass | Pass | Yes | $0.018702 | $0.022929 |
| [Complex ArrayBuffers](https://github.com/davidmarkclements/rfdc/commit/1f1ff561895d8454041fac1ac55d35f57818e675) | Pass | Pass | Pass | No | $0.013332 | $0.000493 |
| [Typed arrays](https://github.com/davidmarkclements/rfdc/commit/56db370b698be713af71882ddcd548d53e1e0e08) | Fail | Pass | Pass | No | $0.012477 | $0.000686 |
| [Depth and edge limits](https://github.com/davidmarkclements/fast-safe-stringify/commit/ce7db512c3b3286877a992ab493c8fe8c0fed5e9) | Fail | Pass | Pass | Yes | $0.025443 | $0.020906 |
| [Restore after exceptions](https://github.com/davidmarkclements/fast-safe-stringify/commit/a255cd19fd3acd979677d06eaa5c87b0573af030) | Fail | Pass | Pass | No | $0.020632 | $0.000795 |
| [Non-configurable circular getters](https://github.com/davidmarkclements/fast-safe-stringify/commit/42a3416c8f0e5dd5927745f26ab386f1b6ca1842) | Fail | Pass | Pass | Yes | $0.029347 | $0.020985 |
| [Getter restoration](https://github.com/davidmarkclements/fast-safe-stringify/commit/af200135e2fdb39caea27143b2ae227909b86661) | Pass | Pass | Pass | No | $0.020537 | $0.001568 |

The constructor-handler cascade cost 22.60% more than its strong-only control
and took 15.82% longer. The depth/edge-limit cascade was 92.18% slower; its
cache-neutral cost was 23.62% higher than strong-only. Aggregate savings do not
guarantee savings or lower latency on every task.

The three fallback rescues show useful verification and escalation. The other
two improvements over cheap-only came from different cheap-model draws: on
typed arrays and exception restoration, the independent cheap control failed
while the cascade's independent cheap draft passed. That difference cannot be
credited to collaboration. The fallback used the original task, without the
failed draft or its feedback; this study tests routing, not information-sharing
synergy.

## Frozen comparison

The models were `openai/gpt-6-luna` and `openai/gpt-6.1-terra`, with medium
reasoning, an 8,192-token output ceiling and a 180-second request timeout.
Cheap-only made one independent call with exactly the same request body and
settings as the cascade draft. Strong-only made one call. Cascade bought at
most one fresh strong call after rejecting its cheap draft against public tests.
A fixed hash seed ordered the three arms before inference. Each arm executed
once, with at most one call per planned role.

Models received the original source, task instruction and partial public tests.
They returned strict anchored edits to declared source files. They could not
edit tests or add dependencies. All arms completed before the hidden full-test
grading began. Invalid artifacts and incomplete or changed test counts failed;
they were not silently discarded. The receipt-only audit replayed the saved
responses and reproduced every outcome and cost without another model call.

The development gate required cascade success at least as high as strong-only
and strictly above cheap-only, zero losses relative to strong-only, zero false
accepts, at least 20% lower cost on both price bases, and total workflow time no
more than 1.2 times strong-only. All conditions passed. The frozen cap was 28
calls with a $4 study budget and $0.50 per-arm cap; the planned worst-case request
cost was $1.094028. Actual execution used 24 calls.

## Qualification and limits

Eight historical changes were selected before runtime outcomes or inference:
three in `rfdc` and five in `fast-safe-stringify`. The seven qualifying tasks had
failing unchanged baselines and passing reference repairs at identical assertion
counts, with no skipped tests. Their public/full counts were 294/299, 261/262,
225/226, 54/56, 50/52, 45/48 and 44/46. One unchanged top-level test group per test
file was withheld. No failed candidate was replaced.

The [circular-child-getter candidate](https://github.com/davidmarkclements/fast-safe-stringify/commit/235008507e3061559d55e1eba8acab7748ae13fe) was excluded because its
unchanged baseline already passed both public and full tests (43/50 assertions).
It could not demonstrate a repair. The original failed infrastructure attempt
produced no task results or paid calls. After the existing runtime recovered,
the same roster was rebound to the reviewed harness and qualified successfully.

The exact candidate IDs, base revisions and reference revisions were absent
from 856 saved protocols and 170 call journals inspected before the initial
freeze. Both repositories were new to this campaign; they are public historical
code and may appear in model training data. This is not training-data
decontamination, a blind external benchmark or evidence for broad coding tasks.

Sandboxes reused a pinned Node 24.22.1 Linux/ARM64 image, cached TAP 16.3.10
libraries and a checksum-verified `clone` 2.1.2 helper where required. This is
an adapted historical test harness, not each repository's original package-manager
environment. It used no runtime networking and protected the tests from edits.
No new model download, compute allocation or dependency installation was needed.

Times sum live arms, including request admission and metadata checks, API time,
decoding and public verification. They exclude later full grading and audit;
the audit retains the original measured times. Provider load and caching vary.
Seven tasks and one draw per arm do not establish statistical significance,
production reliability or a stable cost/latency improvement. The raw responses
and private harness are not bundled; the public artifact supports arithmetic
checks, not independent runtime reproduction. Deployed routing is unchanged.

## Recompute published totals

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync('docs/fusion-independent-controls.json', 'utf8'));
assert.equal(r.records.length, 21);
assert.equal(r.calls.length, 24);
assert.equal(r.candidates.filter(x => x.qualified).length, 7);
for (const strategy of ['cheap', 'strong', 'cascade']) {
  const rows = r.records.filter(x => x.strategy === strategy);
  assert.equal(new Set(rows.map(x => x.caseId)).size, 7);
  const sum = key => rows.reduce((n, x) => n + x[key], 0);
  assert.equal(rows.filter(x => x.passed).length, r.summary[strategy].passed);
  assert.equal(sum('costMicros'), r.summary[strategy].costMicros);
  assert.ok(Math.abs(sum('elapsedMs') - r.summary[strategy].elapsedMs) < 1e-6);
  if (strategy !== 'cheap') {
    assert.equal(sum('normalizedMicros'), r.summary.costComparison[strategy].normalizedMicros);
  }
  for (const row of rows) {
    const calls = r.calls.filter(x => x.caseId === row.caseId && x.strategy === strategy);
    assert.equal(calls.length, row.escalated ? 2 : 1);
    assert.equal(calls.reduce((n, x) => n + x.costMicros, 0), row.costMicros);
    assert.equal(calls.reduce((n, x) => n + x.normalizedMicros, 0), row.normalizedMicros);
    if (row.passed) {
      const task = r.candidates.find(x => x.id === row.caseId);
      assert.ok(row.publicPassed && row.full.valid && row.full.passed);
      assert.equal(row.full.tests, task.expectedTests.full);
    }
  }
}
assert.equal(r.calls.reduce((n, x) => n + x.costMicros, 0), r.actualExperimentCostMicros);
assert.equal(r.records.filter(x => x.escalated).length, r.summary.escalations);
assert.equal(r.summary.falseAccepts, 0);
assert.equal(r.summary.strongLosses, 0);
assert.equal(r.summary.routingLead, true);
assert.equal(r.summary.qualifiedProductionGain, false);
console.log(r.summary);
JS
```
