# SemVer cascade pilot and task transfer

A fixed cheap-first cascade matched the strong model on two previously
unexposed tasks, solving 2/2 while cheap-only solved 1/2. Its replayed model cost
was **43.42% lower**, or **44.17% lower on the cache-neutral basis**. The first
candidate passed public and full tests; the second failed public verification
and selected the passing strong control.

This is a two-task, same-package transfer smoke test. It does not qualify
production routing, total operating cost or live workflow latency. The
[sanitized data](fusion-semver-transfer.json) also retains the failed initial
policy and the exposed development repeat.

## Results

| Study | Task exposure | Strong | Cascade | Cheap | Strong model cost | Replayed cascade cost | Cost change |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial line-edit pilot | First campaign exposure, four tasks | 3/4 | 3/4 | 0/4 | $0.159608 | $0.177583 | +11.26% |
| Anchored development repeat | Same four exposed tasks | 3/4 | 3/4 | 2/4 | $0.183253 | $0.101509 | -44.61% |
| Anchored task transfer | Two new tasks in the same package | 2/2 | 2/2 | 1/2 | $0.095620 | $0.054099 | -43.42% |

There were no observed false public acceptances or lost strong-model successes
in these samples. The development repeat gained one full-test success over
cheap-only; the transfer gained one. A strong development response was rejected
for an invalid source anchor and remains a failure.

Cache-neutral cascade cost increased 11.51% in the initial pilot, then fell
40.32% in the development repeat and 44.17% in transfer. Normalization charges
all input tokens at the frozen uncached input rate and output tokens at the
frozen output rate. It does not price local verification or orchestration.

Both models were called on every admitted task to obtain paired controls.
Replayed cascade cost counts each cheap call plus the strong call only when
the cheap public gate rejects it. It is not the experiment's actual bill or a
separately executed live cascade. The three paired studies together incurred
$0.479967 in usage-based model-cost estimates. No timing gain is claimed.

## Fixed policy and qualification

The model pair was `openai/gpt-6-luna` and `openai/gpt-6.1-terra`, with one
attempt per model, medium reasoning and an 8,192-token output limit. Request
order alternated cheap/strong and strong/cheap across tasks. The current policy
uses strict source-anchored edits against frozen originals. Public verification
must pass with the qualified reference assertion count before accepting cheap;
full tests independently check the selected answer. Failed or malformed
responses remain failures.

The initial pilot used line-number edits. The development repeat changed to
anchored edits and included recursive static public-test dependencies. These
changes were kept for transfer. The studies are not a controlled ablation of
either change, and the initial policy's negative result must not be omitted.

Each case uses a historical [node-semver](https://github.com/npm/node-semver)
fix and its parent. The original tests are retained. One deterministically
selected, unchanged table row is withheld from public context; newly added
regression rows remain public. A reference must pass, an unchanged baseline
must fail with a complete valid TAP result, and both must execute the same
assertion count. Full grading requires the complete passing reference assertion count.

Four transfer candidates were frozen before inference. Two qualified:

- [`e583226`](https://github.com/npm/node-semver/commit/e583226b165edd6530502cf731eda334527af6fe): numeric segments after x-ranges; 584 public and 586 full assertions.
- [`046da7f`](https://github.com/npm/node-semver/commit/046da7f527cc72a482b5dea8cb59392be65bf186): caret lower bounds with `includePrerelease`; 579 public and 580 full assertions.

Two were excluded before any model call, without relaxing qualification:

- [`17aa702`](https://github.com/npm/node-semver/commit/17aa702d91166472b197a2ea768f085083bee2e4): baseline and reference executed different assertion counts.
- [`af761c0`](https://github.com/npm/node-semver/commit/af761c05bd53eef83b5e20f8b09360b0e70557dc): the baseline produced an invalid TAP plan.

The two admitted task IDs were absent from the 849 existing campaign protocol
files checked before inference. This establishes only observed campaign
exposure, not absence from model training. Their package and range-parsing
family had already been used in development.

## Runtime and evidence limits

Qualification and grading used the same pinned Node 24.22.1 Linux/ARM64 image
and TAP tool archive. Sandboxes disabled network access, protected test files
from candidate writes and enforced resource limits. Artifact hashes, source
revisions, qualification counts and every outcome are in the data file.

The development repeat's responses were saved before its grading completed.
Delayed container creates were positively identified, retired and followed by
a passing cached-image smoke check. Recovery reused the saved responses and
did not repeat inference. Its timing remains unqualified.

The evidence supports a promising verifier-gated pair on these tasks. It does
not establish reliability across repositories, a learned routing policy, a
latency improvement or savings after verifier infrastructure cost. More
independent tasks and live cascade runs are still required. Production defaults
and the Worker ensemble endpoint are unchanged.

## Recompute

This recomputes the published model-cost and quality totals from the sanitized
paired outcomes. It does not independently reproduce runtime provenance; the
raw response and runtime receipts remain in the retained experiment archive.

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync('docs/fusion-semver-transfer.json', 'utf8'));
for (const study of report.studies) {
  const tasks = study.cases.filter(c => c.admitted);
  assert.equal(study.records.length, tasks.length * 2);
  const total = { strong: 0, cascade: 0, normalizedStrong: 0, normalizedCascade: 0,
    strongSuccess: 0, cascadeSuccess: 0, cheapSuccess: 0, falseAccepts: 0, strongLosses: 0 };
  for (const task of tasks) {
    const find = arm => study.records.find(r => r.caseId === task.id && r.arm === arm);
    const cheap = find('cheap'), strong = find('strong');
    assert.ok(cheap && strong);
    const accepted = cheap.publicValid === true && cheap.publicPassed === true
      && cheap.publicAssertions === task.qualification.results.referencePublic.assertions;
    const selected = accepted ? cheap : strong;
    total.strong += strong.costMicros;
    total.cascade += cheap.costMicros + (accepted ? 0 : strong.costMicros);
    total.normalizedStrong += strong.normalizedMicros;
    total.normalizedCascade += cheap.normalizedMicros + (accepted ? 0 : strong.normalizedMicros);
    total.strongSuccess += Number(strong.success);
    total.cheapSuccess += Number(cheap.success);
    total.cascadeSuccess += Number(selected.success);
    total.falseAccepts += Number(accepted && !cheap.success);
    total.strongLosses += Number(strong.success && !selected.success);
  }
  const expected = study.summary;
  for (const key of ['strongSuccess', 'cascadeSuccess', 'cheapSuccess', 'falseAccepts', 'strongLosses'])
    assert.equal(total[key], expected[key]);
  assert.equal(total.strong, expected.strongCostMicros);
  assert.equal(total.cascade, expected.cascadeCostMicros);
  assert.equal(total.normalizedStrong, expected.normalizedStrongMicros);
  assert.equal(total.normalizedCascade, expected.normalizedCascadeMicros);
  assert.equal(study.records.reduce((sum, r) => sum + r.costMicros, 0), study.actualPairedCostMicros);
  console.log(study.name, total, 'saving', 1 - total.cascade / total.strong);
}
JS
```
