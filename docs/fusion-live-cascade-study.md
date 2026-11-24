# Live cascade loses strong-model successes

A live ten-task comparison produced seven successes with a Luna-first cascade
and nine with Terra direct. The cascade used 66.58% less model cost, but public
checks accepted three answers that failed full grading. This is a failed
quality screen, not a viable cost gain or production qualification.

## Protocol

The fixed cohort contains six medium functional tasks and four hard stdin
tasks from cached LiveCodeBench data. All ten had appeared in earlier research.
This is a development replication, not an independent confirmation cohort.
Task order uses a fixed identity hash; direct-first and cascade-first ordering
alternate. Each arm receives the same task and public examples, with medium
reasoning effort and an 8,192-token output limit.

Terra direct makes one call. The cascade calls Luna, runs public checks, and
buys one fresh Terra answer only if those checks fail. The fallback receives
the original task without the cheap draft or feedback. Each returned answer
runs in the existing isolated verifier. All live decisions finish before any
private grading. This measures actual conditional calls, not hypothetical
selection from a cache of every model's answers.

## Result

| Arm | Passed | Model cost (USD) | Aggregate live time |
| --- | ---: | ---: | ---: |
| Terra direct | 9/10 | $0.037774 | 127.29 s |
| Luna → conditional Terra | 7/10 | $0.012624 | 124.92 s |

The cascade made eleven calls: ten drafts and one fallback. The direct control
made ten calls. All 21 calls cost $0.050398. The one fallback succeeded where
the separately sampled direct answer failed, but the cascade lost three other
direct successes. One rescue cannot offset three lost successes.

Two accepted cheap answers failed hidden assertions. A third passed public
examples but timed out on two full-grading cases under the original limits.
Those timeouts remain failures. Full grading used 384 isolated case executions
across both arms; no runtime limits were relaxed after observing results.

The frozen development gate required both arms to pass all ten tasks, no false
acceptances, at least 20% lower model cost, at least one actual fallback rescue,
and aggregate live time no greater than 1.2 times direct. It failed the quality
conditions. The 1.86% aggregate timing difference is one local sample, not a
latency improvement claim. Live time includes admission, generation, decoding,
public verification and persistence; it excludes final private grading.
Hardware, engineering and operational costs are excluded from model cost.

The [sanitized per-arm evidence](fusion-live-cascade-study.json) retains failures,
costs, timings and source/result identities. Raw prompts and completions are
not published. Production behavior and defaults are unchanged.

## Next constraint

Public examples alone are too weak to admit this shortcut. Further work needs
an independently validated verifier that detects semantic errors and resource
failures before accepting a cheap answer. Any verifier developed against these
failures needs new confirmation cases, and its runtime must count toward the
workflow. Repeating model calls or tuning on these ten tasks cannot establish
generalization.
