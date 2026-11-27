# Fusion typed-array repair and strong-model handoff

Passing a rejected draft and its public test failure to the strong model reduced
its mean API time by 29.74% in this small conditional sample. It cost 2.50% more.
The earlier complete cheap-first workflow was slower and more expensive than
direct strong inference. Neither experiment passes its combined screening gate;
neither qualifies a serving default.

## Complete workflow

The task repairs typed-array serialization in
[Devalue](https://github.com/Rich-Harris/devalue/commit/9e44253852a9dd55726672596e8aa39c18fa35ee),
starting from its parent revision. Only `src/uneval.js` is editable. The original
public test checks typed-array values, offsets, backing-buffer lengths, raw
bytes, and shared-buffer identity. A bounded adapter preserves its synchronous
Vitest test bodies while running them under Node's native test runner. One
hash-selected outer typed-array group is withheld: 28 public and 32 full leaf
tests. All these tests are new in the upstream fix; there is no unchanged
regression holdout, and public examples expose the relevant requirements.

Reference and broken-parent runs matched between existing and prepared execution
for both public and full tests. The reference passed and the parent failed.
Each model attempt prepared a fresh protected fixture alongside inference,
verified the proposal, and removed the fixture. No cached proposal or shared
mutable fixture supplied a repair.

Three draws per arm used identical original source and public context. Luna used
low reasoning and a 4,096-token output ceiling; Terra used low reasoning and
8,192. Arm order rotated. Calls had no reported cache reads or writes. Full
grading followed all model calls.

| Strategy | Full passes | Rescues | Estimated API cost, USD | Mean workflow seconds |
| --- | ---: | ---: | ---: | ---: |
| Luna, fresh Terra on public failure | 3/3 | 3 | 0.027095 | 10.982 |
| Direct Terra | 3/3 | 0 | 0.023674 | 6.018 |
| Independent Luna-only | 2/3 | 0 | 0.003128 | 7.264 |

The cascade cost 14.45% more and took 82.48% longer than direct Terra. Every
cascade initial failed public verification; all three fallbacks passed full
grading. Independent Luna draws passed twice. This difference between small
independent samples is not an orchestration accuracy gain. Twelve model calls
cost $0.053897. No publicly accepted repair failed full grading.

Workflow time includes request setup, API calls, accounting, fixture preparation,
public verification and cleanup. Initial runtime admission and final full
grading are excluded.

## Conditional strong-model handoff

All four rejected Luna initials from that run were retained, including the one
independent cheap-only failure. Each received one independent fresh Terra retry
and one Terra retry with the rejected proposal and first trusted public failure.
Both received the same original source, public tests, model settings and output
ceiling. Pair order alternated; all eight calls preceded full grading. Hidden
tests and reference edits were not supplied to either arm.

| Strong retry | Full passes | Estimated API cost, USD | Mean API seconds |
| --- | ---: | ---: | ---: |
| Fresh original request | 4/4 | 0.032337 | 5.070 |
| Original request, rejected proposal and public failure | 4/4 | 0.033147 | 3.562 |

Handoff was faster in three of four pairs. Both arms passed all public and full
tests, with no false accepts. The frozen gate required all handoffs to pass,
no paired quality loss, at least 20% cost and API-time reductions, and three of
four time wins. Cost failed that gate. Eight calls cost $0.065484. These are
conditional component measurements, not complete workflow times or eight
independent tasks.

## Why the faster component is insufficient

In the complete cascade sample, mean initial-stage time was 5.222 seconds and
mean fallback-stage time was 5.732 seconds. The direct strong workflow averaged
6.018 seconds. Holding the initial stage fixed would leave less than 0.797
seconds for fallback to match the direct mean, even before inter-stage overhead.
That would require more than an 86.1% reduction in fallback-stage time.

As an illustrative cross-study calculation, adding the observed handoff API
mean alone to the initial-stage mean gives 8.784 seconds, already above 6.018.
This is not a measured combined workflow: draws differ, and the calculation
omits fallback setup, verification, cleanup and inter-stage gaps. It rules out
claiming that this component result demonstrates a whole-workflow gain. Further
repetitions of the same variant were stopped. A new candidate must change the
critical path or demonstrate reliable initial acceptance on separate tasks.

## Evidence and limits

[Machine-readable rows and arithmetic inputs](fusion-devalue-handoff.json)
include frozen protocol, result and audit hashes. Seventeen workflow/component
rows represent twenty model calls on one historical repair. Raw response and
fixture artifacts remain private, limiting external reproduction. Costs use
recorded usage and frozen tariffs, not an independently reconciled invoice.
Historical source may be in training data. These small, correlated samples do
not establish population accuracy, latency percentiles, cross-provider behavior,
or production readiness. No deployment or serving defaults changed.
