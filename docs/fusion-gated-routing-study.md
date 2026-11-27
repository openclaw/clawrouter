# Cheap-first routing with matched compact controls

Two development studies reduced estimated model cost but failed their declared
no-slowdown gate. Neither establishes a production Fusion gain. The important
comparison is against a compact strong-model call as well as a full-context one.

The [measurement rows](fusion-gated-routing-study.json) contain all 36 model calls,
grades, costs, workflow times, recorded call times, artifact hashes, and protocol
and audit hashes. The studies cost **$0.933351** in estimated API charges.
Measurements were collected on November 27, 2026.

## Three-task comparison

A gate developed on earlier pool, cache, and TLS repairs was tested on three
different task identities: HTTP/1 socket errors, falsy fetch abort reasons, and
SOCKS IPv6 hosts. These tasks were held out from developing that gate; exposure
elsewhere in the wider campaign remains unassessed.

The policy first calls compact Luna for a task with one editable file. A rejected
answer triggers full-context Terra. Tasks with multiple editable files go
directly to full-context Terra. Independent full-context and compact Terra
controls receive the same task, output schema, and minimal-edit instructions.

Each task has three repetitions with balanced strategy ordering. Full-suite
grading follows all inference. Public verification alone controls fallback;
held-out failures cannot trigger replacement answers.

| Strategy | Full-suite passes | Estimated model cost | Total workflow time |
| --- | ---: | ---: | ---: |
| Gated cheap-first | 9/9 | $0.153895 | 80.960 s |
| Full-context Terra | 9/9 | $0.438315 | 87.015 s |
| Compact Terra | 9/9 | $0.241583 | 74.992 s |

The policy is **64.89% cheaper and 6.96% faster** than full-context Terra, but
**36.30% cheaper and 7.96% slower** than compact Terra. All six Luna calls pass;
the three multi-file policy calls use Terra directly. There are no fallback
calls, mixed-model rescues, or quality improvements in this study.

The predeclared gate requires every policy and control answer to pass, at least
30% lower cost, and no increase in total workflow time against **both** controls.
It fails against the compact control. Savings against full context alone do not
qualify the policy.

The SOCKS suites retain one existing upstream skip: 38 active public tests and
41 active full tests, reported as 39 and 42 total respectively. No new skip was
introduced. The other tasks have zero skips.

## Separate FormData follow-up

One additional single-file repair qualifies from a fixed three-candidate screen.
The pipeline candidate fails through a timeout rather than the screen's required
assertion failure. The interceptor-ordering candidate exceeds the existing
four-editable-file limit. Both exclusions are retained.

The admitted repair preserves empty strings when inspecting repeated FormData
fields. Its reference passes 30 full and 27 public tests; the broken baseline
fails one assertion at matching counts. Three fresh repetitions compare the
same policy and controls, with no fallbacks or skipped tests.

| Strategy | Full-suite passes | Estimated model cost | Total workflow time |
| --- | ---: | ---: | ---: |
| Gated cheap-first | 3/3 | $0.002174 | 15.585 s |
| Full-context Terra | 3/3 | $0.076455 | 13.840 s |
| Compact Terra | 3/3 | $0.020929 | 11.771 s |

The policy is **89.61% cheaper and 32.40% slower** than compact Terra. It fails
both no-slowdown comparisons. This is one task repeated three times, not three
independent tasks.

The private runner also supports an optional compact-context bypass for
multi-file tasks. This single-file follow-up does not exercise that branch and
provides no validation of it.

## Timing and uncertainty

`summarizeSequentialTiming` now accepts explicit strategy names and repetitions.
It requires every declared task/repetition/strategy exactly once, retains every
call, and keeps the unique-task count separate from repetitions. Its default
single-run, three-strategy behavior is unchanged.

| Study and strategy | Recorded model-call time | Other workflow time |
| --- | ---: | ---: |
| Three-task policy | 57.292 s | 23.668 s |
| Three-task compact control | 51.232 s | 23.760 s |
| FormData policy | 6.691 s | 8.894 s |
| FormData compact control | 6.126 s | 5.644 s |

Other workflow time includes verification, setup, and I/O. It is neither CPU
time nor an infrastructure bill. Model latency and other workflow time both
contribute to the observed slowdown. Full-suite grading occurs afterward and
is outside the measured workflow. Outliers are retained.

The existing paired case bootstrap averages repetitions within each task. For
the three-task policy versus compact Terra, its descriptive 95% cost-ratio
interval is **0.100–1.894**, and its time-ratio interval is **0.668–1.265**.
These wide intervals assume independently sampled tasks, which this selected
single-repository study does not establish. The repository-cluster analysis has
only one cluster and returns no interval. The one-task FormData study cannot
estimate between-task uncertainty either. Equal observed success counts do not
establish general quality parity.

## Decision

Keep both results as failed development candidates under their original gates.
Do not promote a generic cheap-first default or claim an OpenAI-plus-Claude
advantage: all calls here used OpenAI models. The next efficacy comparison needs
a fixed representative cohort that exercises actual fallback and the compact
bypass, with independently sampled controls and the original broader target of
30 unseen practical tasks, three repetitions, and uncertainty estimates.

The published rows support recomputing this report. They omit raw prompts,
completions, private paths, and credentials. API cost excludes local verification,
engineering time, and subscription charges. Production configuration and
deployment are unchanged.
