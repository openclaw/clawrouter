# Missing-draft escalation development check

The fixed 30-task [cheap-repair comparison](fusion-cheap-repair-study.md)
lost one task after a cheap draft returned no usable artifact. The workflow
spent another cheap call before reaching the strong model. This check tests
skipping that extra cheap call whenever the initial artifact is null.

## Method

Select all initial null-artifact candidate drafts, without selecting on their
final scores: two of 30 tasks. Retain those initial drafts and make one new
GPT-6.1 Terra call for each, using the original source request and the initial
public failure feedback. Complete both calls before grading. Retain the other
28 candidate outcomes and both original control arms. No generation retries,
new source downloads, or new compute allocations.

The original candidate uses GPT-6 Luna, one Luna repair when needed, then
Terra. The revised candidate skips the Luna repair only for a missing initial
artifact. The baseline uses Luna followed by up to two Terra attempts; the
strong control uses Terra throughout. These are exposed development tasks.
Reused outcomes and new calls do not form a fresh randomized comparison.

## Results

| Policy | Original full-test passes | Model cost, USD |
| --- | ---: | ---: |
| Original cheap-repair candidate | 29/30 | 0.063159 |
| Missing-draft escalation | 30/30 | 0.061164 |
| Paired baseline | 30/30 | 0.076203 |
| Strong control | 30/30 | 0.217653 |

Both new outputs passed their public and original full suites. The revised
candidate has zero false accepts on those suites, costs 3.16% less than the
original candidate, and costs 19.74% less than the paired baseline. It **fails
the frozen 20% savings gate**. The two new calls cost $0.014541; that spend
remains charged even though the policy comparison reuses other outcomes.

Replaying all 30 recorded paths through the caller-side workflow reproduced
their model choices, final artifacts, public verdicts, and total model costs.
This is a controller integration check, not new inference or latency evidence.

The expanded semantic audit remains **17/23** reference matches. Only one
changed artifact belongs to that cohort. Replaying it preserved two reference
mismatches; the other 22 results were reused. Passing the original tests does
not establish complete semantic correctness. No production or end-to-end
latency qualification follows from this check.

## Reproducibility

Frozen private receipt digests, SHA-256:

- Two-call protocol: `a0ee8159ce25b4e498156b77a296e5f73d386fbfbdafa93d7ce0d8a6016a7319`
- Original-test qualification: `5f67ca3c3c8a409e236de81987bb4878a05035b0b9a718bc1ac7abd35d6343bf`
- Controller and semantic audit protocol: `e2bbff20d8fc8133cbfcc53fbd7a419222025e723dc4e96432598d6140ef1993`

The implementation exposes `repairMissingDraft: false` in the
[caller-side cascade](fusion-router.md). It preserves the default sequence,
configured call limits, required verification, and provider-error behavior.
It does not change Worker routing defaults.
