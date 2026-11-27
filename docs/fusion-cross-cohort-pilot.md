# Twelve-task Fusion routing pilot

The cascade matched the strong control on **12/12 repairs**, while cheap alone
passed **6/12**. It cost **19.51% less** and took **14.06% more workflow time**.
There were no public-test false accepts or lost strong-control successes.
The pilot **failed its predeclared 20% cost-saving gate**. This is a near miss,
not a qualified routing lead or production result.

## Results

| Strategy | Held-out passes | Model cost (USD) | Summed workflow time |
| --- | ---: | ---: | ---: |
| Strong with one repair | 12/12 | 0.140856 | 211.62 s |
| Routed cascade | 12/12 | 0.113377 | 241.36 s |
| Cheap with one repair | 6/12 | 0.018630 | 179.37 s |

The cascade used a cheap draft and one cheap repair on six admitted tasks.
A rejected cheap result triggered a fresh strong fallback and, if needed,
one strong repair. The other six tasks went directly to strong. Both controls
had at most two attempts. Four admitted tasks needed strong fallback.

This used the public caller-side `draftAttempts: 2` behavior, GPT-6 Luna for
cheap attempts and GPT-6.1 Terra for strong attempts. All arms received the
same initial source, public tests and imported context. Repairs could see only
their own rejected candidate and public feedback. Full tests remained private
until all generation finished.

The fixed gate required cascade quality at least strong and above cheap,
zero false accepts and strong losses, at least 20% lower invoice **and**
cache-neutral model cost, and at most 20% greater summed workflow time.
The invoice ratio was 0.804914; the cache-neutral ratio was 0.804936.
Both missed 0.8. The time ratio was 1.140563, which passed.
Workflow time includes generation and public verification; the later held-out
grading pass is excluded from both strategies.

## Cohort and execution

All eligible repairs from two completed model-free screens were combined:
six from a 14-case screen, five from an 18-case historical screen, and one
separately qualified garbage-collection fixture. Both screens missed their
original target of twelve eligible tasks; those failures remain part of the
record. Every eligible case was retained, with no selection by model outcome.
The resulting cohort contains twelve distinct repairs across ten source files
in the public [Undici repository](https://github.com/nodejs/undici).

Each reference had to pass original public and full tests with no skips,
while the corresponding baseline failed those checks with matching test counts.
Compiler checks also passed. The GC fixture explicitly enabled Node's
`--expose-gc` for both public verification and full grading. No tests were
replaced to obtain a pass.

All twelve tasks were inference-unexposed at the first freeze, but their
historical repairs are public and may occur in model training data. This is
not a contamination-proof benchmark or cross-repository confirmation.
Related source files are not independent samples.

The protocol allowed at most 84 calls with a USD 10 stage cap. Actual execution
used 52 calls and USD 0.272863, including all three arms. Cumulative campaign
spend became USD 318.431732 of the USD 400 budget. Cached dependencies and the
existing runtime were reused; no additional model download, GPU or machine
was allocated for this pilot.

## Evidence and limits

Per-task outcomes, public Git revisions, admission decisions, costs, timings
and protocol/result digests are in
[`fusion-cross-cohort-pilot.json`](fusion-cross-cohort-pilot.json).
The JSON preserves all 36 outcomes, including cheap failures. It contains no
raw prompts, completions or private runtime paths.

The terminal replay audit reproduced all 36 outcomes and reconciled every
charge. Its digest is included in the JSON. No deployment or default-policy change
is justified by this result. Any later policy change or run on these tasks is
development on exposed tasks and must be reported separately.
