# Fusion numeric-range cost study

A cheap-first cascade matched direct Terra on 15 repair attempts and used
58.49% less estimated API cost. Four rejected Luna proposals needed successful
Terra fallbacks. Mean complete workflow time increased 18.29%, failing the
frozen no-slowdown gate. This is evidence of a cost tradeoff on a small cohort,
not qualification for a production default.

## Results

| Strategy | Full passes | Successful fallbacks | Estimated API cost, USD | Mean workflow seconds | Mean summed API seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Luna, fresh Terra on public failure | 15/15 | 4 | 0.029450 | 7.855 | 5.017 |
| Direct Terra | 15/15 | 0 | 0.070955 | 6.640 | 4.547 |
| Independent Luna-only | 12/15 | 0 | 0.007644 | 5.228 | 3.178 |

There were zero observed public false accepts. Forty-five workflows used 49
model calls, costing $0.108049 at the frozen tariffs. One fallback rescued the
mixed-invalid-ranges task; three rescued number parsing. The independent cheap
control passed those tasks 2/3 and 1/3 times respectively. Independent draws
differ, so those counts do not establish a causal accuracy improvement from
orchestration alone.

Even eliminating all non-API overhead leaves the cascade's measured summed
API time 470 ms above direct Terra. Fixture preparation alone cannot establish
latency parity from these measurements. This is a descriptive calculation,
not a prediction of a future implementation's timings.

## Cohort and protocol

Four numerical-range candidates were acquired and qualified before model
outcomes. The fifth task was the sole qualified candidate from a separate HTTP
utility screen and had already been exposed in earlier experiments. Excluded
candidates were not replaced using inference results. Each task had three
independent draws per arm, with arm order rotating across repetitions.

| Task reference | Repair | Public / full leaf tests | Cascade / Terra / Luna full passes |
| --- | --- | ---: | ---: |
| [range-parser f4bf173](https://github.com/jshttp/range-parser/commit/f4bf1736f28a3e574430408c18779cf7fbaf3770) | Clamp oversized suffix | 35 / 36 | 3 / 3 / 3 |
| [range-parser b49e00f](https://github.com/jshttp/range-parser/commit/b49e00f6d3c51f3a417fe8da5ed63c0af7621450) | Retain valid ranges alongside invalid ones | 33 / 34 | 3 / 3 / 2 |
| [range-parser eba9c7a](https://github.com/jshttp/range-parser/commit/eba9c7a9cb0fa60d299b392d459fa56d6a21ce80) | Improve number parsing | 24 / 25 | 3 / 3 / 1 |
| [range-parser 269cb4e](https://github.com/jshttp/range-parser/commit/269cb4eafa9101a89fbb52d5b6d7af637ad8b684) | Handle invalid byte positions | 17 / 18 | 3 / 3 / 3 |
| [fresh ee73673](https://github.com/jshttp/fresh/commit/ee7367318cf86a77e8259c63ee014ff0f8853437) | Allow horizontal-tab whitespace | 23 / 24 | 3 / 3 / 3 |

Original tests ran through explicit native Node adapters. One unchanged static
leaf per test file was withheld from public verification. Before inference,
each reference passed and each parent failed both public and full grading at
the exact expected leaf counts. The range adapter preserved repeated test
titles using their occurrence within the full suite path; it relocated the
pinned `deep-equal` test dependency into a protected fixture.

Every arm received the same original editable source and public tests, with
original-source anchored edits. Luna used low reasoning and a 4,096-token
output ceiling; Terra used low reasoning and 8,192. A public rejection triggered
one fresh Terra request with the original input, without the rejected proposal
or error feedback. Full grading happened after all model calls. Requests used
cold-cache accounting with no reported cache reads or writes.

Every arm prepared a fresh native fixture on demand. Complete workflow time
includes request setup, inference, accounting, fixture preparation, public
verification and cleanup; it excludes initial runtime admission and final full
grading. The gate required all cascade attempts to pass, zero false accepts,
quality at least both controls, at least 20% lower estimated API cost and no
increase in mean complete workflow time. Only the latency condition failed.

## Evidence and limits

[Machine-readable results](fusion-range-cost-study.json) include all 45 workflow
rows, their 49 stage summaries, exact source revisions and SHA-256 hashes of the
private protocol, result and audit. They omit prompts, completions and local
paths. Raw receipts and the experimental driver remain private, limiting
external reproduction.

The frozen tariffs were $0.10 input / $0.50 output per million tokens for
`openai/gpt-6-luna`, and $1.00 / $5.00 for `openai/gpt-6.1-terra`. Cost estimates
use recorded usage, not independently reconciled invoices. Both models used
the same provider; this does not demonstrate cross-provider fusion.

Five tasks represent only two repositories, with four correlated range-parser
repairs. Repetitions are not independent tasks; training contamination is
unknown. These results provide no population confidence bound or evidence of
general workload superiority. Unlike the earlier
[preparation pilot](fusion-preparation-pilot.md), this cohort exercised real
fallback rescues, but it still fails the complete cost-and-latency objective.
No runtime policy, serving default or deployment changes accompany this report.
