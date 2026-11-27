# Redaction repair transfer check

The [one-task WebSocket cost saving](fusion-websocket-cost-pilot.md) did not
transfer to this three-task study. The cascade cost more and took longer than
both Terra controls. Keep the policy experimental.

## Results

| Strategy | Final passes | Estimated API cost, total USD | Mean workflow seconds |
| --- | ---: | ---: | ---: |
| Compact Luna, full Terra on public failure | 4/9 | 0.255409 | 17.908 |
| Full-context Terra | 3/9 | 0.233401 | 10.580 |
| Compact Terra | 3/9 | 0.200847 | 13.252 |

The cascade cost 9.43% more than full Terra and
27.17% more than compact Terra. Mean workflow time was
69.27% and
35.14% higher, respectively.

All nine initial Luna attempts failed public verification, so every cascade
called Terra. Four fallback attempts passed final grading. There were no false
accepts. The one extra success relative to each independently sampled Terra
control does not establish complementary capabilities: the task count is small
and the Terra responses are different draws.

[All 27 workflow records and 36 model calls](fusion-redaction-cost-pilot.json)
are included. Total estimated API cost was $0.689657, derived from token usage
and frozen tariffs rather than an independently reconciled invoice.

## Tasks and qualification

Three historical fixes from the same dependency-free library were fixed before
model execution:

- [Pass through strings at wildcard keys](https://github.com/davidmarkclements/fast-redact/commit/3e93d32777d2a59eaf5e05e6c463201a5f4f8a2c).
- [Restore using the latest stored values](https://github.com/davidmarkclements/fast-redact/commit/f3e9f13b26a8b1bfa57e344a21d1f79fa575d708).
- [Remove obsolete wildcard references](https://github.com/davidmarkclements/fast-redact/commit/59b84b2fa2be57b66a7679cdbd696e58e4eaba5e).

Each original fix passed its full and public tests. The first qualification rule
required the broken baseline and reference to execute the same assertion count;
all three failed that rule. The broken revisions threw within changed regression
tests, before later assertions in those groups could run.

A separate admission assessment retained that failed result. It required every
test group to remain present in the same order, successful groups to retain their
counts, and any count reduction to occur only inside a failed group whose source
changed upstream. Prior test source was checked against Git blob identities at
the fixed base revisions. No tests were changed for this reassessment.

Candidate acceptance retained the full passing reference counts: 434, 423 and
417 assertions, respectively. Their public subsets required 424, 417 and 414.
One unchanged test group per task was withheld, and final grading ran only after
all model calls. No candidate accepted by the public verifier failed final grading.

## Comparison and limits

Three repetitions per task alternated cascade/full/compact, full/compact/cascade,
and compact/cascade/full order. Every arm used literal source and the same
public tests. Full Terra additionally received original read-only dependencies.
Luna used low reasoning and a 4,096-token output ceiling; Terra used low reasoning
and 8,192. Cold-cache requests and exact anchored edits were used throughout.
The fallback started from original source without the rejected draft or its
failure diagnostic.

Workflow time includes API calls, accounting and public tests; it excludes
initial runtime admission and final grading. Existing cached Node 24 and TAP
fixtures ran without runtime network access.

Three related historical tasks are not independent evidence of production
reliability or training-data decontamination. These results reject a broad
cost-saving claim for the tested fresh-fallback policy. They motivate testing
whether public failure feedback helps a cheap repair step, with a fresh retry
control to distinguish that effect from another sample.

## Cheap feedback A/B

A separate development-only comparison took all nine rejected initial Luna
attempts. Each received a new paired Luna draw with either the original prompt
or that prompt plus the rejected proposal and first public test diagnostic.
Order alternated by task and repetition. No final-test feedback or reference
implementation entered either prompt.

| New Luna attempt | Final passes | Valid edit artifacts | Estimated API cost, total USD |
| --- | ---: | ---: | ---: |
| Public failure feedback and rejected proposal | 3/9 | 8/9 | 0.021603 |
| Fresh retry | 0/9 | 9/9 | 0.021612 |

All three successes occurred on the wildcard-string task. Both variants failed
every repetition of the other two tasks. This supports testing a cheap feedback
step before escalating that failure class, but does not establish a general
quality gain or a production policy. The original cascade results above remain
unchanged.

[All 18 A/B records](fusion-redaction-feedback-study.json) include API times.
Those times exclude verification and are not an end-to-end workflow comparison.
All model calls finished before final grading. Total estimated API cost was
$0.043215. These are already exposed tasks, not held-out evidence.
