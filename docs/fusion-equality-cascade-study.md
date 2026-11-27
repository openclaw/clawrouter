# Fusion object-equality transfer check

A cheap-first cascade and independent Luna both passed three attempts on one
object-equality repair outside the earlier HTTP cohort. Direct Terra also
passed all three. The cascade cost 89.20% less than Terra and had a 10.43%
lower observed mean workflow time. No fallback ran: this result supports
cheap-model sufficiency on this task, not a quality gain from combining models.

## Results

| Strategy | Full passes | Successful fallbacks | Estimated API cost, USD | Mean workflow seconds |
| --- | ---: | ---: | ---: | ---: |
| Luna, fresh Terra on public failure | 3/3 | 0 | 0.001302 | 3.705 |
| Direct Terra | 3/3 | 0 | 0.012051 | 4.136 |
| Independent Luna-only | 3/3 | 0 | 0.001302 | 3.565 |

Nine workflows used nine calls, with zero observed public false accepts and
$0.014655 total estimated API cost. The cascade's mean was 431.4 ms lower than
Terra's but 139.9 ms higher than independent Luna's. Three draws of one task
cannot establish a dependable speedup, general accuracy or routing policy.

The frozen gate required three cascade full passes, no false accepts,
quality at least both controls, at least 20% lower API cost and no mean
workflow slowdown versus Terra. These point-estimate conditions passed.
They do not measure an additional benefit over cheap-only inference.

## Qualification and protocol

Two historical repairs from `epoberezkin/fast-deep-equal` were screened before
inference using their original Mocha runner and fixtures:

| Repair | Public / full tests | Original reference | Broken parent | Decision |
| --- | ---: | --- | --- | --- |
| [787ba533](https://github.com/epoberezkin/fast-deep-equal/commit/787ba533350fd0620e14845b35f013253cc48e44) | 52 / 53 | Pass both | Fail both | Include |
| [94007f33](https://github.com/epoberezkin/fast-deep-equal/commit/94007f33fe228385ba0d9c1299ac02166aeb3a6b) | 42 / 43 | Pass both | Pass both | Exclude |

The excluded repair had no discriminating test signal. It received no model
calls; no artificial failure was introduced to make it eligible. For each
fixture, one unchanged original case was withheld using a deterministic hash.
Duplicate cases retained separate occurrence identities. Partitioning inspected
syntax without evaluating fixture values on the host. Full grading included
the original preservation case; it was not a hidden bug-specific test.

Each arm received the same original editable source and public tests.
Arm order rotated across three independent draws. Luna used low reasoning
and a 4,096-token output ceiling; Terra used low reasoning and 8,192 tokens.
The predeclared fallback was a fresh Terra call with the original context,
without the rejected draft or diagnostics. Full grading ran after all calls.
Native Mocha execution required exact test counts and no pending-test credit.

Workflow timing includes request setup, inference, accounting, fresh fixture
preparation, public verification and cleanup. It excludes initial runtime
admission and final full grading. Requests had no reported cache reads or
writes. Frozen tariffs were $0.10 input / $0.50 output per million tokens for
`openai/gpt-6-luna`, and $1.00 / $5.00 for `openai/gpt-6.1-terra`.
Costs derive from recorded usage, not independently reconciled invoices.

## Evidence and implications

[Machine-readable results](fusion-equality-cascade-study.json) contain all nine
workflow rows, exact task revisions and private evidence hashes. Prompts,
completions and local paths are omitted. The private driver and raw receipts
limit independent reproduction. The study reused the existing cached tool
bundle and source corpus; it required no new model download or infrastructure.

This adds one task from one repository outside the HTTP cohort. Its historical
source may be present in model training data. It does not erase the earlier
[range study's](fusion-range-cost-study.md) latency failure or prove the
configured adviser/synthesizer product benefits from this external verifier.
Both models used the same provider; there is no OpenAI/Claude fusion claim.
No serving policy, default model or deployment changes accompany this report.
