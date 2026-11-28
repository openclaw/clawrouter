# Native Go cascade pilot

Two historical Go repairs produced a small cost lead for cheap-first routing.
The cascade and strong-only policies each passed both selected regression
suites. Independent cheap-only passed one. The cascade used 38.13% less
usage-priced model cost and 3.52% more warm workflow time than strong-only.
Two tasks do not qualify production routing or establish population accuracy.

The [observations](fusion-go-cascade-study.json) include every arm and attempted
call, token usage, frozen tariffs, protocol and result hashes. They support
arithmetic checks; the private execution traces and harness are not included,
so this publication does not independently reproduce the original model calls.

## Method

The tasks are the Go CLI portions of two public Octopool fixes:

- [Read merge-gate fields live](https://github.com/openclaw/octopool/commit/235198394d45d893904e39dd0a99ccfe1b015375): seven public and eight full test events.
- [Keep PR file hydration head-consistent](https://github.com/openclaw/octopool/commit/b4c6de2610e67f3f97e388b9d583f565fe750309): two public and three full test events.

Both public and withheld groups passed on the reference fix and failed on the
original source, with complete matching native counts, before inference.
These are selected regression suites, not the projects' full CI. The first
fixture excludes one test that calls a newly introduced helper and cannot
compile against its original parent. The second uses the complete changed
test-function groups. Four subsequent fixed three-commit cohorts admitted
only the second task; their eleven exclusions were retained without refill.
This selection process is not a representative sample of Go changes.

Each policy receives the same original numbered source, author commit or
changelog narrative, public tests, and at most two calls with 8,192 output
tokens per call. All models use low reasoning effort. The recorded API model
IDs are `openai/gpt-6-luna` and `openai/gpt-6.1-terra`; no independent model-weight
snapshot is available. Policies run in cheap-only, strong-only, cascade order.

A complete public-test failure or rejected edit permits the declared second
attempt. The cascade switches to the strong model; the controls retry their
own model. A public pass ends generation. Full grading runs only after all
three policies finish, without returning withheld feedback to a model. An arm
that exhausts its calls without a public pass submits no accepted artifact.

An installed Go compiler cross-compiles test binaries with module downloads,
CGO and telemetry disabled. Binaries run in the existing immutable Linux
container with no network, a read-only root, dropped capabilities and bounded
resources. Repository test code does not execute on the host.

`workflowMs` includes model calls and public validation after a separately
measured shared compiler warmup. It excludes subsequent full grading. It is
not end-to-end client latency. Cost uses observed tokens and frozen study
tariffs, includes failed drafts, and excludes local compute and invoice
reconciliation. The tariff snapshot is not a current price quotation.

## Results

| Task | Policy | Accepted | Calls | Model cost USD | Warm workflow seconds |
| --- | --- | --- | ---: | ---: | ---: |
| Merge-gate fields | Cheap-only | Yes | 2 | 0.003745 | 18.993 |
| Merge-gate fields | Strong-only | Yes | 1 | 0.017638 | 13.030 |
| Merge-gate fields | Cascade | Yes | 1 | 0.001823 | 9.836 |
| PR file hydration | Cheap-only | No | 2 | 0.004020 | 18.179 |
| PR file hydration | Strong-only | Yes | 1 | 0.022066 | 18.769 |
| PR file hydration | Cascade | Yes | 2 | 0.022743 | 23.083 |

On merge-gate fields the cascade never needed its strong fallback. Independent
cheap-only needed a correction; these are different cheap-model draws, not
evidence that the cascade's policy improved its first answer.

On PR file hydration both independent cheap attempts failed public acceptance.
The cascade's cheap draft failed compilation, and the strong fallback passed
all three full tests. That demonstrates fallback recovery, but this individual
cascade cost 3.07% more and took 22.98% more workflow time than direct strong.

| Policy | Accepted tasks | Calls | Total model cost USD | Total warm workflow seconds |
| --- | ---: | ---: | ---: | ---: |
| Cheap-only | 1/2 | 4 | 0.007765 | 37.172 |
| Strong-only | 2/2 | 2 | 0.039704 | 31.799 |
| Cascade | 2/2 | 3 | 0.024566 | 32.919 |

The aggregate saving depends on the cheap-sufficient task offsetting fallback
overhead on the harder task. It does not imply that every request benefits.
Task history and prior training exposure are unknown; "first recorded
comparison" does not mean uncontaminated or previously unseen by the models.

## Follow-ups and limits

Three rotated repeats of the already exposed merge-gate task passed all nine
arms. Every cascade stopped after its cheap call, so those repetitions test
stability on one task rather than add three independent tasks.

A separate conditional handoff check reused the first failed PR-hydration cheap
draft. Both strong repairs passed all three full tests. Applying the draft
before repair cost 7.07% less and took 28.55% less conditional repair time than
rebuilding from original source plus prior edits. It missed its predeclared
10% cost gate. This exposed-task result excludes inherited generation time
and is not an end-to-end policy comparison; it is not pooled above.

The next useful evidence is a larger frozen set of independently qualified
repairs, preserving cheap-only controls, failed arms, full grading and all-call
costs. No production strategy, model default or deployment changes follow from
this pilot.
