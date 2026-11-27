# Fusion transfer beyond HTTP/2

The compact-first path passed ten attempts across five non-H2 repairs. Every
attempt stopped before a reader or fallback call. This expands the tested
early-exit path; it provides **no additional evidence of a mixed-model advantage**.

These are development measurements from November 27, 2026. The
[machine-readable results](fusion-transfer-study.json) include per-attempt token
usage, costs, public and full-suite grades, workflow times, and artifact hashes.

## Results

| Original repair | Public / full tests | Broken-baseline full failures | Compact attempts passing full suite | New estimated cost |
| --- | ---: | ---: | ---: | ---: |
| [HTTP/1 socket error](https://github.com/nodejs/undici/commit/1e0bea9fb57720118866fe4b6ce3fb9263596add) | 5 / 6 | 5 | 2/2 | $0.047488 |
| [Cache batch rollback](https://github.com/nodejs/undici/commit/161e78eb364b80d0db5235ec9eff1ba862de6a93) | 4 / 5 | 3 | 2/2 | $0.022986 |
| [SOCKS IPv6 hosts](https://github.com/nodejs/undici/commit/789001cdb570ae6fef93bcd18e3d65d13fc5ace6) | 39 / 42 | 4 | 2/2 | $0.047985 |
| [Falsy fetch abort reasons](https://github.com/nodejs/undici/commit/5d7f657451f7b813d33513b4a1c46f923db63113) | 13 / 16 | 5 | 2/2 | $0.065239 |
| [TLS server-name switching](https://github.com/nodejs/undici/commit/6b22aba1b0f54e2cebe39c198e718c2157fa3fbb) | 2 / 6 | 6 | 2/2 | $0.026512 |

Total: **10 physical model calls, $0.210210 estimated model cost, 10/10 full-suite
passes, zero fallback calls and zero mixed-model rescues**. All new calls used
`openai/gpt-6.1-terra` at low reasoning effort. There were no Luna calls in this set
because the first-stage checks passed.

The SOCKS totals include one existing upstream skipped HTTPS test in each suite:
38 active public tests and 41 active full tests. Its exact name is frozen in the
results. The other four tasks had zero skips. No test was newly skipped.

## What was compared

Each task had two independently generated compact attempts. Each attempt was
shared by two prospective policies:

- Compact attempt, then full-context Terra if public verification fails.
- The same compact attempt, then a full-context Luna reader and a compact Terra
  handoff if needed.

The policy orders were counterbalanced. Both policies stopped at the shared
compact answer in every pair, so their compared cost is identical. Each policy
is charged the prefix in its own comparison; the physical ledger charges it
once. Four policy rows per task represent two generated answers, not four
independent successes. Small timing differences between those rows are
bookkeeping, not a speed advantage.

There was no full-context-only call in this set. These results therefore do not
establish savings against always calling a full-context model. The earlier
[matched fallback comparison](https://github.com/openclaw/clawrouter/pull/1460)
measures a different question on a harder HTTP/2 case; this set does not
generalize that result.

## Qualification and controls

Each original repair was checked against its broken parent before paid inference:
the repaired source passed both suites, while the parent failed at matching test
counts. A deterministic original test group was withheld from public inputs.
Public rejection controlled continuation; full-suite grading occurred after both
attempts finished. The TLS server-name task withheld four of its six tests. A
full-suite failure would have remained a false accept rather than triggering a
replacement call.

The SOCKS task previously could not be staged because its original test-server
helper also changed. A separate qualification supplied that original helper as
hash-pinned, protected test support to the baseline, reference, and candidates.
It was not editable source or an extra test. The existing skip was accepted only
with its exact declared label and complete matching TAP results.

All runs reused a pinned local Node image and cached, original-lock-verified test
dependencies where needed. No models, dependencies, images, or additional
machines were downloaded or allocated. Fallback inputs were frozen with bounded
original dependency excerpts; those unused inputs do not count as executed calls.
The fetch-abort brief described the reported issue without the repair author's
implementation advice.

## Limits and decision

Five selected tasks and two attempts per task cannot establish reliability or a
production policy. Exposure to earlier campaign prompts remains unassessed.
These are same-provider measurements, not an OpenAI-plus-Claude comparison.
Estimated API cost excludes subscription charges, local grading compute, and
engineering time.

Keep compact-first early exit as a development policy. A generally useful fusion
claim still needs a fixed, representative set that exercises fallback, plus the
original target of at least 30 unseen practical tasks with three repetitions and
uncertainty estimates. Production defaults and deployment remain unchanged.
