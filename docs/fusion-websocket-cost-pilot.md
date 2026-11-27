# Multi-file WebSocket repair cost pilot

A verification-gated Luna → Terra cascade matched both Terra controls on one
multi-file repair, at lower estimated API cost and higher mean workflow time.
This is one task repeated three times, not three independent tasks or a
production qualification. Existing routing defaults remain unchanged.

## Results

| Strategy | Final passes | Estimated API cost, total USD | Mean workflow seconds |
| --- | ---: | ---: | ---: |
| Compact Luna, full Terra on public failure | 3/3 | 0.045042 | 7.616 |
| Full-context Terra | 3/3 | 0.108247 | 6.138 |
| Compact Terra | 3/3 | 0.083499 | 6.118 |

The cascade cost 58.39% less than full Terra and
46.06% less than compact Terra. It took
24.07% and
24.49% longer, respectively.
One failed Luna attempt was rescued by Terra; the other two Luna attempts passed.
There were no observed false accepts. The rescued workflow took 12.430 seconds.

Ten model calls cost an estimated $0.236788 in total. Costs use observed token
usage and frozen tariffs; they are not an independently reconciled invoice.
[All nine workflow records](fusion-websocket-cost-pilot.json) include the ten
individual model-call costs and API times.

## Method

- Repair: [require a host for WebSocket URIs](https://github.com/fastify/fast-uri/commit/3df33a5ff84eca2bbd0de9bc38fd28c17a11c3e7).
  The editable files were `index.js` and `lib/schemes.js` at the recorded parent.
- The upstream fix passed all 574 assertions; the original broken revision failed
  with the same complete assertion count. Public verification contained 347
  assertions. Four unchanged test groups, containing 227 assertions, were withheld
  for final grading. All newly added regressions stayed public.
- All arms received the same task, original editable files, public tests and
  literal-source presentation. Full Terra also received original read-only
  dependency source. Exact anchored edits and unique-source relocation were
  validated identically. Tests and dependencies were protected against edits.
- Each repetition sampled its own independent controls. Orders were cascade/full/
  compact, full/compact/cascade, then compact/cascade/full.
- Models were `openai/gpt-6-luna` and `openai/gpt-6.1-terra`, with low reasoning,
  output ceilings of 4,096 tokens for Luna and 8,192 for Terra, and explicit
  cold-cache requests. The cascade
  called full Terra once only when public verification rejected Luna's result.
  That fallback started from the original source without the rejected draft.
- Existing cached Node 24 and TAP/Tape tools ran the tests without runtime network
  access. All inference finished before final-only tests ran.
- Workflow time includes API calls, accounting and public test execution. It
  excludes initial runtime admission and final grading. API time in the JSON is
  a separate measurement, not workflow time.

## Limits

Three repetitions of one historical public repair cannot establish general
accuracy, a stable latency distribution or cross-provider behavior. Local
qualification does not establish training-data decontamination. This study does
not establish a quality advantage over Terra or isolate collaboration from the
benefit of cheaper first attempts. It supports a cost-saving trade-off on this
case, with a visible fallback penalty. Broader unseen-task qualification and
uncertainty estimates remain necessary before changing defaults.
