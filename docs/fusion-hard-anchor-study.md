# Exact-anchor recovery: thirty-task development repeat

All three batches passed saved-request, outcome, cost and isolated-runtime
replay audits. The live timings are preserved; replay timings are excluded.

The complete cohort **fails the declared development screen**. Cascade and
strong-only both solve **29/30** tasks; cheap-only solves **23/30**. Cascade
uses **41.65% less estimated model cost**, but takes **13.97% more workflow
time**. This does not establish a no-slower fusion gain.

| Accounting batch | Strong | Cascade | Cheap | Cascade cost / strong | Cascade time / strong |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 10/10 | 10/10 | 7/10 | 0.3029 | 0.9719 |
| 2 | 9/10 | 9/10 | 7/10 | 0.7255 | 1.1692 |
| 3 | 10/10 | 10/10 | 9/10 | 0.7695 | 1.2578 |
| Complete cohort | 29/30 | 29/30 | 23/30 | 0.5835 | 1.1397 |

There are no observed cascade false accepts or lost strong-only successes.
Thirteen cascade arms escalated to strong; twelve ultimately passed. The
independent cheap-only controls solve six fewer tasks overall. A successful
fallback count is not the quality difference against the cheap-only arm.

## Fixed comparison

This repeats all thirty previously exposed Undici tasks from the
[first-failure study](fusion-first-failure-transfer30.md), in the same three
fixed accounting batches. It uses new independent calls to
`openai/gpt-6-luna` and `openai/gpt-6.1-terra`.

The only decoder change enables existing unique exact-source relocation in
all three arms. If the proposed line number is wrong, the original search
text must occur exactly once at a line boundary in the frozen source. Search
and replacement text, source digests, path restrictions and overlap checks
remain unchanged. Ambiguous or fuzzy matches are rejected.

The cascade receives one cheap draft, then a fresh strong fallback and at most
one strong repair. Independent strong-only and cheap-only controls each get
at most two attempts. Prompts, hash-seeded arm order, original public and full
tests, five-second test deadline, first-failure feedback and loopback-port
normalization are unchanged. Explicit uncached requests make recorded and
cache-neutral model costs comparable.

The complete thirty-task cohort determines the result. The declared screen
requires quality at least strong-only and strictly above cheap-only, zero lost
strong successes or cascade false accepts, at least 20% lower recorded and
cache-neutral model cost, and workflow time **no greater than strong-only**.
A successful batch cannot substitute for the complete cohort.

## Why test this change

Before the new calls, a model-free diagnostic inspected all 72 cheap-model
stages in the original study. Seven outputs failed strict decoding. Four
became valid edits under unique exact-source relocation; the other three
remained rejected. All four recovered candidates received both public and
full tests, including the failures.

| Original stage | Public tests | Full tests | Outcome |
| --- | ---: | ---: | --- |
| `undici-bee01389d78a`, cascade draft | 2/16 ran; failed | 17/17 ran; failed | Rejected |
| `undici-a18ef2d05af4`, cascade draft | 117/117 passed | 123/123 passed | Recovered |
| `undici-4fe5bc5fefe5`, cascade draft | 17/82 ran; failed | 90/90 ran; failed | Rejected |
| `undici-a0922b0b6b5d`, cheap repair | 2/2 passed | 3/3 passed | Recovered |

These are posthoc feasibility results. They do not rewrite the original
study, imply saved invoices, or establish a causal gain. The new comparison
uses every task, not just these successful examples.

A mechanical census of all 118 new calls found nine outputs that fail strict
decoding. Four decode under exact relocation. Three are final cheap-only
outputs that pass public and full tests. The fourth is a cascade draft that
still needs fallback. No recovered cascade draft directly completes a task in
this draw. This describes the saved outputs; it does not estimate what a new
strict-decoder run would cost or solve.

A separate model-free attempt to combine sandbox writes preserved verdicts
in twelve paired measurements but saved only 0.88% at the median, below its
5% threshold. It remains disabled and is not part of this study.

## Costs and timing

The 118 calls total $0.323571 for strong-only, $0.188800 for cascade and
$0.048473 for cheap-only. Cache-neutral totals are $0.323573, $0.188802 and
$0.048476 respectively. Total new study cost is **$0.560844**. Cumulative
campaign accounting is **$324.261688 of $400**, leaving **$75.738312**.

Summed workflow time is 389.22 seconds for strong-only, 443.58 seconds for
cascade and 378.43 seconds for cheap-only. The cost reduction is about
$0.004492 per task before verifier costs. The extra 54.36 seconds across the
cohort breaches the declared no-slower gate.

## Interpretation

The tasks span twenty source files in one previously exposed repository.
Accounting batches are disjoint slices of one draw, not three independent
repeats. Fresh model outputs are stochastic; differences from the original
study cannot be attributed solely to anchor relocation.

Workflow time includes model calls, public verification and orchestration.
Independent full grading and replay audits run afterward and are excluded.
Model costs are estimates from saved token usage and the frozen price table,
not a reconciliation against the provider's invoice.
Serial local measurements do not establish service latency, throughput,
verifier CPU cost or total dollar savings.

These results do not justify enabling recovery by default for performance.
The edit tolerance remains opt-in; reducing failed cheap drafts is the next
research target.

This remains a caller-side development study. No service is deployed and no
production default changes. It is separate from the Worker ensemble endpoint.

## Semantic pre-routing screen

A follow-up used the saved independent controls for all thirty tasks to test
whether instruction similarity could avoid unproductive cheap attempts.
It made **zero model calls** and spent **$0**. All twenty held-out source-file
folds selected the constant strong-only policy: **29/30**, no cost reduction
and no workflow-time reduction. This router is rejected for further paid testing.

The fixed encoder was cached `all-MiniLM-L6-v2`: normalized 384-dimensional
mean-pooled vectors, with input limited to 256 tokens. Only the original task
instruction, minus its trailing issue number, entered the encoder. Candidate
policies used 1, 3 or 5 nearest neighbors and similarity thresholds of 0, 0.5,
0.7, 0.85 or 0.95, plus an all-strong policy. A cheap route required every
selected neighbor to preserve strong success and cost less than strong.

Both inner policy selection and outer evaluation held out an entire source
file, including sibling tasks. Inner selection required the same quality,
20% cost-saving and no-slowdown gates as this study. Eligible policies were
ranked by cost, then fewer cheap routes, then fixed grid order. If none passed,
the fold used strong-only. Policy selection never saw its outer fold's outcomes.

This screen's candidate was the original independent cheap control, with up
to two attempts, followed by the original independent strong control when
public tests failed. Both traces were charged on fallback. Public-pass/full-fail
outputs remained false accepts; hidden outcomes never triggered fallback.
This differs from the live study's one-draft cascade. Historical trace sums
are not live routed latency measurements.

The measured cold single-query encoder process took 261.67 ms; the slowest
warm query took 1.62 ms. The full cold time was charged per task whenever a
fold selected a nonconstant policy, including decisions that chose strong.
Constant strong-only did not invoke the encoder and received no charge.

The [screen summary](fusion-semantic-routing-screen.json) retains the fixed
grid, source-group decisions, accounting and audit hashes. The audit reproduced
all vectors and decisions from cached inputs. The sanitized summary supports
accounting checks; rerunning the router requires the retained encoder and
private development fixtures. These already exposed tasks cannot qualify
fresh generalization, even if a later screen produces savings.

## Public-test complexity routing screen

A second zero-call screen tested features available before generation: public
test count, public test text bytes, and the original broken baseline's public
failure count. It preserved **29/30** correct outcomes, but saved only **17.13%**
of model cost and added **21.72%** elapsed time. It fails the same 20% cost-saving
and no-slowdown requirements. This rule is rejected for further paid testing.

Each outer fold held out an entire source file and its sibling tasks. The
training set fitted a single threshold in either direction on one of the three
features. Thresholds came only from training values. A policy had to pass the
quality, cost and time gates on that training set; otherwise the fold selected
constant strong. Eligible policies were ranked by training cost, fewer cheap
routes, then lexicographic policy order. Held-out outcomes did not select the
policy. This uses training-fit selection, unlike the semantic screen's nested
neighbor selection.

The candidate used the same independent cheap control and public-failure
fallback accounting as the semantic screen. Across thirty held-out tasks it
selected eleven cheap routes, three of which required strong fallback. There
were no observed lost strong successes or false accepts. Model cost was
$0.268152 versus $0.323571 for strong-only; cache-neutral totals were $0.268156
versus $0.323573. Summed elapsed time was 473.76 versus 389.22 seconds.

A nominal one millisecond per decision was added to every task, including
constant-strong decisions. The implementation checked that mean selection
execution stayed below that allowance. This excludes production integration
and feature-loading costs; it is not a latency guarantee. The screen already
fails without needing to estimate those additional costs.

The [complete screen data](fusion-test-complexity-routing-screen.json) includes
all thirty rows, pre-generation feature values, held-out decisions, fold
policies and audit hashes. Accounting and fold coverage were independently
recomputed. The screen spent $0 on inference and used no model downloads or
new runtime allocation. These exposed historical traces do not demonstrate
fresh generalization, and no deployment or default changes follow.

## Recompute

The [sanitized data](fusion-hard-anchor-study.json) includes every task outcome,
per-call token usage and cost, the frozen policy, and protocol/result/audit
hashes. It excludes prompts, completions, credentials and private machine paths.

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeTransfer } from './scripts/fusion-repeatability-summary.mjs';
const report = JSON.parse(readFileSync('docs/fusion-hard-anchor-study.json', 'utf8'));
assert.equal(report.audited, true);
assert.deepEqual(summarizeTransfer(report.records, report.taskIds, {
  maxElapsedRatio: report.policy.maxElapsedRatio,
}), report.summary);
assert.equal(report.calls.reduce((sum, row) => sum + row.costMicros, 0),
  report.accounting.newCostMicros);
console.log(report.summary);
JS
```

This checks published arithmetic. Runtime provenance still depends on the
retained fixtures and audited receipts; the sanitized data is not a substitute
for replaying those checks.
