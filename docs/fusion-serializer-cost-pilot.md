# Serializer cascade cost pilot

The tested cascade passed all three repetitions and used Terra to rescue two
failed Luna attempts. It cost 23.36% less than direct Terra, but its
mean workflow took 35.72% longer. Keep it experimental: it missed the
predeclared no-slowdown target and covers only one historical task.

## Results

| Strategy | Final passes | Fallback rescues | Total estimated API cost, USD | Mean workflow seconds |
| --- | ---: | ---: | ---: | ---: |
| Luna, fresh Terra on public failure | 3/3 | 2 | 0.072996 | 21.399 |
| Direct Terra | 3/3 | — | 0.095242 | 15.767 |
| Independent Luna-only | 1/3 | — | 0.009569 | 10.763 |

No public acceptance failed final grading. The two fallback rescues demonstrate
that Terra repaired attempts rejected by the verifier in this pilot. The
independent Luna-only draws are different samples from the cascade initials;
the 3/3 versus 1/3 comparison does not establish a population success rate.

[All nine workflows and eleven model calls](fusion-serializer-cost-pilot.json)
include per-call cost, API time, artifact validity and public acceptance. Total
estimated API cost was $0.177807. Costs derive from observed token usage and
frozen tariffs, not an independently reconciled invoice. Evidence hashes refer
to private frozen experiment records; the raw inference artifacts are not
published, so those hashes are not independent reproduction proof.

## Task and controls

The task reconstructs the historical [toJSON accessor
fix](https://github.com/BridgeAR/safe-stable-stringify/commit/4e6f20f1b70fdc743171fdb2f1a9f87592a15488)
from its parent. The three arms used the same original editable source, literal
public tests, original read-only CommonJS wrapper and package metadata. All
attempts returned anchored edits against original source. Unique exact-source
relocation was allowed consistently; other rejected edits remained failures.

Luna used low reasoning and a 4,096-token output ceiling; Terra used low
reasoning and 8,192. Requests used explicit cold-cache mode and measured zero
cache reads or writes. Each arm used independent model calls. Order rotated
cascade/Terra/Luna, Terra/Luna/cascade, and Luna/cascade/Terra across repetitions.

A cascade stops when Luna passes the public verifier. Otherwise it asks Terra
for a fresh repair against the original input, without the rejected proposal or
failure feedback. Final grading starts only after all inference completes.
Workflow timing includes model calls, accounting and public verification;
initial runtime admission and final grading are outside that measurement.

## Runtime qualification

The original test source runs in the cached Node 24 fixture with TAP 16 and
clone 2.1.2. The package requested TAP 20; this is an explicitly qualified
substitute environment, not a reproduction of its original dependency install.
The reference passes both views. The broken baseline fails with matching counts:
84,928 full assertions and 84,927 public assertions. Large stress loops contribute
many assertions; these counts do not represent distinct tasks.

One unchanged test group, containing one assertion, is withheld. The public
view contains almost the entire test suite. Passing the full view is therefore
limited preservation evidence, not proof of broad generalization or resistance
to training-data contamination.

The original package resolves through `wrapper.cjs`. The fixture admits this
one filename only through an explicit content hash and keeps the wrapper,
package-resolution metadata and tests protected from candidate mutation. It
does not make CommonJS wrappers editable. An earlier qualification stopped at
the staging validator before executing tests; the failed record was retained
and a separate run qualified the repaired staging path.

A second preselected task, [accepting infinite depth and breadth
limits](https://github.com/BridgeAR/safe-stable-stringify/commit/5e175e3f258e386839fd5017b484bc512c7eb0ac),
was excluded before inference. Its broken baseline executed 84,929 versus 84,935
full assertions, and 84,928 versus 84,934 public assertions. The exact-count gate
was retained. This exclusion limits the evaluated cohort.

## Decision

Before inference, the desired pilot signal required matching both controls on
final passes, at least one fallback rescue, lower cost than Terra and no slower
mean complete workflow. The cascade met the quality and cost conditions but
failed the time condition. The three draws on one task cannot qualify a serving
policy even if all conditions pass. No serving default or deployment changes.
