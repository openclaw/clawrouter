# Parser repair feedback pilot

A cheap repair step did not improve this one-task cascade: it cost 22.33% more
than direct Terra and took over twice as long. Two follow-up comparisons found
one useful development signal: precise original-source feedback recovered one
rejected edit. These results do not qualify a production routing policy.

[All 39 calls across three studies](fusion-parser-feedback-pilot.json) are
summarized with per-attempt costs, timings, acceptance and evidence hashes.
Total estimated API cost was $0.127440. Costs use observed token usage and frozen
study tariffs, not an independently reconciled invoice.

## Prospective policy comparison

| Policy | Final passes | Cheap repair passes | Total estimated USD | Mean workflow seconds |
| --- | ---: | ---: | ---: | ---: |
| Luna, feedback repair, fresh Terra on failure | 3/3 | 0/3 | 0.038797 | 31.759 |
| Luna, fresh Luna retry, fresh Terra on failure | 3/3 | 0/3 | 0.037482 | 30.028 |
| Direct Terra | 3/3 | — | 0.031714 | 14.142 |

All six initial Luna attempts and all six subsequent Luna attempts failed
public acceptance. Both cascades always escalated; all nine Terra calls passed
final grading. No public acceptance failed final grading. This is a negative
result for both tested cascades, not evidence that combining models helped.

Three repetitions rotated policy order. All arms received the same literal
original source and public tests. Repair feedback included the rejected proposal
and the first public failure label when a valid runtime result existed. Three
initial attempts across both cascades had invalid edit artifacts. One belonged
to the feedback arm and therefore received a fresh retry; its other two initial
attempts produced valid artifacts and received failure feedback. Terra always started from original source without the
rejected draft. Final grading followed all model calls.

The initial feedback extractor omitted the structured error retained by the
native reporter and supplied only the first failure label. This limitation
motivated a separate comparison; the original result above remains unchanged.

Workflow time includes model calls, accounting and public verification. It
excludes initial runtime admission and final grading.

## Conditional runtime diagnostic comparison

All three initial Luna attempts with valid artifacts but failing public tests
received three new Luna draws. The other three initial attempts had invalid
artifacts and were excluded. Arm order rotated across the selected attempts.

| Feedback | Final passes | Valid artifacts | Total estimated USD | Mean API seconds |
| --- | ---: | ---: | ---: | ---: |
| First failure label | 1/3 | 3/3 | 0.003318 | 6.504 |
| Label and retained error | 0/3 | 2/3 | 0.003239 | 5.656 |
| Retained error and all failed labels | 1/3 | 2/3 | 0.003112 | 4.738 |

Richer diagnostics did not outperform the first-label control in this small
sample. These are conditional, already-exposed attempts; the API times exclude
verification and cannot be compared as complete workflow times.

## Conditional source-anchor comparison

The other three initial attempts failed exact source-anchor validation. Each
received three new Luna draws, with rotated arm order. The precise feedback
identified the failing edit, its stated line, the number of exact matches and a
bounded excerpt of original source. It did not supply reference code, guess a
replacement or weaken acceptance.

| Input | Final passes | Valid artifacts | Total estimated USD | Mean API seconds |
| --- | ---: | ---: | ---: | ---: |
| Fresh retry | 0/3 | 1/3 | 0.003008 | 6.050 |
| Rejected proposal and generic edit error | 0/3 | 3/3 | 0.003516 | 7.285 |
| Rejected proposal and precise source context | 1/3 | 3/3 | 0.003254 | 6.152 |

Both feedback variants improved artifact validity over the fresh draws. Only
one precise-context draw passed the public and final tests. This is a mechanism
worth testing on unseen tasks, not a demonstrated quality or cost gain. No
public acceptance failed final grading. All nine calls completed before grading.

## Task and runtime qualification

The task reconstructs the historical [RFC 9110 media-type parser
fix](https://github.com/fastify/fast-content-type-parse/commit/3bd7cfe2bf1efcd4a466270878e05c22ff685706)
from its parent revision. The public view contains the parse API group; the full
view also includes safeParse. Both groups share input tables. This tests transfer
across APIs within one task, not unseen requirements or independent tasks.

The qualified Node 24 fixture requires 48 public and 96 full leaf-test results.
The reference passes both; the broken baseline fails both with the same leaf
counts. Candidate acceptance requires a valid complete report, the exact count
and all tests passing. A trusted parent-process reporter converts Node test
events to TAP; candidate stdout cannot declare test verdicts.

Three earlier qualification failures remain in the development evidence: an
external TAP wrapper did not execute the intended Node tests; direct TAP parsing
stalled on Unicode line separators in test labels; and nested native failure
serialization was incompatible with the legacy TAP parser. The successful
fixture escapes labels and transports diagnostics as comments. It retains
strict count and completion checks rather than admitting those failed runs.
Existing cached runtimes and tools ran without sandbox network access.

Luna used low reasoning with a 4,096-token output ceiling; Terra used low
reasoning with 8,192. Cold-cache requests and exact anchored edits were used
throughout. Original-source anchor relocation was permitted only for a unique
exact search match, consistently across arms.

## Decision

Keep these policies experimental. A single historical task and repeated draws
cannot establish complementarity, latency reliability or decontamination. The
follow-ups deliberately reuse rejected attempts and are development evidence.
The next qualification must use unseen tasks with independent cheap-only and
strong-only controls, complete workflow timing and uncertainty across tasks.
This report changes no serving policy, model default or deployment.
