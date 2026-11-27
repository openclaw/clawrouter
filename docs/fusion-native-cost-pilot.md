# Native Node repair cost pilots

These two pilots show different outcomes. The warning repair needed two
strong-model rescues and saved model cost at a latency penalty. The Pino repair was solved by all three arms in all three repetitions. The
independent cheap model already matched the strong model; no cascade attempt
needed a fallback. This supports testing cheap-first routing on this task,
without evidence of a collaboration advantage.

## Pino error serialization

| Strategy | Final passes | Fallback rescues | Estimated API cost, USD | Mean workflow seconds |
| --- | ---: | ---: | ---: | ---: |
| Luna, fresh Terra on public failure | 3/3 | 0 | 0.001337 | 4.127 |
| Direct Terra | 3/3 | 0 | 0.012477 | 5.226 |
| Independent Luna-only | 3/3 | 0 | 0.001360 | 3.559 |

Nine calls cost an estimated $0.015174. Independent Luna used 89.10% less than
Terra and its mean workflow was 31.89% faster. With only three draws on one
historical task, these are descriptive sample differences, not qualified
population savings or latency guarantees. No public acceptance failed final
grading.

The task reconstructs the [non-enumerable raw error
fix](https://github.com/pinojs/pino-std-serializers/commit/a8f47a7dbf5ea8cf517d44d65fc74104c917193d)
from its parent. The unchanged original Node test file contains 20 leaf test
groups. One unchanged group is withheld, leaving 19 public groups. The original
fix passes both views and the broken parent fails with the same counts.

## Warning emission state and spy API

The cascade and strong-only arms both passed final grading 3/3; independent
Luna passed 2/3. Two rejected Luna proposals were rescued by fresh Terra calls.
The cascade cost 26.34% less than Terra alone, but its mean workflow was
27.61% slower. This is a real cost/quality trade-off in one repair, and it
fails the desired no-slowdown condition.

| Strategy | Final passes | Fallback rescues | Estimated API cost, USD | Mean workflow seconds |
| --- | ---: | ---: | ---: | ---: |
| Luna, fresh Terra on public failure | 3/3 | 2 | 0.016520 | 16.615 |
| Direct Terra | 3/3 | 0 | 0.022427 | 13.021 |
| Independent Luna-only | 2/3 | 0 | 0.002408 | 9.176 |

Eleven calls cost an estimated $0.041355. No public acceptance failed final
grading. Cascade initials and the independent cheap controls are different
draws; 3/3 versus 2/3 does not establish a population accuracy improvement.

The task reconstructs the [warning state and spy
API change](https://github.com/fastify/process-warning/commit/11c73b622aa29fc427d85476edb29d64687bcd87).
Four original unit test files and their unchanged promise helper run without
new packages. Reference and baseline execute six full or five public leaf test
groups: the reference passes and the baseline fails. One new spy API group is
withheld by the fixed-hash rule. This is a new-behavior holdout, not an unchanged
regression holdout; related requirements remain public. The fixture excludes
the project's other unit files, Jest, TypeScript and coverage checks.

## Shared controls

Each study rotates arm order across three repetitions and uses independent
model calls. Luna uses low reasoning and a 4,096-token output ceiling; Terra
uses low reasoning and 8,192. Both see the same original editable source and
public tests, with literal source presentation and anchored edits. Unique
exact-source relocation is allowed consistently. No reference patch or
withheld test body enters the request.

A cascade stops on a passing public verifier; otherwise Terra receives the
original request without the rejected proposal or failure feedback. All
inference completes before final grading. Explicit cold-cache requests report
zero cache-read or cache-write tokens. Workflow time includes model calls,
accounting and public verification, excluding initial runtime admission and
final grading.

Original tests run with the cached Node 24 image and a trusted parent-process
Node event reporter. Tests and helpers are protected from candidate mutation;
no runtime network or new dependency install is used. Reported counts are leaf
Node tests, not every assertion executed inside each test.

[Per-call costs, timings and acceptance records](fusion-native-cost-pilot.json)
are derived from frozen private experiment records. Costs use observed token
usage and frozen tariffs, not an independently reconciled invoice. Evidence
hashes identify those private records; unpublished raw artifacts limit external
reproduction. Historical public source may be present in training data.

No serving default or deployment changes. These pilots do not meet the larger
30-unseen-task, three-repetition qualification target.
