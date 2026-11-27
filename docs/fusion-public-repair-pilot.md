# Fresh public-controller routing pilot

A prospectively frozen six-task pilot matched strong-only quality at 26.4%
lower estimated model cost. Workflow time was 18.3% higher. Cheap-only solved
four tasks; the routed policy and strong-only each solved all six. The pilot
passed its declared routing screen, with no false acceptance or lost strong
success. This is small-sample routing evidence, not production qualification.

| Policy | Correct | Model cost | Total workflow time | Model calls |
| --- | ---: | ---: | ---: | ---: |
| Strong-only | 6/6 | $0.050310 | 66.075 s | 6 |
| Routed cheap repair | 6/6 | $0.037037 | 78.148 s | 7 |
| Cheap-only | 4/6 | $0.008070 | 71.692 s | 9 |

The [sanitized data](fusion-public-repair-pilot.json) retains all 18 outcomes,
per-case costs, call counts, times, admission decisions, qualification exclusions
and protocol/result/audit hashes. The terminal audit replayed all 22 recorded
model calls and their verification, then independently reran final full-suite
grading. Artifacts, verdicts and accounting matched without new model calls.

## Policy and declared gate

This trial exercised the public `draftAttempts: 2` controller proposed in
[the implementation PR](https://github.com/openclaw/clawrouter/pull/1324).
The existing size-and-public-failure-ratio admission rule selected three cases
for cheap execution and bypassed three to the strong model. An admitted case
could use one cheap draft and one cheap repair before up to two fresh-strong
attempts. Both controls could use two attempts. Every attempted call counted.

All three admitted cases finished on the cheap model; one needed its repair.
No strong fallback ran. The result therefore supports this routing policy,
not a measured benefit from two models collaborating on one answer. The two
cheap-only failures occurred on different cases: one was admitted, one bypassed.
Separate samples do not establish that the repair option caused the gain.

Before inference, the routing gate required quality at least as high as strong
and strictly above cheap-only, zero false acceptances and lost strong successes,
at least 20% lower model cost, and no more than 20% extra aggregate workflow time.
The measured cost ratio was 0.7362 and time ratio 1.1827. The older development
gate also requires a strong rescue and remains false; it is not relabeled as a
collaboration result. Production qualification remains false.

## Cohort and limits

The screen considered twelve prepared, cached historical Undici fixtures in
fixed order, excluding all recorded prior inference exposure and runtime
qualification attempts. It stopped at six eligible cases after eight attempts,
with at most one case per source file. One baseline had incomplete watchdog
output; one reference failed qualification. Both remain excluded, and the four
unattempted candidates were not replacements.

Reference public/full suites had to pass; baseline public/full suites had to
fail with complete matching test counts and no skips. The live comparison used
the original public/full test files and the same source/context policy across
arms. Full grading ran only after all model workflows completed. Dependencies
came from the existing cached manifest fixtures; original-lockfile compatibility
was not established.

These tasks were new to the local inference ledger, not necessarily to model
training. They share one repository, and related historical fixes can share
structure. One sample per task cannot establish stable quality, latency or
savings. In particular, the latency result is close to the 20% limit, and the
strong-model bypasses have their own sampling variation. Repeated comparisons
and a larger, distinct cohort are still needed before promotion.

Workflow time includes model dispatch, decoding and public verification; final
full-suite grading is outside it. Costs use frozen tariffs and recorded token
usage, not independently reconciled provider invoices. The whole three-arm
trial added $0.095417 to the experiment ledger. Its $4.552491 reservation was a
ceiling, not a charge. No new downloads, inference infrastructure, deployment
or routing-default change occurred.
