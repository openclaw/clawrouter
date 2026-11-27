# Fusion HTTP cascade cost pilot

A cheap-first cascade matched direct Terra on nine repair attempts and used
61.01% less estimated API cost. One rejected Luna proposal needed a successful
Terra fallback. The observed mean workflow time was 75.7 ms lower, but this
small difference changes sign when either forwarded task is omitted. This is
a promising cost result, not evidence of a dependable speedup or a production
qualification.

## Results

| Strategy | Full passes | Successful fallbacks | Estimated API cost, USD | Mean workflow seconds |
| --- | ---: | ---: | ---: | ---: |
| Luna, fresh Terra on public failure | 9/9 | 1 | 0.032915 | 5.122 |
| Direct Terra | 9/9 | 0 | 0.084428 | 5.197 |
| Independent Luna-only | 8/9 | 0 | 0.008924 | 4.415 |

There were zero observed public false accepts. Twenty-seven workflows used
28 model calls, costing $0.126267 at the frozen tariffs. Eight cascade
attempts succeeded with the initial cheap model alone. The remaining attempt
failed public verification and passed full grading after a fresh Terra call.
The independent cheap control passed that task 2/3 times; separate draws do
not isolate a causal improvement from orchestration alone.

The frozen gate required all nine cascade attempts to pass, no false accepts,
quality at least both controls, at least 20% lower estimated API cost and no
increase in mean complete workflow time. These point-estimate conditions
passed. They do not establish population accuracy or latency guarantees.

## Latency sensitivity

The aggregate mean was 1.46% lower than direct Terra. Omitting the first
forwarded task makes the cascade 0.76% slower; omitting the second makes it
11.48% slower. Omitting negotiator makes it 18.75% faster. These are descriptive
leave-one-task-out calculations, not a confidence interval.

Negotiator, where the fallback rescue occurred, averaged 7.973 seconds for
the cascade versus 6.495 seconds for Terra. The cost advantage persisted
when each task was omitted, ranging from 58.76% to 88.27%, but all observations
come from this small, related cohort.

The earlier [numeric-range study](fusion-range-cost-study.md) found lower cost
with an 18.29% slowdown. This pilot adds evidence; it does not replace that
negative latency result or establish a general no-slowdown policy.

## Cohort and protocol

The three repairs were selected and qualified before their model responses.
Other candidates that lacked a discriminating reference/parent test were not
substituted using inference outcomes. Each task had three independent draws
per arm, with arm order rotating across repetitions.

| Task reference | Public / full active tests | Cascade / Terra / Luna full passes |
| --- | ---: | ---: |
| [forwarded 63a16a6](https://github.com/jshttp/forwarded/commit/63a16a6e3f0f587dbc5f9eb5a584b19524af3c11) | 8 / 9 | 3 / 3 / 3 |
| [forwarded 0c489a1](https://github.com/jshttp/forwarded/commit/0c489a12de97f110f8f3775dba1d4af2eadb9f9c) | 4 / 5 | 3 / 3 / 3 |
| [negotiator 0484c74](https://github.com/jshttp/negotiator/commit/0484c749083b90b034ef5d0eefce8d4504c3acc9) | 241 / 245 | 3 / 3 / 2 |

Forwarded used the qualified native Node adapter. Negotiator retained its
original Mocha tests, hooks and helper functions under pinned Mocha 11.7.5.
Its three originally disabled tests remained disabled, were checked against
a frozen pending-test inventory, and received no pass credit. Additional or
missing pending tests reject the run. One unchanged active leaf per test file
was withheld from public verification. Before inference, the reference
passed and the broken parent failed both views at the exact active counts.

Every arm received identical original editable source, public tests and
read-only support source. Luna used low reasoning with a 4,096-token output
ceiling; Terra used low reasoning with 8,192. A public rejection triggered one
fresh Terra request with the original input, without the rejected proposal
or error feedback. Full grading occurred only after all model calls.
Requests used cold-cache accounting with no reported cache reads or writes.

Complete workflow time includes request setup, inference, accounting, fresh
fixture preparation, public verification and cleanup. It excludes initial
runtime admission and final full grading. Each attempted model call used its
own fixture; the timing does not credit hypothetical cancellation or shared
preparation savings.

## Evidence and limits

[Machine-readable results](fusion-http-cascade-study.json) include all 27
workflow rows, 28 stage summaries, task revisions, sensitivity calculations
and hashes of the private protocol, result and audit. They omit prompts,
completions and local paths. Raw receipts and the experimental driver remain
private, limiting external reproduction.

The frozen tariffs were $0.10 input / $0.50 output per million tokens for
`openai/gpt-6-luna`, and $1.00 / $5.00 for `openai/gpt-6.1-terra`. Estimates use
recorded usage, not independently reconciled invoices. Both models used the
same provider; this does not demonstrate OpenAI/Claude or cross-provider
fusion.

Three historical tasks represent two related repositories. Repetitions are
not independent tasks, and training contamination is unknown. Further
independent confirmation is needed before choosing a serving policy. No
runtime policy, serving default or deployment changes accompany this report.
