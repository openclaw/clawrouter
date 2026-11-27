# Rejected fallback repair and fresh-workflow replay

One additional strong repair recovered two observed failures, but left one
unresolved. A cheaper alternative emerged from offline replay: after a rejected
cheap draft, run the complete strong workflow from fresh context. Neither result
qualifies a production default.

These follow-ups reuse the [frozen three-arm study](fusion-final-confirmation-study.md).
They are outcome-informed development work, not another independent test set.
The [data](fusion-fallback-repair-study.json) binds that study's exact public
artifact and the private protocol/result/audit hashes for both new experiments.

## Precise edit feedback is task-dependent

The first experiment selected two distinct tasks by fixed hash order among
recorded initial edit rejections, without using full grades. It reused each
initial response and made three paired repairs with either generic feedback or
the executor's bounded edit diagnostic. Provider requests matched outside that
feedback text; pair order was balanced. All twelve calls preceded full grading.

| Task and repair model | Generic full successes | Diagnostic full successes | Generic / diagnostic charges |
| --- | ---: | ---: | ---: |
| Cookie parsing, Luna | 2/3 | 0/3 | $0.002306 / $0.002269 |
| Dispatcher wrapper, Terra | 0/3 | 3/3 | $0.014274 / $0.014234 |

The aggregate 2/6 versus 3/6 hides opposite effects. Model and task are confounded,
so this does not establish that diagnostics help one model family and hurt
another. Keep the rejected artifact checks strict. A blanket diagnostic policy
has not earned promotion.

## One bounded repair recovers two failures

The next experiment selected every admitted cascade whose public verification
failed in the original study: both retry-handler failures and the decompression
failure. The original first two calls and all controls were reused. Each selected
prefix received exactly one new strong repair, using its rejected strong artifact
and public feedback. No private grade controlled selection, and no new call was
retried. All three calls preceded full grading and replay audit.

| Admitted cohort, 20 tasks × 3 trials | Full successes | Model charges |
| --- | ---: | ---: |
| Original strong-only | 60/60 | $0.489112 |
| Original cheap-only | 51/60 | $0.066246 |
| Original two-call cascade | 57/60 | $0.288799 |
| Cascade with one extra strong repair | 59/60 | $0.329459 |

The new calls recovered the retry-handler failures in trials 1 and 3. The
decompression repair remained unusable. The extension retained 32.6% lower model
cost than strong-only but still lost a strong success. Across the complete
30-task cohort, it produced 83/90 versus strong-only's 85/90; the bypass stratum
was unchanged. Reusing old prefixes does not provide a comparable live latency.

The [caller-side workflow](fusion-router.md) now has an opt-in
`fallbackAttempts: 2` setting for this fixed three-call ceiling. Defaults stay
at two calls. The option is a bounded mechanism, not a quality guarantee.

## Fresh strong-workflow replay is the next candidate

A separate zero-call replay kept every publicly accepted cheap draft, then
reused the complete same-task, same-trial strong control after cheap rejection.
All 60 admitted initial strong request bodies matched the fresh-control builder.
That removes the rejected cheap draft from strong-model context while retaining
the strong workflow's own repair opportunity.

This replay yielded 60/60 full successes at $0.263387 in recorded trace charges,
46.1% below the $0.489112 strong control. It contains 84 replayed calls and 22
escalations. It is cheaper than the repair-conditioned extension on these traces.
The cache-neutral replay charge is $0.263392.

Those are reused control outputs, not 60 newly executed cascade runs. The policy
was chosen after inspecting the original results. Changed call order can change
cache behavior, and this replay estimates no live latency. A fresh, prospectively
frozen comparison is required before treating it as a demonstrated routing gain.

## Accounting and reproduction

The feedback experiment charged $0.033083 and the extra-repair experiment charged
$0.040660. Both include failed attempts. Campaign spending or reservations rose
from $316.589082 to $316.662825 under the $400 cap. Reused calls are included in
policy comparisons but are not billed again in campaign accounting. These are
recorded-usage charges at frozen tariffs, not a separately reconciled invoice.

Run `node --test test/fusion-fallback-repair-study.test.mjs` to reconstruct the
comparison from the public original artifact and this study's deltas, verify
the complete admitted replay, and check accounting. Private provider responses
and test fixtures are excluded, so this reproduces the analysis rather than
provider inference or private grading. No Worker route, default or deployment
changes are justified by these results.
