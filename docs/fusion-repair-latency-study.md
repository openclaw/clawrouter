# Repairing rejected Fusion drafts

Passing a rejected draft and its public failure to the strong fallback reduced
aggregate API time by **24.19%** in a paired component test. The subsequent
full-workflow test still **failed**: the cascade matched strong-only quality
but took **3.40% longer**, and independent cheap-only solved every task for
less cost and time.

Neither test qualifies an overall improvement. Routing defaults remain
unchanged. [Sanitized records](fusion-repair-latency-study.json) retain all
12 component calls and 18 full-workflow arms with their 20 calls.

## Full-workflow result

| Strategy | Full success | Estimated model cost | Workflow time |
| --- | ---: | ---: | ---: |
| Independent cheap-only | 6/6 | $0.012236 | 91.21 s |
| Independent strong-only | 6/6 | $0.120622 | 134.72 s |
| Cheap-first, repair fallback | 6/6 | $0.036041 | 139.31 s |

The cascade used 70.12% less estimated model cost than strong-only.
Cache-neutral costs were $0.148013 for strong-only and $0.069963 for the
cascade, a 52.73% reduction. Against cheap-only, however, the cascade cost
2.95 times as much and took 52.72% longer. The full run cost $0.168899;
the component run cost $0.121720. Verification infrastructure is unpriced.

The two rejected cascade drafts received successful strong repairs. All
accepted outputs passed the held-out tests, with zero lost strong successes.
The gate required at least strong-only quality, quality above cheap-only,
at least 20% savings in both cost measures, and total workflow time no greater
than strong-only. Both cost conditions passed; the latency and cheap-only
quality conditions failed.

This reused all six already exposed tasks from the
[fresh-package study](fusion-fresh-package-study.md). It is a development
comparison, not independent task transfer. Initial model requests, original
test groups, model settings and strict anchored acceptance were unchanged.
The only workflow change was one strong repair receiving its own rejected
proposal and bounded public failure, including a proposal rejected for invalid
anchors. Invalid edits remained unaccepted. No candidate was replaced.

The three arms were independent and their order was fixed by hash before
inference. Full tests ran only after all live arms. Workflow time includes
per-stage admission, request preparation, durable accounting, decoding,
public verification and cleanup; it excludes later held-out grading and
receipt replay. The cached Node image and TAP/Tape tooling were reused.
A complete outcome and cost replay matched every result without new model
calls, preserving the original measured times.

The earlier fresh-fallback run took 24.68% more time than strong-only, but
these separate draws do not isolate repair's effect on full-workflow latency.
The paired component test below supports a narrower API-time conclusion.
Cheap-only improved from 4/6 in the earlier run to 6/6 here, illustrating why
one small sample cannot establish reliable routing or general model quality.

## Conditional fallback comparison

| Strong fallback | Public and full success | Estimated cost | Cache-neutral cost | API time |
| --- | ---: | ---: | ---: | ---: |
| Fresh generation | 6/6 | $0.065781 | $0.195737 | 149.45 s |
| Repair rejected draft | 6/6 | $0.055939 | $0.189064 | 113.30 s |

Estimated cost fell 14.96%, and cache-neutral cost fell 3.41%. Both missed
the component gate's required 20% reduction.

The inputs were both public-rejected cascade drafts from the
[fresh-package study](fusion-fresh-package-study.md): safe object access and
typed-array serialization. Each task received three pairs of calls, with
balanced first-arm order. The original source, public tests, strong model,
medium reasoning effort and 8,192-token output limit matched within each pair.
Only repair received the frozen rejected proposal and public failure.

The invalid source anchors in one draft remained invalid. The proposal was
diagnostic input; strict anchored decoding still determined whether a generated
answer could proceed to testing. The other draft's changed assertion count was
reported as rejection feedback, never accepted as a successful test run.

All 12 calls finished before candidate grading. Original public and held-out
tests passed with exact reference assertion counts for every answer. Every
repair also beat its paired fresh call on API time, and both task totals were
faster. Estimated cost is derived from frozen usage tariffs, not reconciled
provider invoices. Cache-neutral totals remove the cached-input discount.

The fixed gate required all repairs to pass, no lost fresh successes, at least
20% reductions in both cost measures and API time, at least four time wins,
and lower aggregate time on each task. The cost conditions failed. Six pairs
on two already exposed tasks do not establish statistical significance,
new-task transfer or reliable tail latency. API time excludes request setup,
verification and other workflow overhead.

## Recompute the results

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync('docs/fusion-repair-latency-study.json'));
const c = data.component;
assert.equal(c.records.length, 12);
for (const arm of ['fresh', 'repair']) {
  const rows = c.records.filter(r => r.arm === arm);
  assert.equal(rows.length, 6);
  for (const r of rows) {
    assert.ok(r.public.valid && r.public.passed && r.full.valid && r.full.passed);
    assert.equal(r.public.tests, r.public.expectedTests);
    assert.equal(r.full.tests, r.full.expectedTests);
  }
  for (const field of ['costMicros', 'normalizedMicros', 'apiMs']) {
    const total = rows.reduce((n, r) => n + r[field], 0);
    assert.ok(Math.abs(total - c.summary[arm][field]) < 1e-6);
  }
}
assert.equal(c.summary.componentGatePassed, false);
assert.equal(c.summary.workflowGainQualified, false);
const w = data.workflow;
assert.equal(w.records.length, 18);
assert.equal(w.calls.length, 20);
for (const strategy of ['cheap', 'strong', 'cascade']) {
  const rows = w.records.filter(r => r.strategy === strategy);
  const calls = w.calls.filter(r => r.strategy === strategy);
  assert.equal(new Set(rows.map(r => r.caseId)).size, 6);
  assert.ok(rows.every(r => r.publicPassed && r.passed && r.full.valid &&
    r.full.passed && r.full.tests === r.full.expectedTests));
  const sum = (values, field) => values.reduce((n, r) => n + r[field], 0);
  assert.equal(sum(rows, 'costMicros'), sum(calls, 'costMicros'));
  assert.equal(sum(rows, 'normalizedMicros'), sum(calls, 'normalizedMicros'));
  assert.equal(sum(rows, 'costMicros'), w.summary[strategy].costMicros);
  assert.ok(Math.abs(sum(rows, 'elapsedMs') - w.summary[strategy].elapsedMs) < 1e-6);
}
assert.ok(w.summary.cascade.elapsedMs > w.summary.strong.elapsedMs);
assert.equal(w.summary.cascade.passed, w.summary.cheap.passed);
assert.equal(w.summary.routingLead, false);
assert.equal(w.summary.liveDevelopmentLead, false);
JS
```

Raw prompts, completions, provider request IDs and private harness sources are
not included. The data supports arithmetic checks, not independent runtime
reproduction. No runtime or routing-default change is established by this
component result.
