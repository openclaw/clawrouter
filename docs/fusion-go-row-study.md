# Native Go literal-row pilot

A third small historical Go repair passed the selected regression test under
cheap-only, strong-only and cheap-first cascade policies. The cascade cost
84.71% less than direct strong and took 17.31% more warm workflow time.
Every policy finished after one call. Cheap-only also passed, so this case
supports cheap-first routing but shows no added collaboration benefit.

The [observations](fusion-go-row-study.json) contain all three calls, token
usage, frozen tariffs and protocol/result hashes. Raw private execution traces
and the harness are not published; the hashes do not independently reproduce
the model calls. No production routing or deployment changes follow.

## Original regression and partition

The task is the output-package slice of a public
[Crawlkit hardening change](https://github.com/openclaw/crawlkit/commit/232aef3d30b8f31801f0687afd577e4cf922475e).
Its original `TestWriteLogRejectsAmbiguousLabels` loops over two inline string
literals: a label containing a newline and one containing an equals sign.
The positive valid-label check remains unchanged in every partition.

Before model calls, a fixed hash of the commit, test name and literal selected
one public row and one withheld row. The exact original full table was retained.
The original implementation failed and the reference implementation passed all
three partitions, each with one complete native test event. These are two
literal inputs to one test, not two independently sampled tasks.

Public prompts, compilation, execution and repair feedback contained only the
public row. Full grading used the exact original table after all policy runs,
without sending its result back to a model. No new regression examples or
production-function stubs were invented for qualification.

The original module file was preserved. Only standard-library and local
transitive production imports were admitted; unrelated module requirements
were not downloaded. An installed Go compiler built the test binary, which
ran in the existing immutable Linux sandbox without network access. Repository
test code did not execute on the host.

## Fixed comparison

All policies received the same author narrative, original numbered production
source and public test. Each had at most two calls and 8,192 output tokens per
call, with low reasoning effort. The recorded model IDs were
`openai/gpt-6-luna` and `openai/gpt-6.1-terra`; an independent model-weight
snapshot is unavailable. A public pass stopped generation. The declared order
was cheap-only, strong-only, then cascade.

| Policy | Full selected test | Calls | Model cost USD | Warm workflow seconds |
| --- | --- | ---: | ---: | ---: |
| Cheap-only | Pass | 1 | 0.000555 | 9.557 |
| Strong-only | Pass | 1 | 0.002930 | 5.846 |
| Cascade | Pass | 1 | 0.000448 | 6.858 |

Costs apply frozen tariffs to observed usage; they are not invoice
reconciliation or current price quotations. Warm workflow time includes each
model call and public validation. It excludes a separately measured 6.009-second
shared compiler warmup and later full grading. The fixed order, shared cache
and single model draw per policy limit timing and policy comparisons.

The cascade and cheap-only calls are independent draws of the same cheap
model. Their different costs and times do not establish a causal cascade
advantage. This small task also does not erase the earlier Go hydration case,
where a necessary strong fallback cost more and took longer than direct strong.
Historical training exposure is unknown, and selected regressions are not the
project's full test suite. A larger frozen sample with all failures retained
is still required for production claims.
