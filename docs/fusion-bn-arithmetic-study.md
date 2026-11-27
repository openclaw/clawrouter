# Fusion big-integer controller check

The verified-workflow cascade and direct Terra both passed six trials across
two 2026 big-integer repairs. Independent Luna passed four. The cascade cost
89.78% less than direct Terra and had a 10.01% lower observed mean workflow
time. No fallback ran: every cascade draft passed. This supports cheap-first
efficiency on this sample, not added quality from model collaboration.

## Results

| Strategy | Full passes | Successful fallbacks | Estimated API cost, USD | Mean workflow seconds |
| --- | ---: | ---: | ---: | ---: |
| Luna, fresh Terra on public failure | 6/6 | 0 | 0.029884 | 5.561 |
| Direct Terra | 6/6 | 0 | 0.292319 | 6.179 |
| Independent Luna-only | 4/6 | 0 | 0.029494 | 4.931 |

Eighteen workflows used eighteen calls, with zero observed public false accepts
and $0.351697 total estimated API cost. All nine trials on the complement
repair passed. On the rounding repair, cascade and direct Terra passed all
three trials; independent Luna passed one. The two cheap-arm failures are
separate samples. They were not rescued by the cascade.

The predeclared point-estimate gates passed: six cascade full passes, no false
accepts, quality at least both controls, at least 20% lower API cost, and no more
than 20% higher mean workflow time than direct Terra. Six draws across two
tasks cannot establish dependable accuracy, a speedup or routing thresholds.
The same cheap model passed all cascade draws and only four independent draws;
this variation is a reason to collect broader evidence, not to infer that the
controller improved a first-call answer.

## Qualification and protocol

Three recent public repairs from `indutny/bn.js` were selected before inference:

| Repair | Expected public / full tests | Reference | Parent | Decision |
| --- | ---: | --- | --- | --- |
| [Signed rounding](https://github.com/indutny/bn.js/commit/73fb9a428e8e10030f97e7cec042a9b931d88871) | 62 / 63 | Pass both | Fail both | Include |
| [Width-limited complement](https://github.com/indutny/bn.js/commit/dc3429f0868bed70f781c176959328bafbaf79d9) | 20 / 21 | Pass both | Fail both | Include |
| [Mask state](https://github.com/indutny/bn.js/commit/33df26b5771e824f303a79ec6407409376baa64b) | 19 / 20 | Pass both | Heap exhaustion | Exclude |

The excluded parent did not complete a valid native test run and received no
model calls. The first rounding qualification omitted an original fixture and
failed module loading. Only that candidate was requalified after adding the
unchanged original `test/fixtures.js`, verified against both parent and fixed
Git trees. Other completed qualification outcomes were retained.

Original Mocha files ran at their original paths in the existing isolated Node
runtime. The rounding file registers multiplication suites through a helper;
a narrow syntax-only expansion counted those registrations without executing
source on the host. Their shared test bodies were ineligible as holdouts. One
unchanged direct test was withheld from each public view and restored for
final grading. This is preservation coverage, not a hidden regression test.
The selected arithmetic and binary test files are not the full package suite.

Each arm received the same original editable source and public tests. Order
rotated across three independent draws per task. Luna used low reasoning and
a 4,096-token output ceiling; Terra used low reasoning and 8,192 tokens. The
real `runVerifiedWorkflow` controller used fresh-fallback mode, which would
supply the original context without a rejected draft or diagnostics. Native
suite success was the acceptance gate; no separate compiler result is claimed.
Full grading ran after all calls.

Workflow time includes request setup, inference, accounting, fixture preparation,
public verification and cleanup. It excludes initial runtime admission and final
full grading. Requests reported no cache reads or writes. Frozen tariffs were
$0.10 input / $0.50 output per million tokens for `openai/gpt-6-luna`, and
$1.00 / $5.00 for `openai/gpt-6.1-terra`. Costs use recorded token usage,
not independently reconciled invoices.

## Evidence and limits

[Machine-readable results](fusion-bn-arithmetic-study.json) include all eighteen
workflow rows, per-task results, qualification decisions and evidence hashes.
Prompts, completions and local paths are omitted. Private drivers and raw
receipts limit independent reproduction. The study reused the cached Node
image and Mocha bundle, with no new infrastructure or model download.

These two public 2026 repairs add a larger arithmetic-library context outside
the earlier HTTP, equality and byte-format samples. They may still appear in
training data. Both models used the same provider. No serving policy, default
model or deployment changed. Production qualification still requires broader
held-out tasks, a reliable verifier and acceptable latency distributions.
