# Fusion byte-formatting controller check

The real verified-workflow cascade passed all six trials across two byte
parsing/formatting repairs. Direct Terra also passed six; independent Luna
passed four. One rejected cascade draft was rescued by a fresh Terra call.
The cascade cost 71.24% less than direct Terra but took 8.39% longer on
observed mean workflow time. This is a small cost/quality result with a latency
tradeoff, not production qualification.

## Results

| Strategy | Full passes | Successful fallbacks | Estimated API cost, USD | Mean workflow seconds |
| --- | ---: | ---: | ---: | ---: |
| Luna, fresh Terra on public failure | 6/6 | 1 | 0.010151 | 5.191 |
| Direct Terra | 6/6 | 0 | 0.035299 | 4.789 |
| Independent Luna-only | 4/6 | 0 | 0.003613 | 3.575 |

Eighteen workflows used nineteen calls, with zero observed public false
accepts and $0.049063 total estimated API cost. All nine trials on the
unparsable-input repair passed. On the fractional-separator repair, cascade
and direct Terra each passed three trials; independent Luna passed one.
One of the three cascade trials needed fallback. Failures in the independent
cheap arm are separate samples, not additional cascade rescues.

The predeclared cost/quality conditions passed: six cascade full passes,
no false accepts, quality at least both controls, and at least 20% less
API cost than direct Terra. Latency was reported separately with no speed
acceptance condition. The observed slowdown matters for interactive use.
The sample is too small to estimate dependable failure rates or latency tails.

## Qualification and protocol

Two historical repairs from `visionmedia/bytes.js` were fixed before inference:

| Repair | Public / full tests | Reference | Parent |
| --- | ---: | --- | --- |
| [Unparsable input](https://github.com/visionmedia/bytes.js/commit/581b2b5b96d10fe75bda7ae03ee6afab64b6abcb) | 29 / 30 | Pass both | Fail both |
| [Fractional separator](https://github.com/visionmedia/bytes.js/commit/db70acb42f59ef8b1407d9efeac1ee3b4394e3ef) | 29 / 30 | Pass both | Fail both |

The original Mocha tests ran at their original paths in the existing isolated
Node runtime. One deterministic, unchanged test was withheld from each public
view; full grading restored it. This is preservation coverage, not a hidden
bug-specific test. Public context includes the original regression tests.
No tests were rewritten to make a parent fail, and no pending tests earned credit.

Each arm received identical original editable source and public tests.
Order rotated across three independent draws per task. Luna used low reasoning
and a 4,096-token output ceiling; Terra used low reasoning and 8,192 tokens.
The cascade called the shipped `runVerifiedWorkflow` controller through the
native-suite bridge, with fresh fallback receiving the original context and
no rejected draft or diagnostics. Native test success was the acceptance gate;
no separate compiler evidence is claimed. Full grading ran after all calls.

Workflow time includes request setup, inference, accounting, fixture preparation,
public verification and cleanup. It excludes initial runtime admission and
final full grading. Requests reported no cache reads or writes. Frozen tariffs
were $0.10 input / $0.50 output per million tokens for `openai/gpt-6-luna`,
and $1.00 / $5.00 for `openai/gpt-6.1-terra`. Costs use recorded token usage,
not independently reconciled invoices.

## Evidence and limits

[Machine-readable results](fusion-byte-format-study.json) contain all eighteen
workflow rows, per-task results, source revisions and private evidence hashes.
Prompts, completions and local paths are omitted. Private drivers and raw
receipts limit independent reproduction. The study reused the cached Node
image and Mocha bundle; it needed no new infrastructure or model downloads.

These are two old tasks from one repository, outside the earlier HTTP and
equality samples. They may be present in training data. The direct fallback
rescue shows that verification recovered one failed draft in this run; it
does not establish broad superiority, cross-provider fusion, or a learned
routing policy. Both models used the same provider. No serving defaults or
deployment changed. General product qualification still requires representative
workloads, larger held-out samples, and acceptable latency distributions.
