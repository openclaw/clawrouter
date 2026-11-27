# Compact handoff: a task-dependent economy result

A small reader can reduce the strong model's input cost, but it is not always
worth an extra call. On one HTTP/2 repair, three fresh reader-to-strong
workflows passed and cost **47.57% less** than full-context strong calls.
They took **1.71 times as long** at the median paired workflow ratio.
Three later compact-only strong calls all failed public verification.

On a second cache-redirect repair, compact-only strong execution passed and
was **22.04% cheaper and 31.27% faster than the handoff**. Adding the reader
was unnecessary on that example. These results support further work on
selective handoff, not an unconditional fusion policy or a production default.

The [sanitized results](fusion-compact-handoff-study.json) include every call
in these three experiments: **16 calls**, estimated model cost **$0.337738**.
Raw prompts, completions, credentials and machine paths are omitted.

## Comparison

The models are `openai/gpt-6-luna` and `openai/gpt-6.1-terra`, both with low
reasoning effort. The reader has a 4,096-token output cap; the strong model
has an 8,192-token cap. This is a same-provider comparison, not evidence for
an OpenAI-and-Claude combination.

Both initial routes receive the same original editable source, task narrative
and public tests. Full-context calls also receive read-only dependency files
from the same original revision. The compact route omits that dependency block.

The handoff policy starts with a full-context reader draft. A public failure
triggers one compact strong call containing the original editable source, the
actual draft and its public failure feedback. The draft is not applied first.
An unusable draft permits one full-context strong fallback. Neither experiment
used that fallback. A provider refusal stops execution; it is not routed around.

All edits target frozen original files. Exact source anchors may relocate only
when the search text occurs once at a line boundary. Paths, source hashes and
non-overlap checks remain enforced. Candidates cannot edit tests or dependencies.

Public verification stops on a test failure. Acceptance still requires the
complete expected test count, zero skips, passing assertions and valid syntax.
Full grading runs only for public-accepted outputs, after all model calls in
that experiment have finished. Hidden feedback never enters a prompt.

## HTTP/2 result

The [upstream repair](https://github.com/nodejs/undici/commit/55bf29469dc86deb6e6e5522fba934e9d7cb4adb)
releases saturated protocol probes after peer SETTINGS arrive and preserves
queue ownership, connection limits and backpressure. It has 14 public and
16 full tests. The full-context block contains 84,203 bytes from the original
Client, HTTP/2 implementation and symbol module.

The fixed three-pair order alternated which workflow ran first. All requests
were newly generated, explicitly uncached calls; recorded cache reads and
writes were zero. The strong control gets one full-context attempt. The
policy gets a reader attempt and, after its failure, one strong handoff.

| Route | Public acceptance | Full results | Estimated model cost | Summed workflow time |
| --- | ---: | --- | ---: | ---: |
| Full-context strong, paired | 3/3 | 3/3 pass | $0.113543 | 51.220 s |
| Reader plus compact handoff, paired | 3/3 | 3/3 pass | $0.059535 | 87.580 s |
| Compact-only strong, later controls | 0/3 | Not run | $0.045891 | Not compared |

Every reader draft failed public verification; every handoff then passed the
full suite. The cost ratio is 0.52434. The median of the three paired elapsed
ratios is 1.70981. The declared no-extra-latency gate fails. A separately
declared economy screen passes: all paired outputs pass, at least 30% lower
model cost, median paired time at most twice the control and each policy
workflow at most 90 seconds. This screen does not replace the broader gate.

The compact-only controls were a later diagnostic, prompted by the second
task's result. Their prompts contain neither reader drafts nor dependency
source. All three fail public verification, so their full-test scores are
unmeasured. These are new calls but not contemporaneous latency controls.
The result is consistent with useful dependency knowledge crossing the handoff;
it does not isolate that mechanism causally or establish population reliability.

## Independent cache-redirect result

The [second upstream repair](https://github.com/nodejs/undici/commit/03feee2770bf7eacc9c5185d9c48bfb43ab2ea7b)
preserves redirect-hop cache restrictions. Its author commit narrative supplies
the requirements. It has 14 public and 15 full tests. Both full-context routes
receive the same 87,752-byte block of original utility, symbol, error and date
dependencies. The compact-only control gets the same task and editable source
without that block.

| Route | Full result | Estimated model cost | Workflow time |
| --- | --- | ---: | ---: |
| Compact-only strong | Pass | $0.027331 | 23.537 s |
| Reader plus compact handoff | Pass | $0.035056 | 34.245 s |
| Full-context strong | Pass | $0.056382 | 22.587 s |

This was one fixed-order run: compact, handoff policy, full-context control.
The reader failed public verification and the strong handoff repaired it.
The handoff meets the separate economy screen against the full-context control,
but the compact-only control is both cheaper and faster than the handoff.
The fusion-value screen therefore fails. More context and another model call
do not establish more useful capability on this task.

## Limits and next decision

These are two exposed development tasks from one repository, with three paired
H2 repetitions and one cache repetition. They do not meet the original broader
qualification requirement of at least 30 unseen practical tasks with three
trials and task-clustered uncertainty. No prospective selector has been tested.
Choosing a route after seeing these outcomes would be hindsight routing.

Elapsed times include source verification, provider calls, usage accounting and
public verification. Independent full grading is excluded. These serial local
runs do not establish service throughput or concurrent-request latency.
Costs are estimates from saved usage and frozen prices, not reconciled invoices;
they exclude verification compute and earlier research expenditure.

The three experiments bring cumulative campaign spending and unresolved
reservations to $325.353066 of $400. The remaining allowance is $74.646934.
Protocol, result and audit hashes are retained in the result file. It permits
arithmetic checks, not independent reproduction of the private
runner or an audit of the omitted raw requests.

Before promotion, compare a frozen selector with compact-only and full-context
strong controls on additional independent tasks. Include failed candidates and
charge every reader, fallback and verification step. Keep the no-slower gate
separate from an explicitly chosen economy tradeoff.

This is a caller-side repair study, separate from the Worker ensemble endpoint.
No service is deployed and no production default changes.
