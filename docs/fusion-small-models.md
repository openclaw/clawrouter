# Low-cost Fusion research and screening

The [live Undici transfer pilot](fusion-undici-live-transfer.md) matched
strong-only at 3/3 tasks with 58.85% lower model cost and 17.68% less measured
workflow time, including public verification. One cheap draft required a
successful strong fallback. This small, single-draw study on an exposed
repository passes its development screen; production routing stays unchanged.

Research baseline reviewed on 2026-11-05; routing follow-up on 2026-11-24.
Keep production Fusion opt-in. This plan tests
the mechanism before paying for another frontier-model comparison.

The [frozen three-arm repository confirmation](fusion-final-confirmation-study.md)
retains 30 tasks, three trials and all 270 outcomes. Cheap-first saved 23.0% in
model charges but passed 81/90 versus strong-only's 85/90; cheap-only passed
70/90. It failed quality preservation. The report includes both predeclared
admission strata and source-clustered uncertainty; no default is promoted.

The [fallback-repair follow-up](fusion-fallback-repair-study.md) records mixed
effects from precise edit feedback, two recovered failures from one extra strong
repair, and an offline fresh-workflow replay. The latter is a candidate for fresh
validation, not a live routing result.

The [interrupted fresh-fallback study](fusion-fresh-workflow-study.md) records
240 of 270 planned outcomes: 79/80 cascade successes versus 80/80 strong-only.
A same-millisecond cache boundary let a bad draft pass its original public
check; replay rejected it and stopped before the final batch. Lower recorded
cost does not qualify this policy. The failure and fixed-clock diagnostic remain
visible, with no replacement calls or default change.

Clock-sensitive verification can prepare an explicit fixture with
`freezeNodeTestClock` from `scripts/fusion-fixed-clock.mjs`. Supply the exact
source SHA-256, one test title and a trusted JavaScript parser returning a
Babel File or ESTree Program with character offsets. Executable registration
nodes, not comment or string content, select the test. Pin the parser version
alongside the fixture. The helper returns a new file plus original
and transformed hashes; it freezes `Date.now()` inside that test using Node's
test-context mock, which is restored when the test ends. Other clocks and timer
scheduling are unchanged. The helper accepts only one standalone
`test('title', async () => {` registration with no existing callback parameters.
Unsupported or ambiguous input fails instead of being guessed.

Use this before freezing a new evaluation protocol. Keep the original file and
qualify the transformed suite against both the unfixed baseline and the known
reference fix. Give every compared model the same declared fixture, and bind
its hashes into the protocol. Never silently change an existing study or reuse
old results as proof for a new verifier. A frozen clock can expose strict
`now > staleAt` boundary mistakes; it is unsuitable for tests that need time to
advance. This is an opt-in preparation utility, not automatic verifier repair
or evidence of improved model quality.

The [adapted coding-cohort study](fusion-livecodebench-study.md) records a
12-task development lead for strong review followed by small-model repair:
12/12 versus 9/12 for small direct, at 33.7% less model cost than strong direct.
The disjoint follow-up did not reproduce the cost advantage and exposed a
malformed private fixture. A subsequent input-validated cohort lost strong-model
successes under both always-review and public-gated review. These fixed policies
are not promotion candidates; future policy changes need fresh confirmation.

Pair receipts separate `agentElapsedMs` from `gradingElapsedMs`. Agent time
includes its tools, visible checks and sandbox cleanup. Grading time measures
the independent final acceptance suite, including its cleanup, and is `null`
when grading never starts. Both durations survive phase failures. Existing
`elapsedMs` retains its end-to-end meaning and remains the analyzer's default.
Select agent time explicitly for both single-run and repeated comparisons:

```sh
node scripts/fusion-pair-analysis.mjs --latency-metric=agentElapsedMs /path/to/pair.json
```

The report names the selected `latencyMetric` and retains both time totals.
Latency ratios, cheap dominance and the repeated pilot screen use that same
metric. Missing agent measurements never fall back to total time: single-run
comparisons become unknown and repeated analysis rejects incomplete times.
Predeclare the metric before a comparison; slow hidden timeout tests must not
be treated as agent execution. Older receipts lack the phase measurements and
cannot reconstruct them from total elapsed time.

Failure diagnostics distinguish `visiblePassFailures` (a visible pass but zero
final score), `falseAccepts` (a submitted visible-pass candidate with zero final
score), and `acceptancePassesWithoutSubmission` (an unsubmitted attempt whose
independent grade matches the qualified test count and passes). A passing
partial patch does not change its zero score or the pilot gate. Older receipts
without `outcome` cannot establish submission and count only in the first metric.

Draft refinement skips verification when a response applies no patch. It tells
the next attempt whether to shorten truncated output or repair invalid edit
anchors, while retaining the current source and the same three-attempt ceiling.
Applied drafts still require the visible tests and supplied reproducer to pass.

Visible checks must produce a complete test summary. An incomplete run, including
a test watchdog termination, stops that agent with `incomplete_test_run` before
another model call or final grading. Complete assertion failures remain repairable.
The general agent failure trace retains action metadata without raw test output.
Pair analysis also requires complete acceptance verdicts before reporting quality
or cost gains, including zero-score rows. Known-cost execution errors with no
grading attempt remain failures; a supplied incomplete grade invalidates the run.
Grounded and checked repair profiles also stop on incomplete visible checks,
including checks after an edit or a review submission.

## Independent cheap and strong controls

The [seven-task, two-repository comparison](fusion-independent-controls.md) includes matched independent cheap-only and strong-only arms: cascade 7/7, strong-only 7/7 and cheap-only 2/7, with three fallback rescues. Cascade model cost was 51.33% lower than strong-only and measured time 5.99% higher. This is a bounded development result, not production qualification.


## Bounded caller-side tool trajectories

`scripts/fusion-trajectory.mjs` exports `runTrajectory`,
`runSingleTrajectory` and `runFinalReviewedTrajectory` for callers that need multiple tool steps. This is an
opt-in utility; it does not register a Worker route or select models by itself.
The caller provides model callbacks and a trusted tool registry. It also owns
provider credentials, spending reservations and reconciliation, and tool isolation.

Each tool has a unique `name`, an `effect` of `read` or `write`, a synchronous
`validate(arguments)` callback and an asynchronous `execute(arguments, signal)`
callback. Only tools with no external mutation may be declared `read`.
Actions and observations must contain plain JSON values; `undefined` is invalid.
Tool output is untrusted data, not permission to change the task or tool policy.

The model callbacks receive a copied `{ task, history, segment }` and an abort
signal. Return `{ type: "tool", name, arguments }` for a tool step or
`{ type: "final", content }` for completion. In `runTrajectory`, `verify` returns
`{ accepted, reason, replacement }`: `accepted` is the length of the valid prefix
of the proposed segment, and `replacement` is one corrective action or `null`.
Full acceptance requires a null replacement. Rejection requires a nonempty reason.
If no usable replacement is supplied, `repair` receives only committed history
and the reason. Rejected observations do not reach subsequent model callbacks.

Read actions execute before review so the verifier can inspect their observations.
Writes and final answers wait for review. A read-only segment is reviewed after
`chunkSize` steps. `runSingleTrajectory` uses the same action validation, limits
and registry but invokes only `draft`, with no semantic reviewer. This provides
a matched execution control, not a guarantee of equivalent answer quality.

All three functions return `{ content, history, stats }`. Set `maxModelCalls`,
`maxToolCalls`, `maxContextBytes` and `deadlineMs` before execution. Every model
callback and tool execution consumes its corresponding limit, including an
optional final check. Set `finalCheckTool` to a registered tool that accepts `{}`
and returns an observation with boolean `passed`. A failed final check enters
history and continues the trajectory; only a passing check permits completion.

For deterministic follow-up tools, `runSingleTrajectory` and
`runFinalReviewedTrajectory` accept a synchronous
`nextAction({ task, history, segment })` callback. Return a registered tool action
to execute it before the next model call, or `null`/`undefined` to ask the model.
For example, a caller can run tests after an edit without asking a model to
select that already-known step. The callback receives copied history, and every
scheduled action uses the normal validation, tool limit, deadline and history.
It cannot return a final answer or be used with reviewed `runTrajectory`.
An always-scheduling callback exhausts `maxToolCalls`; it does not run forever.

All three controllers also accept `onCheckpoint(snapshot, signal)`. The optional
callback receives a copied `{ task, history, stats }` after a nonempty committed
step or segment, including scheduled tools and final checks. It never receives
rejected observations or a held write before review and execution. The controller
awaits the callback within the existing deadline; persistence failures stop the
run without retrying the tool or callback. The model adapters forward this option.

Use checkpoints to retain confirmed work if a later call reaches a limit. A
checkpoint does not certify completion or authorize replay. A later interrupted
tool can still have an unknown external outcome; reconcile that operation before
resuming. The caller owns checkpoint storage and redaction. Existing callers that
omit the callback retain their execution and result format; this optional utility
introduces no persistent-state migration or Worker deployment change.

The controller propagates callback errors and does not retry a failed or timed-out
operation. Callbacks must honor their abort signal. A callback that ignores
cancellation may continue after the controller rejects, so the caller must
reconcile its outcome before another write or paid request. Returned history can
contain sensitive tool data; callers must choose storage and redaction explicitly.

This execution contract does not establish a fusion quality, cost or latency gain.
Keep independent final grading and fixed-model controls in any comparison.

### Completion review

`runFinalReviewedTrajectory` executes each validated tool action immediately and
reviews only a proposed final answer. Use it only with caller-owned disposable
state: rejected completion does not roll back earlier writes. Keep external
publication or deployment outside the trajectory, after independent acceptance.

The verifier receives the committed history and one held final step. Acceptance
requires `accepted: 1` and `replacement: null`. A rejected final answer may produce
a corrective tool action or a separate repair call. Replacement and repaired
final answers pass through review again; they cannot bypass it. Model calls,
tools, checkpoints, cancellation and `finalCheckTool` retain their existing limits.

Set `initialFinalAnswer` to a nonempty string to start by reviewing an existing
candidate without a new draft callback. This option applies only to completion
review, including its model adapter. The caller must restore the candidate's
working state and supply its evidence through tools or `reviewSnapshot`.
The answer remains held for review and final checks; rejection follows the
normal correction flow. Scheduled tools still run before review. This does not
restore history or certify a checkpoint. Include the original draft's cost and
time when comparing complete workflows.

Set `reviewAfterCorrection: true` to review the held final answer again after a
corrective write, without another draft call. The controller awaits the write
and its checkpoint before running scheduled checks and requesting the next
review. Read-only corrections still return to drafting. The option applies only
to completion review, defaults to `false`, and retains every call, tool and
final-check limit. A failed or cancelled checkpoint stops the run without
retrying the write or requesting another review.

An optional synchronous `reviewSnapshot({ task, history })` callback supplies a
plain JSON snapshot for the verifier. Its request becomes `{ task, segment,
snapshot }`; draft and repair callbacks still receive history. The controller
copies and bounds the snapshot and preserves its own task and held segment.
The caller must include enough evidence to review the current result. A snapshot
or passing public check does not establish full correctness.

## Connecting models to a trajectory

### Supplying current source

`scripts/fusion-trajectory-workspace.mjs` exports
`workspaceModelView(request, workspace)` for callers that own an editable source
workspace. Apply it inside the adapter's `invoke` callback before metering and
sending the request:

```js
const request = JSON.parse(body.messages[1].content);
const view = workspaceModelView(request, {
  revision,
  files: currentFiles,
  context: publicContext,
  publicCheck: checkedRevision === revision ? lastCheck : null,
});
const projected = {
  ...body,
  messages: [body.messages[0], {
    ...body.messages[1], content: JSON.stringify(view),
  }],
};
return invokeMetered(runId, model, projected, signal);
```

Supply a nonnegative integer revision, current `files`, read-only `context`, and
either a current `{ passed, feedback }` check or `null`. Each file has a unique
`path` and string `content`. The caller must update the revision and invalidate
the check after every edit. Meter and enforce request-size limits on the final
payload sent to the provider.

The helper copies its inputs. It replaces successful `edit_source` and
`edit_sources` arguments with affected paths only when every path is present in
the current workspace. Failed edits and edits to unavailable paths remain intact.
Identical `run_tests` feedback can reference `workspace.publicCheck.feedback`;
other observations remain unchanged. Returned controller history and checkpoints
retain their original arguments and feedback.

To keep starting behavior visible during repair, callers can include immutable
starting-source copies under distinct paths in `context`. Keep those paths out
of the tools' editable allowlist. This helper performs no filesystem operations
and does not enforce tool permissions or certify that source and checks are
current. Supplying context does not establish correctness or a cost reduction;
retain independent acceptance checks.

### Choosing the model

`scripts/fusion-trajectory-models.mjs` connects the controller to a caller-supplied
`invoke(runId, model, body, signal)` function. It exports four entry points:

- `runModelTrajectory`: a draft model, reviewer and corrective actions.
- `runSingleModelTrajectory`: one fixed model, without semantic review.
- `runFinalReviewedModelTrajectory`: execute tool actions and review completion;
  an optional `selectModel` chooses the draft model from the configured pair.
  Verification uses `reviewModel`; corrective calls default to the same model.
- `runAdaptiveModelTrajectory`: a synchronous `selectModel(request)` callback
  selects either `draftModel` or `reviewModel` for each action. It sees a copied
  task and committed history; an unconfigured selection stops the run.

Set `repairModel` to assign corrective calls to a separate model. Set
`reviewCanReplace: false` to restrict the reviewer to a verdict and reason;
its schema requires a null replacement, and the adapter rejects replacement
actions locally before execution. For example, a stronger draft and repair
model can use a smaller critic. Draft selection still uses only `draftModel`
and `reviewModel`. All three roles use the same metered callback and shared
execution limits. The defaults preserve existing behavior. This configuration
does not establish a quality or cost gain; compare it with direct execution
and keep independent acceptance checks.

For executable-check feedback, `scripts/fusion-check-routing.mjs` exports
`createCheckDrivenSelector({ draftModel, repairModel, checkTool, repairSteps })`.
Pass its result as `selectModel` and configure the adapter's `reviewModel` to
match `repairModel`. It starts with the draft model. A boolean `passed: false`
from the named check tool selects the repair model for four subsequent steps
by default. Consecutive failed checks extend that window by two steps, up to
eight; a passing check immediately returns to the draft model. Other tools,
missing results and non-boolean values do not affect selection.

The selector makes no model calls and owns no mutable state. It derives its
choice from committed history, so the controller's existing limits still apply.
Use a caller-owned executable check, such as supplied tests and a compiler.
This is routing feedback, not completion evidence: configure `finalCheckTool`
separately and keep independent acceptance checks. A weak check can miss defects;
the helper does not establish a general quality or cost advantage. Existing
callers and default routing remain unchanged.

Supply `task`, `runId`, `tools`, `invoke` and the controller limits. Reviewed and
adaptive runs require both model identifiers. Single-model runs use `model`.
Each tool also supplies `parameters`, a strict JSON Schema object in which every
property is required and `additionalProperties` is false. Use explicit nullable
fields when needed. The adapter rejects optional properties, unsupported schema
composition, and excessive schema depth or node count before calling a model.
Tool argument validation still runs after the model responds.

The request body uses OpenAI-compatible `messages`, `max_tokens` and a strict
`response_format` JSON Schema. The callback must return a normalized completion
with `choices[0].message.content` containing JSON and a completed stop reason.
The adapter rejects refusals, truncation, unknown stops and malformed JSON; it
never retries or switches models after a transport error. For Responses or
other native provider APIs, the caller must translate requests and normalize
responses. Model identifiers remain opaque to the adapter.

`draftOutputTokens` bounds every action response, including corrective actions;
`reviewOutputTokens` bounds reviewer verdicts. Both default to bounded values
and accept 64–8192 tokens. The controller's call, tool, context and deadline
limits apply to all three entry points. The caller still owns input admission,
monetary reservations, usage settlement, credentials, tool isolation and
reconciliation after cancellation. `runId` is only a correlation value passed to
that callback; no prompt, completion or usage logging is added.

For adaptive runs, public tool observations can drive the selection callback.
This is a mechanism, not a built-in quality classifier: declare the policy before
evaluation, use a final check when available, and compare against both fixed
models on independently graded tasks. Model choices and tool checks alone do
not establish correctness or a Fusion performance gain.

## What the evidence supports

| Primary source | Relevant result | Engineering consequence |
| --- | --- | --- |
| [RouteLLM, ICLR 2025](https://arxiv.org/abs/2406.18665) | Learned routing between stronger and weaker models can reduce inference cost; its evaluation includes transfer to other model pairs. | Include a one-model router and a fixed-model baseline. More calls are not inherently better. |
| [BEST-Route, ICML 2025](https://arxiv.org/abs/2506.22716) | Jointly chooses model and sample count. Ranking depends on a proxy reward model, which the paper identifies as a limitation. | Compare one cheap sample with multiple cheap samples, and measure selection errors separately from candidate quality. |
| [TRINITY, ICLR 2026](https://arxiv.org/abs/2512.04695) | Uses an approximately 0.6B frozen backbone plus a small trainable routing head to assign roles to larger workers. | A tiny coordinator is plausible. This does not show that tiny workers can replace the large workers. Training still invokes workers to score trajectories. |
| [Sakana Fugu report, June 2026](https://arxiv.org/abs/2606.21228) | Learned orchestration combines multiple frontier agents through adaptive workflows. | Treat Fugu as evidence for a research direction, not a recipe that an untrained voting loop reproduces. |
| [LLMRouterBench, January 2026](https://arxiv.org/abs/2601.07206) | Re-evaluation finds that several routers fail to reliably beat simple baselines, with diminishing returns from larger pools. | Test a small, complementary pool first. Always include fixed-model and random-selection controls. |
| [Is Escalation Worth It?, May 2026 preprint](https://arxiv.org/abs/2605.06350) | In the studied deterministic cascades, longer chains do not yield meaningful held-out gains over optimized pairs. A pre-generation router avoids sunk drafting cost. | Start with two models and an explicit stop rule. Compare direct routing against draft-then-escalate. |
| [RLCascadeRouter, August 2026 preprint](https://arxiv.org/abs/2608.15817) | Optimizes stop/model decisions directly instead of assuming a better quality predictor always makes a better router. | Score the downstream routing decision, not just confidence calibration. RL is a later experiment after enough trajectories exist. |
| [LLMRouter, August 2026 preprint](https://arxiv.org/abs/2608.06867) | Separates context/model encoders, scoring, decision rules and learning signals in a unified evaluation framework. | Keep these parts replaceable. An embedding classifier should not require rewriting execution or accounting. |
| [GitHub Copilot Fusion](https://docs.github.com/en/copilot/concepts/models/copilot-fusion) | Uses Single, Cascade and Critique, accounting for cache boundaries and model availability. | Avoid routine multi-model calls on easy tasks. Preserve cache locality when measuring cost. |
| [Planner-as-Router, September 2026](https://arxiv.org/abs/2609.32917) | Assigns model tiers while planning task dependencies. On 54 enterprise tasks, reports 44% lower cost than all-frontier routing with a 2.9-point accuracy loss; several accuracy differences remain within its confidence interval. | Compare plan-time assignment with fixed workers and a frontier model only at terminal nodes. Count planning cost and lost successful tasks; the reported saving is not lossless. |
| [Cost-Aware Protocol Routing, August 2026 preprint](https://arxiv.org/abs/2608.14927) | Across reasoning tasks, a post-answer probe predicts baseline failures better than it predicts which collaboration protocol will help. Held-out routing leaves substantial gaps from retrospective oracle selection. | Separate failure detection from protocol selection. A reliable difficulty score does not establish that critique, planning or another model call is worth its cost. |

These are results from different datasets, model pools, graders and budgets.
Their headline improvements are not expected ClawRouter gains. Preprints have
less validation than a reproduced, held-out result in this workload.

The next routing experiment should freeze both decisions: when to ask for help,
and which role receives which model. Compare those decisions separately against
a fixed small worker, a fixed strong worker and the same repair loop without
cross-model advice. Keep tasks, public checks and total budgets matched. Report
lost strong-model successes and added correct answers alongside spend. This is
a proposed experiment, not a qualified routing policy or a production change.

## Spend gates

Optional visible function checks live in
`benchmarks/fusion/gateway-verification.mjs`. Pass
`gatewayVerificationCases('stream-stop-match')` or
`gatewayVerificationCases('json-pointer-read')` to the existing sandboxed
`gradeCandidate` helper and record `GATEWAY_VERIFICATION_REVISION` in the
experiment protocol. These checks cover original stop indices after ignoring
empty strings, split Unicode, pointer syntax and array-index boundaries.
Declare the profile before generation and use it for every compared arm.
It supplements public examples; independent hidden grading is still required.
Changing a profile creates a new experiment, not a revision of historical scores.

Local repository calls also record `runtimeTimingsNs` from the local server:
`total`, `load`, `promptEval`, and `generation`, all in nanoseconds.
`runtimeTimingStatus` distinguishes `available`, `missing`, and `invalid` metadata.
Per-task and per-strategy totals stay `null` if any dispatched call lacks valid
timings or a total exceeds the safe integer range. Missing timings never count
as zero. For inference-only comparisons, add `promptEval` and `generation`;
report model loading separately. These server measurements do not replace call
or agent wall time, which includes other overhead. Existing receipts cannot
reconstruct these measurements from `elapsedMs`.

Local repository scores require a completed agent outcome as well as independent
acceptance: `submitted` for legacy and grounded execution, or `verified` for
checked execution. A patch left at a turn limit, deadline, or missing outcome
scores zero even if its final tests pass. The receipt retains the outcome and
acceptance test counts. Checked execution also retains its reproduction and
public-check requirements. Older local receipts can contain passing scores for
unfinished patches; inspect their outcomes before using them as completed repairs.

1. **Offline opportunity, no model calls.** Replay recorded binary outcomes.
   Measure the best fixed model, hindsight union, all-worker cost, and cases no
   worker solved. Hindsight selection is an upper bound, never a deployable score.
2. **Local small-model smoke, no paid APIs.** Use compact candidate-selection
   tasks with known answers, balanced candidate order and explicit abstention.
   Measure invalid JSON, wrong confident choices, order sensitivity, tokens and
   latency. This tests the decision interface; it does not certify code repair.
3. **Qualified cheap execution.** Use small workers on isolated repository
   tasks. Compare one sample, independent samples, deterministic checks and a
   simple escalation policy. Reuse existing sandbox isolation and accounting.
4. **Bounded frontier confirmation.** Freeze the policy on development data,
   then compare on new tasks with the same budget and tools. Pay for frontier
   workers only after earlier stages expose a plausible benefit.

Paired benchmark campaigns stop after incomplete agent tests or acceptance grading.
The checkpoint retains settled usage and the incomplete-run reason; later arms and
tasks do not consume more model calls. Complete assertion failures remain scored
results.

For each stage, predeclare the cases, models, sample count, token limit and stop
conditions. Count failed calls, discarded candidates, selection and verification.
Treat local runtime and energy as real costs; report zero API spend rather than
claiming free inference. Do not tune and report on the same task families.

## Controls worth implementing first

- One small-model decision versus three independent samples with majority vote.
- Two model sizes, both as single-model baselines.
- Small-model abstention/low-confidence escalation to the larger local model.
- Deterministic test selection wherever executable acceptance criteria exist.
- A random or first-candidate baseline, plus a hindsight oracle diagnostic.

Do not start by training TRINITY, adding a third frontier worker, or asking an
expensive judge to grade every cheap draft. Those choices add costs before we
know whether the worker pool contains useful complementary answers.

## Pairwise evidence packing

`scripts/fusion-evidence-packing.mjs` selects a document set from a supplied
linear model over document pairs. It is an offline experiment tool; it does not
read document text, extract features, train a model, call a provider, or change
the production Fusion profile.

Provide every unordered pair exactly once, with indices in ascending order.
Each feature vector must match the head's `weights`, `mean`, and positive
`scale` vectors. The scorer standardizes features, computes pair logits, and
selects the set containing the most total softmax pair mass. Input pair order
does not affect ties; the lowest lexicographic document set wins.

```json
{
  "version": 1,
  "documentCount": 3,
  "limit": 2,
  "head": { "weights": [1], "mean": [0], "scale": [1] },
  "pairs": [
    { "indices": [0, 1], "features": [0] },
    { "indices": [0, 2], "features": [2] },
    { "indices": [1, 2], "features": [1] }
  ]
}
```

```sh
node scripts/fusion-evidence-packing.mjs /path/to/evidence.json
```

This example selects indices `[0, 2]`. The returned `retainedPairMass` is mass
assigned by the supplied model, not a calibrated probability that the selected
documents contain the answer. Do not use it as an accuracy guarantee.

The contract accepts 2–10 documents and 1–32 features. `limit` defaults to four
documents, or all documents when fewer than four are available. It may be any
integer from two through `documentCount`. The CLI accepts one regular JSON file
of at most 2 MiB. Unknown fields, missing or duplicate pairs, nonfinite values,
and arithmetic overflow are rejected. No prompts or answers belong in this file.

Train the supplied head and choose its features on development data. Freeze
them before evaluating a fresh cohort. Compare equal-size sets from lexical,
semantic and relevance-only controls, then measure downstream answer quality,
token use and selector overhead. A retrieval gain alone does not qualify a
Fusion configuration for activation.

## Offline opportunity command

```sh
node scripts/fusion-opportunity.mjs strong,claude 1 \
  /path/to/sol-original/runs.json /path/to/claude-original/runs.json \
  /path/to/sol-transfer/runs.json /path/to/claude-transfer/runs.json
```

The analyzer rejects missing pairs, duplicate rows, mixed splits, non-binary
scores and unsafe cost totals. It retains dataset, grader and configuration
identities. It does not infer matched configurations from a shared strategy
name, read source code, call a model or hide unsuccessful trials.

## Small model selection

[Qwen3-0.6B](https://huggingface.co/Qwen/Qwen3-0.6B) is a candidate for testing
the tiny-controller interface. The available cached
[Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)
provides a larger local comparison. Record the exact local model digest and
generation settings; a mutable model tag is insufficient provenance.

The [Ollama chat API](https://docs.ollama.com/api/chat) supports a JSON schema,
token counters and model-specific thinking controls. Use only a loopback server,
explicit local model names and bounded requests. Keep model responses in memory;
retain only finite labels, correctness, counts, timings and hashes. Never execute
model-generated code on the host. Repository execution still requires the
qualified isolated runner.

## Compact repository actions

Local repository runs with the `legacy` execution profile can opt into a compact
action schema with `FUSION_LOCAL_ACTION_SCHEMA_PROFILE=compact`. The default
schema profile remains `legacy`; `grounded` and `checked` execution reject the
compact option because they use a different action protocol.

The compact schema puts `action` before the other fields and `memory` last. It
limits working notes to 512 characters, paths to three, edits to eight and query
text to 4,096 characters. The prompt also names the shorter memory limit. These
are generation constraints; existing tool validation, deadlines, accounting and
final acceptance still apply. Shorter notes and probes may reduce repair quality,
so compare profiles as separate protocols. Receipts record
`settings.actionSchemaProfile`.

An initial diagnostic with one pinned local Qwen3.5-9B prompt exhausted 1,024
output tokens inside the original schema's first `memory` field. Reordering and
bounding the fields produced a complete edit action in 213 output tokens. This
is evidence about that request's output format, not a repository repair or Fusion
quality result. Both generation order and field limits changed together.

```sh
FUSION_LOCAL_ACTION_SCHEMA_PROFILE=compact \
GITHUB_SHA=$(git rev-parse HEAD) \
node scripts/fusion-local-repository.mjs \
  /path/to/qualification.json /path/to/results \
  local-general-model local-coder-model legacy /path/to/workloads.json
```

## Local selector smoke

Start a task-owned Ollama server on a free loopback port. Load local models
separately; the runner never pulls models or chooses a cloud model. Then run:

```sh
GITHUB_SHA=$(git rev-parse HEAD) node scripts/fusion-selector-smoke.mjs \
  /path/to/fresh-results qwen3:0.6b qwen3:4b-instruct-2507-q4_K_M
```

One model is also supported to compare its first sample with a three-sample
vote. With two models, put the smaller model first. The second model is sampled
once per case. The fixed confidence cascade accepts the first decision only if
it selects a candidate with confidence at least 80; otherwise it uses the second
model. These policies replay the same recorded responses. They do not tune a
threshold on the results or claim online latency savings.

The 48 hand-authored cases cover 12 contract families with three candidate-order
variants and one all-incorrect variant per family. Reference tests validate the
candidate implementations independently of model responses. The smoke tests
selection and abstention, not candidate generation, sandboxed execution, or
production quality. One lucky run cannot qualify a learned router.

Each request is bounded to 96 output tokens, 4096 context tokens and one minute.
A full two-model run makes at most 192 requests and has a 15-minute campaign
deadline checked before each call. There is no automatic transport retry.
HTTP, identity or usage failures and recognized safety notices stop the run.
Completed outputs record finite decisions, token counts, timing and hashes;
raw prompts, responses and reasoning are not retained.

## First local result: reject the naive policies

A corrected run on 2026-11-05 used source
`4cfd541b80841c9e24309ceeb95239a96d197d69` and corpus SHA-256
`468430f851c409aa57d42cc04248b99f291b114afc1d932f18dff001d69b1a4c`.
Each model generated three samples per case: 288 local calls total, zero paid
API spend. The cascade reuses sample zero from each model; it is a replay.

| Policy | Correct / 48 | Replay calls | Replay tokens |
| --- | ---: | ---: | ---: |
| Always abstain (fixed control) | 12 | 0 | 0 |
| Qwen3 0.6B, one sample | 12 | 48 | 7,432 |
| Qwen3 0.6B, three-sample vote | 12 | 144 | 22,310 |
| Qwen3 4B Instruct, one sample | 33 | 48 | 6,956 |
| Qwen3 4B Instruct, three-sample vote | 32 | 144 | 20,905 |
| 0.6B to 4B, confidence-80 cascade | 33 | 92 | 13,836 |

The 0.6B model rejected 10/12 all-incorrect cases but solved only 2/36 cases
with a correct candidate. The 4B model solved 32/36 of those cases but rejected
only 1/12 all-incorrect cases. Fourteen wrong 4B decisions reported confidence
at least 80. The cascade escalated 44/48 cases and added no correct answers.
All responses met the finite decision schema.

Model pins: `qwen3:0.6b` at
`7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435`, and
`qwen3:4b-instruct-2507-q4_K_M` at
`0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0`.
Thinking was disabled; generation settings are those in the runner above.
These are untrained prompted selectors, not trained TRINITY coordinators.
An earlier 4B run used an incorrect fixture and was invalidated, not included.

Do not promote these policies. The next experiment should select generated
patches with executable tests in the qualified isolated runner, compare against
one small worker, and include all-fail tasks. Freeze the policy before evaluating
fresh task families. Require a gain over the best fixed worker at the same total
budget, including verification and failed calls, before frontier confirmation.
Keep production Fusion opt-in until a held-out coding comparison earns promotion.

## Local generation with executable checks

`scripts/fusion-execution-smoke.mjs` tests eight fresh, small development
families. It generates one tiny-model draft and two small-model drafts per task.
The fixed policies compare the first small draft, public-test selection between
two small drafts, and public-test selection between the tiny draft and the first
small draft. Each retry policy stops at the first public pass; hidden grading
does not influence selection. These are equal maximum attempt counts, not equal
monetary or compute budgets. Report tokens and selection-check counts separately.

```sh
GITHUB_SHA=$(git rev-parse HEAD) node scripts/fusion-execution-smoke.mjs \
  /path/to/fresh-results node@sha256:PINNED_DIGEST \
  qwen3:0.6b qwen3:4b-instruct-2507-q4_K_M
```

Use the local loopback Ollama server and a cached, digest-pinned Node image.
The runner builds a minimal dependency-free image. Before generation, every
reference must pass both test sets and every deliberately flawed implementation
must pass public tests while failing withheld tests. CI runs this qualification.
The generator sees the contract and two examples, never the withheld inputs.

Generated modules execute only in fresh, unprivileged Docker containers with
network disabled, read-only root, no host mounts, resource limits and a four-second
evaluation watchdog. Expected values stay in the parent grader. Candidate
stdout cannot declare its own test result. The report retains verdicts, hashes,
usage and timing; generated modules and raw model responses are not retained.

The run makes 24 local calls, limited to 512 output tokens each. Its 15-minute
generation-loop deadline is checked before each call; fixture qualification is
separate. Invalid or failed candidates count against their policy. Transport,
identity, usage or infrastructure failures stop the campaign without retry.
These tasks test generation and verification mechanics, not repository repair.

The first run (2026-11-06, source
`51f0a281526f8c562cbeb8a06e7fe13a8b75a643`, corpus
`1360aa974eb4a3dd2799ee17bb19402e6f4cede0557d93fa47f7c709d841f02b`)
completed all 24 calls at zero API spend using the same Qwen model pins above.

| Policy | Solved / 8 | Wrong accepted | Replay calls | Replay tokens |
| --- | ---: | ---: | ---: | ---: |
| 4B first draft | 4 | 4 | 8 | 2,626 |
| Up to two 4B drafts, public-test selection | 4 | 2 | 10 | 3,334 |
| Tiny then 4B, public-test selection | 4 | 2 | 16 | 4,648 |

The tiny model solved none of the tasks. Even hindsight selection across the
two 4B samples solved only four: no selector could recover an additional win
from this pool. Public checks rejected two wrong answers, but still accepted
two others that failed withheld cases. More samples and the tiny first stage
did not improve correctness. Improve worker capability and test coverage before
adding orchestration. A later output-limit handling fix does not affect these
results: no candidate in this complete run hit the output limit.

## Local repository repairs

`scripts/fusion-local-repository.mjs` runs the existing repository action harness
against the four development tasks in `validation-workloads.json`. It compares
a general local model, a coding local model, and a coder-to-general handoff.
Each arm gets at most eight actions, 1,536 output tokens per call, a 32,768-token
context and three minutes. The handoff uses the existing early-submit or
two-thirds-turn transfer rule. Task order rotates the three arms.

```sh
GITHUB_SHA=$(git rev-parse HEAD) node scripts/fusion-local-repository.mjs \
  /path/to/transfer-qualification.json /path/to/fresh-results \
  qwen3:4b-instruct-2507-q4_K_M qwen2.5-coder:3b-instruct-q4_K_M
```

Run from a clean committed checkout. Qualification must match each task digest,
have a passing oracle and failing broken baseline, and identify cached immutable
Docker images. A passing repair must execute the same test and skipped-test
counts as the qualified oracle. The runner does not download models, images or dependencies.
The local transport validates both model identities before execution and checks
their digests again afterward. Each model pin also records the Ollama server
version, optional renderer/parser names and template source, and SHA-256 hashes of
the chat template and any reported default parameters. Raw templates and parameter
text are not saved. Missing parameter metadata is recorded as null. Both named renderers and
older Go-template servers are supported. Runtime, default-parameter or thinking-capability changes
at the final check leave the run incomplete; these start/end checks cannot detect
a transient change that is reverted between checks. It never invokes a paid provider. Role labels
inside the reused harness map explicitly to these local model pins.

Set `FUSION_LOCAL_OUTPUT_TOKENS` to an integer from 1 through 8,192 to change the
per-call output allowance. The default remains 1,536. The campaign passes this
allowance to its agents and transport and records it in `settings.outputTokens`.
The 32,768-token context limit stays fixed; admission reserves the requested output
before dispatch. Compare runs with different allowances as separate protocols.
Programmatic callers use `runLocalRepository({ outputTokens })`; direct transport
callers set `localActionRequest({ maxOutputTokens })` and request no more than that
allowance in `body.max_tokens`.

Set `FUSION_LOCAL_REQUEST_TIMEOUT_MS` to an integer from 1 through 300,000 to
change the per-request deadline independently of sampling. Defaults remain
60,000 ms for legacy and 120,000 ms for grounded/checked profiles. The campaign
records the effective value in `settings.requestTimeoutMs`; its trial and
campaign deadlines still apply. Programmatic callers pass `requestTimeoutMs`
to `runLocalRepository` or `localActionRequest`. Declare a changed deadline as
part of the experiment protocol. An expired request fails its trial and retains
unknown usage; unrelated transport failures still stop the campaign.

A conservative input-byte bound rejects oversized contexts before dispatch.
Truncation, context limits and trial deadlines produce unsuccessful trial rows;
transport, identity, usage and infrastructure failures stop the campaign. There
is no fallback after a safety notice. Reports distinguish attempted actions from
dispatched requests, retain tokens and finite action outcomes, and omit prompts,
completions and patches. The same isolated acceptance grader checks every arm.

These are previously used development tasks, not a new holdout. Equal turn caps
do not imply equal token, latency or compute costs. Use the measured totals and
error categories to decide whether a larger fresh-task comparison is warranted.

### Coding-specialist results, 2026-11-06

Both runs used source `7a578df60b3efb30ca6a76e0c2f62a64ffb55712`, the
same 4B pin above, and `qwen2.5-coder:3b-instruct-q4_K_M` pinned to
`f72c60cabf6237b07f6e632b2c48d533cef25eda2efbd34bed21c5e9c01e6225`.
The function corpus was unchanged from the first execution run.

| Function policy | Solved / 8 | Calls | Tokens |
| --- | ---: | ---: | ---: |
| Coder 3B first draft | 2 | 8 | 2,197 |
| General 4B first draft | 4 | 8 | 2,626 |
| General 4B public-test retry | 4 | 10 | 3,334 |
| Coder then general, public-test selection | 4 | 13 | 3,984 |

The two verified policies each accepted two incorrect answers and abstained on
two cases. Hindsight selection across all generated candidates still solved
only four. The coding specialist added no unique solved cases. The complete
screen used 24 actual calls and 7,375 tokens; table rows replay overlapping
candidates and must not be summed as campaign spend.

| Repository arm | Solved / 4 | Dispatched calls | Tokens | Trial outcomes |
| --- | ---: | ---: | ---: | --- |
| General 4B | 0 | 14 | 43,715 | One truncated, two context limits, one turn limit |
| Coder 3B | 0 | 32 | 50,445 | Four turn limits |
| Coder-to-general handoff | 0 | 26 | 49,915 | Two truncated, one context limit, one turn limit |

All twelve repository trials completed recording. There were 75 attempted
actions, 72 dispatched calls and 144,075 reported tokens, with no unknown
usage. Three actions were rejected before dispatch by the context limit. Both
campaigns used zero paid API inference; local compute and downloads still cost
resources.

These results do not establish that the models cannot repair repositories.
The fixed harness exposed repeated non-matching edits, insufficient output
space and conservative context limits. They do establish that this pool and
handoff do not justify a paid expansion yet. Next, compare an unchanged
baseline against a scaffold that requires source inspection before editing,
uses bounded source ranges and preserves compact state across handoff. Measure
valid edits, executable probes and limit failures as well as final solves.
Freeze that policy before a fresh-task evaluation; keep production Fusion opt-in.

### Grounded repair scaffold

Function-smoke summaries include both fixed-model controls: `tiny-single` for
the first pinned model and `small-single` for the second. These are positional
policy labels; consult the model pins for actual model names and sizes. Compare
a mixed policy against the stronger control, not only the second model. A mixed
policy that always accepts the first model has not demonstrated a fusion gain.

Append `grounded` to the local repository command to use a compact repair
interface. It supplies numbered current source windows on every turn, requires
line replacements to match observed current source, and gives the next worker the current edited
source with bounded tool feedback. `inspect` selects another window; `probe`
runs in the same isolated environment. The original `legacy` profile remains
the default. Both profiles use the same action, output and total trial deadline
caps. The grounded profile uses explicit sampled non-thinking generation
(`temperature=0.7`, `top_p=0.8`, `top_k=20`, `min_p=0`, presence penalty 1.5,
repeat penalty 1), following the [Qwen3.5 model-card recommendation](https://huggingface.co/Qwen/Qwen3.5-4B).
Its per-call timeout is 120 seconds inside the unchanged 180-second trial cap;
legacy retains 60 seconds and greedy generation. Cross-profile comparisons
therefore measure both interface and sampling changes.
An optional final argument selects another qualified task manifest; receipt
digests and oracle test-count checks still apply.

This experiment draws on [Agentless](https://arxiv.org/abs/2407.01489), which
separates localization, repair and validation, and [Aider's editing
formats](https://aider.chat/docs/more/edit-formats.html), which separate concise
edits from full-file output. [SWE-agent's interface
design](https://swe-agent.com/latest/background/aci/) motivates bounded source
views. [SWE-Protégé](https://www.cs-pk.com/preprint-swe-protege-meta.pdf) studies
trained selective expert collaboration; its result does not establish that an
untrained small model will benefit from a handoff here.

First compare the grounded single-model and handoff arms on the existing
development tasks. Improvement over the legacy scaffold is a harness gain,
not evidence of model fusion. Fusion must beat the best grounded fixed-model
control on new tasks, with total model calls and tokens included.


### Reproduction-gated local profile

Use `checked` in place of `grounded` to require a failing reproduction before
editing. The first worker gets at most three actions to inspect or produce a
Node assertion of the reported behavior. The harness supplies `assert` and
each editable module as `source0`, `source1`, and so on; the model writes the
JavaScript check body. A passing probe, import failure or
syntax error does not qualify. Each probe executes in a fresh disposable
sandbox; its writes cannot change the repair workspace.

Low-level callers can use `probe(box, source, timeout, { filterLoaderAssertions: true })`
to classify wrapped Node loader and parser diagnostics as invalid probes rather
than behavioral assertions. The option defaults to `false`. This conservative
output heuristic preserves assertion expectations that merely mention an error
code; it does not authenticate generated tests or establish complete coverage.

Once a reproduction fails with an assertion on the original source, freeze it
and allow repairs. Rerun it on each candidate in another disposable sandbox.
Submit automatically only when the reproduction and visible tests pass. Hidden
acceptance tests still decide correctness: a model-generated check can be weak
or wrong. Reports expose both the public gate and hidden result without storing
probe source. The handoff arm assigns reproduction to the first model and repair
to the second; fixed-model controls use the same phases and budgets.

The completed preceding grounded development run solved 0/4 tasks in all three
arms: Qwen3.5 4B used 8 calls and 37,925 tokens; Qwen3 4B used 32 calls and
127,978 tokens; old-to-new handoff used 32 calls and 132,030 tokens. All 72 calls
had complete usage and zero paid API spend. This negative result motivates a
verification loop; it does not establish a fusion benefit. Evaluate the new
policy on development tasks before using the separately qualified fresh set.

### Independent review of a checked candidate

The programmatic grounded agent also accepts `strategy: 'review'` with
`requireReproducer: true`. The first model reproduces and repairs the issue.
After its probe and visible tests pass, or after three author actions, the
second model takes over and reviews the candidate against the complete issue.
If no reproduction exists, the second model gets up to three actions to create
one within the shared budget. It can inspect, edit, or finish. A review edit or
submission reruns the frozen probe and visible tests. Both phases share the
same turn and deadline limits; `reviewed` stays false until review succeeds.

This is an experimental benchmark strategy, not a production endpoint mode.
A failing baseline assertion may also fail on correct code, and a passing
candidate can omit requirements. Independent review adds a check, not a proof.
Continue scoring with withheld acceptance tests and comparing both fixed-model
controls; count all author and reviewer calls in cost and latency.

The Bedrock development task explicitly includes supported aliases of the
canonical image model. Earlier runs using the shorter canonical-model wording
are a different task revision and must not be silently combined with these
results. Neither revision is an unseen validation task.

Grounded repair workers can inspect up to 32 declared relative source imports
under `worker/` and `shared/`. Imports discovered in inspected modules extend
that bounded list. Test directories, hidden tests and paths outside those
source roots remain excluded. Dependencies are read-only; only the original
editable paths accept changes. The action schema lists readable paths so an
agent does not have to guess which navigation requests the harness permits.

Grounded workers retain a nonempty bounded working summary between turns and across a
handoff. The notes are untrusted, limited to 2000 characters and 4096 bytes,
and excluded from benchmark reports. This preserves discoveries without
retaining full transcripts or rereading each dependency on every turn.

### Compatible visible tests

Qualification now requires `oracleVisible`: the known source repair must pass
the original visible tests before acceptance tests replace any same-named
files. Regenerate older qualification receipts before running models. A passing
updated acceptance suite alone does not prove that visible feedback is valid.

The Copilot catalog-identity task was removed from the original corpus; the
Cerebras redirect-mode and MiniMax regional-availability tasks were removed
from the fresh corpus because their original visible tests reject the known
repair. Earlier scores involving those tasks are not reliable comparisons.

## Native planner/editor comparison

Set `FUSION_PAIR_POLICY=draft-sampling` for a cheap sampling control. It makes
two independent single-call drafts from the original source, then selects the
first submitted draft that passes visible tests, in fixed order. If neither
qualifies, the cheap agent repairs from the original with the remaining shared
allowance. There is no judge or hidden acceptance feedback. Both fixed-model
controls remain present; this policy requires at least three shared calls.

To compare with executable probe selection, freeze the same tasks, repetitions,
model pins, call cap (at least four), token cap, deadline and spend budget for
both policies. Report actual cost, including unused allowance, and preserve
every attempted draw. Run each policy with its controls and compare the
declared candidate arms; do not pool distinct policies as repeated blocks.
This control measures whether executable selection adds value beyond two
cheap drafts. It does not establish mixed-model benefit by itself.

Single-draft visible tests get at most 30 seconds within the remaining trial
deadline. Test execution uses an in-container watchdog that kills the process
group before the Docker client deadline. A killed or incomplete test run never
counts as a visible pass; infrastructure errors still stop execution.

Set `FUSION_PAIR_POLICY=probe-selection` for an experimental executable
comparison. Two independent one-call cheap drafts start from the same source.
If both submit, pass visible tests, and differ, one cheap call writes a behavioral
probe from the requirements, original source, declared context and bounded
candidate previews. The same probe runs on three fresh sandboxes. Selection
requires an assertion failure on the original, exactly one passing candidate,
an assertion failure on the other, and unchanged editable source after execution.
Import/runtime failures, ambiguous outcomes, invalid probes, duplicate drafts
and incomplete drafts abstain. Strong repair then starts from the original
source with the remaining allowance.

This policy requires at least four shared calls and retains both fixed-model
controls. All draft, author and fallback calls share the existing time and spend
caps; uncertain charges and provider refusals stop the run. Receipts contain
probe digests, snapshot outcomes and candidate digests, not generated source or
probe text. Final acceptance remains independent. A generated probe can still
test the wrong property or reject a correct repair; these guards do not certify
test quality. No quality, cost or latency improvement is established. Before a
gain claim, compare against equal-call sampling/retry and measure generated
probes against accepted and rejected repairs without feeding grading results
back into inference. After a successful policy run, the runner grades both
candidates independently and replays the generated probe on the pinned accepted
reference in a fresh sandbox. `probeDiagnostics` records candidate acceptance,
reference-probe status and diagnostic elapsed time. Candidate source and probe
text remain in memory and are consumed once. Diagnostic errors stay unknown;
they neither replace the selected repair nor alter its final acceptance score.
Diagnostic time is reported separately and excluded from trial elapsed time,
so it does not penalize the policy in latency comparisons. No additional model
calls are made.

Use the existing repository agent with two fixed-model controls and one
architect policy. The architect spends one call on a strong-model source plan;
the cheap model executes the remaining actions. The plan consumes one of the
same total calls available to each control. All calls and failed attempts count
against the trial and campaign budgets. This is an experimental policy, not a
claim of improvement.

Set `FUSION_PAIR_POLICY=edit-handoff` to test an execution handoff instead of
an up-front plan. The strong model starts the repair. After its first edit
passes the visible tests, the cheap model receives the current source and
working notes and continues verification or repair. A submission before that
point also requires a successor turn. Failed edits do not trigger a handoff,
and the ordinary turn-based handoff threshold is disabled for this policy.
Both workers share the same total call, time and spend limits. Passing visible
tests selects a handoff point; it does not certify correctness. Independent
acceptance still scores the final patch. This policy is experimental and needs
matched quality, cost and latency measurements; the default remains `architect`.

The handoff also includes the latest executed behavior probe and its pass/fail
result when the source is at most 8 KiB. This is untrusted context that may
predate the last edit, not acceptance evidence. The successor must inspect its
coverage and rerun it against current source. An oversized latest probe is
omitted in full; an older probe is not substituted. Raw probe source and output
are not added to benchmark receipts.

The successor receives verification-specific instructions and the current source
snapshot. Its task context retains the read-only repository context but omits the
initial editable-source preload. It must check task invariants and repair concrete
failures, then submit when verification is complete. It keeps the full remaining
allowance; there is no forced early submission. Probe-use receipts require a
successful model response to context that includes the transferred probe.

Set `FUSION_PAIR_POLICY=completion-handoff` to keep the strong model until it
calls `finish`, then transfer its current candidate, notes and latest bounded
probe to the cheap verifier. Passing edits and the ordinary turn threshold do
not trigger this transfer. `finish` is a submission signal, not proof that the
repair is complete: even a candidate with failing visible tests goes to the
successor for repair. The successor receives the same verification instructions
as `edit-handoff` and uses only the calls, time and spend still available. If the
primary exhausts the allowance, there may be no successor call; inspect recorded
model calls before claiming a mixed run. Controls remain uninterrupted cheap and
strong runs, and the report records this as a separate policy. This experimental
comparison requires controls; repair export and control-free execution remain
limited to the existing qualified `edit-handoff` mode. Do not pool the policies.

Interrupted native pair and workload benchmark receipts retain a bounded
`failureTrace` for the failing agent: the last 120
completed action labels/statuses, timing/counters and handoff/probe-use flags.
It excludes source, notes, prompts, completions, probe text/output and exception
messages. The executor supplies this trace through an internal identity map;
properties supplied by an arbitrary thrown error are ignored. A handoff flag
records a transfer event, not proof of a successor call: use the call ledger to
verify actual model mixing. Trace retention does not accept the candidate or
resume execution. Failed rows stay failed, unknown charges keep their full
reservation, and budget/refusal stop behavior is unchanged.

Native OpenAI benchmark calls also save a unique `clientRequestId` before
sending `X-Client-Request-Id`. Receipts retain `providerRequestId` from
`x-request-id` when it contains only letters, digits, underscores or hyphens
and is at most 128 characters. Other values are discarded. The response ID is
captured before body parsing, including HTTP failures. A transport failure
retains the client ID and unresolved cost reservation. No other headers or raw
error bodies are retained, and correlation does not enable retries or settle
unknown charges. See [OpenAI request debugging](https://developers.openai.com/api/reference/overview#debugging-requests).

Set `FUSION_PAIR_POLICY=matched-handoff` to compare the cheap successor against
a strong successor using the same handoff point, verification instructions,
current-source context and shared limits. The cheap-only arm stays unchanged.
The report records `matched-handoff` as its policy, `strong` for the unmixed
control and `edit-handoff` for the mixed candidate. This control separates model
selection from the effect of changing the execution protocol. Do not pool it
with ordinary `edit-handoff` blocks as one repeated protocol.

Set `FUSION_HANDOFF_EVIDENCE=1` with `edit-handoff`, `completion-handoff` or
`matched-handoff` to also transfer recent test and probe results. The default
keeps the existing notes-and-probe interface. The opt-in retains at most eight
results and 16 KiB of serialized history, with each feedback excerpt capped at
2 KiB of UTF-8. Records preserve execution order and pass/fail outcomes, separate
from model-written notes. Program output remains untrusted, and old results may
precede later edits; the successor must verify the current source.

For `matched-handoff`, both the strong successor and mixed-model candidate get
the same interface. Calls, output limits, deadlines and spend limits stay shared.
Receipts record the option, transferred record count and whether a completed
successor call received those records; they never retain the feedback text.
Keep this interface as a separate experimental condition. Its implementation
does not establish a quality or cost improvement.

To run only the qualified handoff policy after evaluating it, set
`FUSION_PAIR_POLICY=edit-handoff` and `FUSION_PAIR_CONTROLS=0`:

```sh
FUSION_PAIR_POLICY=edit-handoff FUSION_PAIR_CONTROLS=0 \
  FUSION_CHEAP_REASONING=medium \
  node scripts/fusion-pair-benchmark.mjs qualification.json tasks.json pair-config.json output-directory
```

This mode runs one repair per task, without paid baseline calls. It still requires
qualified tasks, preserves the shared call/time/spend limits, and scores each
repair with independent acceptance. Its `pair.json` has kind
`native-policy-repository`; the paired analyzer rejects it because it contains no
comparison. Keep controls enabled when measuring a gain. This is a sandboxed
repository experiment, not a policy for the public `clawrouter/fusion` chat model.

Add `FUSION_EXPORT_REPAIRS=1` to that handoff-only command to retain each accepted
repair as `<task-id>.repair.json` in the private output directory. Export is off
by default. These files contain generated source: keep them private and review
them before applying changes. Nothing is applied to the caller's checkout.
Each bundle records the task's base commit, executor source commit, task and
qualification digests, generated files and their digest. The content-free run
receipt records the bundle filename, byte count and SHA-256 digest.

Export requires passing visible and independent acceptance checks. Failed
repairs are not exported. Bundles contain at most 32 allowed editable files,
256 KiB per file and 4 MiB total. On POSIX, files use mode `0600` in the run
directory created with mode `0700`. An existing export is never replaced. A write failure
stops the run as `repair_export_failed`, while retaining its acceptance result
and accounting. This option does not turn the historical repair fixture into
a general-purpose coding agent or establish additional quality evidence.

Verify a saved repair without another model call:

```sh
node scripts/verify-fusion-repair.mjs qualification.json tasks.json output-directory/pair.json output-directory/example-task.repair.json
```

Use the exact manifest and qualification files from the export. The command
checks task, base, executor-source, qualification and file digests against the
accepted run. It rejects incomplete runs and altered or out-of-scope files before
starting a sandbox. It then reruns visible tests and independent acceptance in
fresh isolated sandboxes using the already-qualified local image and pinned Git
history. Missing images or history fail; the command does not rebuild fixtures.
Its JSON summary contains no source or test output. A failed check exits nonzero.

This checks consistency of supplied provenance, not its authenticity or cost
accounting. Passing applies to the pinned task base; it does not establish that
the repair works on a different checkout. The command does not apply files.

Add `--patch review.patch` to export a private unified Git patch only after
both verification phases pass. It uses the verified source snapshot and the
pinned base, preserves executable bits and end-of-file newlines, and does not
overwrite an existing output. The patch can contain up to 16 MiB of source;
keep it private, inspect it, and run `git apply --check /path/to/review.patch`
from the intended target checkout before deciding whether to apply it.
The command does not apply the patch. Its JSON receipt contains only the
patch filename, size and digest. A delivery failure sets `patchExportFailed`
and exits nonzero while preserving the separate acceptance result.

Run from a committed task checkout with qualified workload receipts and an
explicit JSON configuration. Only credentials for the selected models are
required. Supply credentials through the existing secret injector; do not put
them in configuration files.

```sh
node scripts/fusion-pair-benchmark.mjs qualification.json tasks.json pair-config.json output-directory
```

For interactive pair runs, set `FUSION_PAIR_ACTION_SCHEMA_PROFILE=compact`
to use the existing bounded action schema. It limits each response to eight
edits and twelve path selectors, and puts the action before working notes.
The setting applies to both fixed-model controls and the fusion arm and is
recorded in `pair.json`. Repeat analysis rejects mixed schema profiles; old
receipts without the field retain their legacy meaning. The default remains
`legacy`. Single-draft, contract,
probe-selection and draft-sampling executors reject `compact` because they
use separate action contracts. Freeze this setting before comparing runs;
changing it does not establish a quality improvement.

The configuration must contain every field below. Set `priorCostMicros` to the
campaign's accumulated spend and unresolved reservations before starting.

```json
{
  "cheap": "openai/gpt-6-luna",
  "strong": "openai/gpt-6.1-sol",
  "maxCalls": 12,
  "outputTokens": 8192,
  "deadlineMs": 300000,
  "trialBudgetMicros": 1000000,
  "campaignBudgetMicros": 100000000,
  "priorCostMicros": 0
}
```

`pair.json` records exact source and dataset digests, declared splits, model
pins, both controls, action metadata, acceptance counts, elapsed time and actual
usage-based charges. It excludes prompts, completions and generated source.
Set `FUSION_PAIR_ARM_OFFSET` to a zero-based arm index to change the starting
arm for a repeated block. The default is `0`; a three-arm comparison accepts
`0`, `1` or `2`. Execution rotates by this offset plus the task index while
strategy labels and scoring stay fixed. Predeclare offsets before inference;
receipts and analysis retain them, and repeated analysis allows different
offsets under the same model/scoring protocol. Two blocks cannot fully balance
three arms, so rotation alone does not remove all order or cache effects.

Each call saves `requestDigest` (SHA-256 of the exact serialized provider body),
UTF-8 `requestBytes`, and the input-message `promptDigest` before dispatch.
These fields remain available on HTTP or transport failures without retaining
request content or credentials. They identify a prepared request, not proof of
provider receipt or billing; unresolved charges remain reserved.
Single-block analysis reports cost savings versus strong, summed elapsed time,
latency ratio, and whether cheap dominates the candidate on observed quality,
cost and time. Missing or invalid time leaves latency and dominance unknown.
Actual call identities distinguish mixed attempts and rescues from single-model
resampling; neither savings nor a passing public check establishes a fusion gain.

`controlJointOutcomes` separates cases where both controls passed, only cheap
passed, only strong passed, or both failed. Each group counts candidate passes
and failures. This exposes candidate rescues beyond the observed control oracle
and losses on cases at least one control solved. Repeat reports sum attempts;
they do not turn repeated cases into independent tasks.

This follows two useful research distinctions: [COMED](https://arxiv.org/abs/2609.26913)
measures collaboration rescues against harms, while the [co-failure study](https://arxiv.org/abs/2606.27288)
bounds selection among existing answers by their shared failures. A candidate
pass when both controls fail is an observed rescue, not proof that collaboration
caused it; a matched single-model retry can also succeed. These descriptive
counts do not change the pilot gate or establish statistical significance.

New paired-call receipts include `usageBreakdown`: disjoint uncached input,
cache-read input, ordinary cache-write input, one-hour cache-write input, and
output token counts. Use each model pin's `usagePrice` tariff for these buckets;
`price` is the conservative reservation tariff. One-hour writes use twice the uncached input rate. Output counts already include
reasoning tokens. The existing top-level input count retains its provider's
semantics. Older receipts without a breakdown cannot reconstruct cache discounts;
missing cache counts must not be interpreted as zero. These are tariff estimates,
not provider invoices.

An unknown charge retains its reservation and stops the campaign. Provider
refusal also stops the campaign, without retry or model fallback.

The [Aider architect/editor work](https://aider.chat/2024/09/26/architect.html)
is the rationale for separating reasoning from edits. Validate this model pair
on fresh tasks before treating a development improvement as a useful result.

The cheap Luna worker defaults to `none` reasoning for the original low-latency
comparison. Set `FUSION_CHEAP_REASONING=medium` explicitly to calibrate its
reasoning capability before drawing conclusions about model coordination. The
checkpoint records the setting. These actions use structured text, not Chat
Completions function calling; the latter requires `none` for Luna. Compare both
quality and total cost rather than assuming that disabling reasoning saves money.


Set `FUSION_PRELOAD_SOURCE=1` for a paired ablation that gives every arm the
same bounded initial editable source. The default remains tool-driven source
inspection. Reports record the setting. A handoff receives a fresh source
snapshot; compare against preloaded fixed controls before attributing savings
to multiple models rather than avoided file-reading calls.
### Prospective repair holdout

`benchmarks/fusion/holdout-workloads.json` pins two additional historical
repairs: SigV4 query canonicalization and opaque Responses input accounting. The loader's `development` label keeps its
existing schema; experimental reports must separately record whether a task
was exposed before a policy was frozen. A filename is not proof of an unseen
evaluation set.

Qualify every task with the oracle-visible contract before model inference.
Freeze the policy and training examples first, retain both fixed-model controls,
and report incomplete attempts and transport reservations. Do not tune against
acceptance failures and then describe the same tasks as held out.

Literal source inspection reports `queryMatched: false` with no replacement source when a query has no match. Search text is literal; use a shorter query or an explicit line number after a miss.


### Bounded source pages for interactive benchmarks

Set `FUSION_SOURCE_PAGE_LINES=200` (API: `sourcePageLines: 200`) to limit initial
source, handoff source, and each read window to 200 lines per file. Use literal
search to locate code and explicit `file.ts:start-end` reads to inspect later
pages. Each read retains its starting line, total line count, and truncation
flag. Search keeps its existing match limits; paging is not a token-budget
estimate or permission to weaken the spending guard.

Literal source search returns at most 12 matches per file. A clipped result sets
`truncated: true` and `nextLine` to the first omitted match. Continue with the
same query and `file.ts:nextLine-totalLines`. Search ranges also bound the
returned context; they are independent of the read-page size.

The option accepts integers from 1 through 400. It is available only for the
interactive edit-handoff, completion-handoff, and matched-handoff
policies, with the same setting applied to every comparison arm. Unset retains
existing behavior. Receipts include the setting, and repeat analysis rejects
mixed page sizes or paged/unpaged runs. A changed setting needs a new comparison;
no model-quality gain has been measured for paging.


### Optional native Responses transport

The native benchmark registry also accepts `openai/gpt-6.2-sol` and
`openai/gpt-6.2-astra` as explicit model choices. Existing defaults stay unchanged.
Their Standard short-context tariffs were checked on 21 November 2026:
Sol costs $2 input / $10 output per million tokens; Astra costs $8 / $40.
Cached input and cache writes use their separate published rates, with
cache-write prices included in conservative reservations. The existing
200,000-input-token ceiling rejects long-context pricing that is not qualified.
See the [Sol model card](https://developers.openai.com/api/docs/models/gpt-6.2-sol)
and [Astra model card](https://developers.openai.com/api/docs/models/gpt-6.2-astra).
Selecting these models enables benchmarking; it does not establish a fusion gain.


Set `FUSION_OPENAI_API=responses` for the native pair benchmark to send OpenAI
calls through `/v1/responses`. The default remains `chat-completions`; Anthropic
transport is unchanged. The route is recorded as `openAiApi`, and repeated-run
analysis rejects mixed routes. Missing route metadata means the legacy default.

The adapter maps the same messages and JSON schema, requests `store: false`, and
uses `max_output_tokens` for both dispatch and conservative budget reservations.
It settles qualified usage even when an answer is truncated or refused.
Truncation fails the arm; refusal stops the campaign, matching the existing rules. Invalid usage, HTTP failures, and unpriced tool or long-cache
charges preserve the unknown-charge reservation. Reasoning text is not passed to
the executor or retained in the receipt. Commentary messages are excluded from
structured actions; one completed final-answer message (or legacy message with
no phase) is required. Ambiguous final answers are rejected. No automatic retry or API fallback runs.

This option enables a separately declared transport experiment. It does not
establish that Responses fixes earlier Chat Completions errors, and results from
different routes must remain separate. See the [Responses API contract](https://developers.openai.com/api/reference/python/resources/responses/methods/create).


## Accounting cleanup evaluation task

`benchmarks/fusion/cleanup-error-workloads.json` adds a pinned real repair for
reservation rollback diagnostics. Only `worker/accounting.ts` is editable.
The original accounting tests are visible; final verification replaces that
same test path with the repaired revision's extended suite in a fresh sandbox.
Qualification must show the original tests pass both source revisions, the
extended suite rejects the original, and the repaired source passes it.

This task has not been used for model inference at introduction. It remains a
development task; once used for tuning it cannot support an unseen validation
claim. The supplied instruction is the behavioral contract, not access to the
reference source or final tests. No model call belongs to fixture qualification.


## Lifecycle validation tasks

`benchmarks/fusion/lifecycle-holdout-workloads.json` adds two development
tasks from merged source fixes: credential cold-import settlement and
assignment revision publication. The first joins concurrent imports without
changing failure identity; the second combines compact revisions with ordered
reconciliation and current-owner reads.

Qualify the manifest with `scripts/qualify-fusion-workloads.mjs` before any
model calls. Qualification must show the known source repair passes both the
original visible tests and the independent acceptance tests, while the original
source fails acceptance. Initial sandbox qualification passed:

| Task | Original visible | Reference visible | Original acceptance | Reference acceptance |
| --- | --- | --- | --- | --- |
| Cold imports | 40/40 | 40/40 | 42/51 | 51/51 |
| Assignment revisions | 11/11 | 11/11 | 5/12 | 22/22 |

The original assignment implementation lacks the newly exported preparation
functions, so its new API test module cannot load and its executed count is lower. No model result or gain is claimed
by qualification; changed manifests or source pins require fresh qualification.

The acceptance runner replaces the listed test files from the pinned reference
only after repair. Those test bodies and the reference source must remain
unavailable to model planning, editing and routing. Once used for inference,
these cases are exposed and cannot remain an unseen validation set.

## Routing and platform validation tasks

`benchmarks/fusion/routing-platform-workloads.json` adds two historical repairs
for testing a frozen policy on different work: threshold grant replacement and
cross-platform native snapshot compression. The first allows four routing
source files and checks real Worker behavior. The second allows only the
snapshot plugin and checks the gzip header alongside the existing catalogue
content, module identity and build determinism requirements.

Qualify this manifest with `scripts/qualify-fusion-workloads.mjs` before model
inference. The original visible tests must pass both revisions; the extended
acceptance tests must reject the original source and pass the reference repair.
Use Linux qualification for the gzip task so the original platform difference
is exercised. Reference source and extended tests stay outside agent context.

These tasks have no model results at introduction. Keep them separate from
previously exposed workloads, freeze policy and comparison settings before
inference, and retain unsuccessful attempts. Repeated draws become exposed-task
replications; they do not add independent unseen tasks.


## Discovery and stream validation tasks

`benchmarks/fusion/discovery-stream-workloads.json` adds two historical repairs:
manifest-only catalog route metadata and streamed terminal accounting. The
first changes one discovery module. The second spans four source modules to
inspect bounded SSE frames, preserve authoritative terminal usage, and settle
protocol failures and caller cancellation without changing the HTTP status.
The task explicitly specifies the `observeUsage().result` report shape required
by acceptance tests; internal API requirements must be visible to the agent.

Qualify this manifest before inference. The reference repair must pass the
original visible tests and independent acceptance, and the broken base must
fail acceptance. Initial Linux sandbox qualification passed with no skips:
discovery visible 35/35 on both revisions and acceptance 43/55 before repair,
55/55 after; streaming visible 9/9 on both and acceptance 41/59 before repair,
59/59 after. These are harness checks, not model results. Keep reference source and acceptance-test bodies outside model
context. The manifest is development data; subsequent draws on either task are
replications, not additional unseen tasks. It does not alter the public Fusion
policy or establish a new quality result.


## Base64 inspection workload

`benchmarks/fusion/base64-inspection-workloads.json` adds a historical MiniMax
cover-reference repair. The task requires canonical base64 validation with
bounded scalar inspection, exact 8-MiB size handling and preserved request
identity. The public instruction declares the required exported inspector,
frozen `{ decodedBytes }` result and rejection/error behavior. Acceptance-test
bodies and reference source remain outside model context.

Initial isolated qualification passed: original and reference each pass four
visible tests; the reference passes all 28 acceptance tests with no skips. The
original fails acceptance because it lacks the explicitly required export.
These are harness checks, not model results. Treat this public historical task
as development data; qualify its pinned revisions before inference and do not
claim that repeated draws are new unseen tasks.


### Delivery regression tasks

`benchmarks/fusion/delivery-workloads.json` adds two historical development
repairs: alternate preparation must settle before a cancelled proxy request
finishes, and native OpenRouter music must preserve full-size bounded SSE
without aggregate audio decoding. Each task pins its original parent and repair,
keeps existing visible tests, and grades with a separate acceptance suite.
The music task exposes the original scalar-inspector interface as read-only
context. These are development tasks, not an unseen public-endpoint benchmark.
Qualify both original and repaired revisions before using them in a comparison;
include fixed-model controls and keep acceptance tests out of model context.


## Pinned probe regression gate

Set `FUSION_PROBE_REGRESSION_GATE=1` for an interactive paired `architect`,
`edit-handoff`, `completion-handoff` or `matched-handoff` run. The same gate
applies to cheap-only, strong-only and mixed arms. Defaults stay unchanged.

The executor retains the first four distinct passing probes of at most 4096
UTF-8 bytes each. Later probes cannot evict them. Before submission and at the
end of a trial, it replays those probes against the current source in separate,
fresh sandboxes. Replays cannot mutate the live repair or each other's state.
At least one retained probe and successful replay are required for a gated
score. Unchanged source and probe sets reuse their result within the trial.
Probe execution, sandbox setup and cleanup count toward elapsed time; replays
use the existing trial deadline and do not invoke a model.

These are model-written regression checks, not trusted correctness oracles.
They can miss behavior, encode a wrong assumption or be trivial. Independent
acceptance tests still determine task correctness. Raw probe source and output
remain in memory; reports contain only counts and the gate result. Repeat
analysis rejects runs that change the gate setting.


### Supplied preservation checks

A workload may supply `preservationProbes`: one to four distinct Node ES modules,
up to 4096 UTF-8 bytes each. Qualification runs each probe in a fresh sandbox on
both the original source and the reference repair. Each must pass without
changing an editable source file. Receipts bind these outcomes to each probe's
digest; stale, missing or failed checks reject the workload before paid calls.
This checks compatibility with two implementations, not general soundness.

Use `FUSION_PROBE_REGRESSION_GATE=1` with these manifests. The probes occupy
pinned slots before the first model call and remain visible to every arm.
They do not consume model calls. Later generated probes can fill remaining slots
but cannot replace supplied ones. Final replay and independent acceptance both
remain mandatory.

`benchmarks/fusion/preservation-workloads.json` is an exposed development variant
of the existing music delivery task. It adds a small destination/header/byte-replay
check. It is not a new holdout and must not be pooled with the original variant
as an independent task. The original native test file cannot simply become a
visible suite: some of its old fixtures and limits reject the required repair.

### Stream and lifecycle confirmation tasks

`benchmarks/fusion/stream-lifecycle-workloads.json` adds two historical repairs
outside the quota snapshot case. These remain coordinator-selected development
tasks. Their initial model exposure must be reported separately from repeats.

| Task | Original tests, both revisions | Baseline acceptance failures | Reference acceptance |
| --- | --- | --- | --- |
| Gemini SSE negotiation | 12/12 | 2/15 | 15/15 |
| Managed observation loss | 10/10 | 10/21 | 21/21 |

Qualification runs real query-routing and managed-job fixtures, with no skipped
or cancelled tests. The stream task preserves ordinary query transport while
requiring exact SSE negotiation before upstream dispatch. The lifecycle task
preserves billing and settlement while freezing a lost observation once,
without replaying a create or inventing a terminal execution outcome. Its
instruction names the new metadata and positional callback arguments explicitly.
Neither qualification result establishes a model or fusion gain.

### Bounded credential-ingress repair

`benchmarks/fusion/raw-ingress-workloads.json` adds a historical repair
across proxy authentication, discovery and pool selection. It requires bounded,
sequential header inspection before parsing and preserves selection order,
Access fallback and authentication failures. Credentials and authorities are
synthetic fixtures; this benchmark does not use live accounts.

Original identity, discovery and pool tests must pass on both source revisions.
Independent acceptance checks the raw limits, early selection and terminal
failure behavior. The original must fail and the reference must pass with no
skipped tests before inference. The first exposure can serve as fresh
validation; later runs are development repetitions.

Initial Linux qualification passed without skips: both source revisions pass
102 visible tests; the original fails 20 of 143 acceptance tests, and the
reference passes all 143. This qualifies the task, not a model or fusion policy.


### GitHub evidence validation workload

`benchmarks/fusion/access-evidence-workloads.json` defines a historical
three-file repair of GitHub identity evidence admission and response retirement.
The original Access and assignment tests must pass before and after the repair.
Independent unit and real-Worker tests cover bounded parsing, UNKNOWN versus
terminal outcomes, assignment preservation and cancellation ownership. All
accounts, signed assertions and HTTP fixtures are synthetic.

Qualify the task before inference. The `development` label is required by the
current harness; report initial exposure separately from any later tuning or
repetition. This task shares the authentication domain with the raw-ingress
workload and does not establish cross-domain generalization.

### Quota snapshot repair workload

`benchmarks/fusion/quota-snapshot-workloads.json` isolates a historical
two-file quota-state repair. Its instruction specifies the new
`GrantRuntimeState.windowSnapshots` shape and limits; the original source does
not contain that API. Successful probe snapshots must retire omitted
windows within their own scope, retain watermarks against delayed observations,
and preserve newer windows, other scopes, active rejection cooldowns and
credential-revision boundaries. It does not exercise provider parsing or
end-to-end grant failover.

Both source revisions pass the original 10 quota tests. The original fails
three assertions in the combined 18-test acceptance suite; the reference
passes all 18, with no skipped or cancelled tests. The failures cover omitted
windows, delayed observations and malformed snapshot metadata. Qualification
establishes a usable development task, not a model-quality or fusion gain.

One matched development trial with the explicit API contract produced:

| Arm | Acceptance tests | Calls | Cost (USD) | Agent time |
| --- | --- | --- | --- | --- |
| GPT-6 Luna | 17/18 | 17 | $0.022631 | 64.569 s |
| GPT-6.1 Sol | 18/18 | 7 | $0.113941 | 59.246 s |
| Sol → Luna | 18/18 | 6 | $0.037212 | 39.968 s |

All arms used a 24-call shared limit, 4096 output tokens per call and a
480-second deadline. Luna used no reasoning; Sol used medium reasoning.
The handoff arm made three calls to each model, retained source evidence
and used the same pinned-probe regression gate as the fixed controls.
Costs include every model call; agent time excludes final acceptance grading.

The handoff matched the strong model's success at 67.34% lower cost and
32.54% lower agent time, while resolving the remaining cheap-only failure.
This is one exposed development task and one trial, not statistical evidence
of superiority or a public-endpoint gain. Earlier trials whose instructions
omitted the new API shape are excluded from these comparisons. No routing
defaults change.

### Bounded edit handoff

Set `FUSION_HANDOFF_PROBE_GATE=1` together with `FUSION_PROBE_REGRESSION_GATE=1`
to delay an `edit-handoff` until a behavior probe distinguishes the original
source from the current repair. The probe must fit in 4096 UTF-8 bytes, fail
with an assertion on the frozen original source, and pass on the candidate in
fresh isolated sandboxes. Current visible tests and pinned regression probes
must also pass. A runtime/import error on the original is insufficient.

Each edit invalidates earlier qualification. Calling `finish` cannot bypass
the gate. An explicit `FUSION_HANDOFF_MAX_TURNS` still transfers unfinished
work when its limit arrives; receipts distinguish `qualified_probe` from
`turn_limit` transfers and record the comparison count. No hidden acceptance
tests enter this decision, and the extra checks use the existing deadline.

Use `matched-handoff` to apply the same gate to a strong-successor control.
The option is off by default. Reports retain `handoffProbeGate`; repeated
analysis rejects mixed settings. This gate proves only that one probe detects
a source difference, not full contract coverage or a model-quality gain.

Set `FUSION_HANDOFF_MAX_TURNS` to reserve successor calls in an `edit-handoff`
comparison. The first worker hands off after its first passing edit or the
specified number of turns, whichever comes first. The limit must be at least
one and smaller than the shared call limit. The default remains uncapped.
A handoff at the limit transfers the current attempt even if visible tests fail;
the successor must repair and verify it. Refusals, uncertain charges and incomplete
test execution still stop their existing paths rather than triggering this limit.

Receipts record `handoffMaxTurns` and a bounded handoff reason. Repeated blocks
must use the same limit. Fixed cheap/strong controls retain their entire allowance;
`matched-handoff` applies the same boundary to its all-strong handoff control.
This option is an experimental allocation rule, not evidence of a quality gain.


### Complete-adviser repair workload

`benchmarks/fusion/adviser-completion-workloads.json` pins a one-file repair to
Fusion's adviser collector. Incomplete, refused, tool-calling or provider-error
responses must not become synthesis context. The repair must preserve completed
text responses, response consumption, usage accounting, ordering and fallback.

This is a coordinator-selected development task, not a random holdout. Both
source revisions pass the three original visible tests. The original fails 11
of 26 independent acceptance tests; the reference passes all 26 without skips.
Qualify the exact manifest before reuse. Do not reveal the reference or
independent acceptance tests to the repair model.

One controlled development block used GPT-6 Luna with reasoning disabled,
GPT-6.1 Sol with medium reasoning, and an edit handoff from Sol to Luna. Each
arm had 24 shared calls, 4096 output tokens per call, an eight-minute deadline
and a $1 cap. The mixed arm received original-source handoff evidence and the
probe regression gate. The runner was pinned to
`597020f6aea07ed1c0d68382860f96affd1fa52e`.

| Strategy | Acceptance | Calls | Estimated cost | Agent time |
| --- | --- | --- | --- | --- |
| Luna only | 26/26 | 8 | $0.006637 | 35.812 s |
| Sol only | 26/26 | 9 | $0.103371 | 68.604 s |
| Sol → Luna | 26/26 | 11 | $0.033435 | 54.748 s |

The mixed arm used both models. It cost 67.7% less than Sol alone, but Luna
alone solved the same task at one fifth of the mixed cost and in less time.
This block supports cheap execution on this case; it shows no fusion quality
gain. A single selected task does not establish a general routing rule or
production readiness. No default or public endpoint changed.

Costs apply published tariffs to reported usage, not invoice totals. All 28
calls settled. Agent time excludes independent grading: the first arm's cold
grade took 46.045 seconds, while later grades took about one second each.
Including that setup in only the first arm would reverse the latency ranking.
Keep agent time and grading time separate when comparing these results.


## Two-task confirmation: cheaper, still below the reliability gate

Two matched blocks on new historical Gemini SSE negotiation and managed
observation-loss repairs used runner revision
`77a1db776be0c3e6f909bb0ec447f44d76b873fc`. The policy and instructions were
frozen before inference. These are two distinct development tasks repeated
twice, not four independent tasks or a public-endpoint benchmark.

Each arm had 24 calls, 4096 output tokens per call, 480 seconds and a $0.75
ceiling. Models were `openai/gpt-6-luna` without reasoning and
`openai/gpt-6.1-sol` with medium reasoning. The edit handoff ran Sol first, then Luna, retaining source
and tool evidence; all arms used pinned regression probes. Costs include all
191 calls, including unsuccessful attempts. Agent time excludes final grading.

| Arm | Completed repairs / 4 | Cost (USD) | Agent time |
| --- | ---: | ---: | ---: |
| Luna | 0/4 | $0.208916 | 319.719 s |
| Sol | 2/4 | $1.146421 | 281.385 s |
| Sol → Luna | 2/4 | $0.487105 | 307.260 s |

Sol and the handoff each completed the streaming task twice; Luna completed
neither attempt. Neither Sol nor the handoff completed the lifecycle task in
either block. The first block's Sol and handoff candidates passed their own
checks but missed the same independent regression. In the second block, Sol
hit the budget guard with a patch that passed independent acceptance but had
not passed its pinned probes or submitted. The handoff hit the turn limit and
failed independent acceptance. Those attempts retain zero scores.

The handoff matched Sol's completed-repair count at 57.51% lower cost and
9.20% more agent time. All four handoff attempts called both models in that order. This is a
repeatable cost observation on the streaming task, not evidence of better
quality than Sol. The aggregate 50% completion rate fails the predeclared 75%
pilot threshold. No production or routing defaults change.

The completed cohort cost $1.842442. Treat the remaining weakness as a
verification and bounded-completion problem: visible probes can miss contract
requirements, and a correct partial patch still needs to finish within budget.
Any changed stop rule or verification policy needs fresh matched controls;
rescoring these attempts as successes would invalidate this comparison.


### Native named-limit scope confirmation task

`benchmarks/fusion/named-limit-workloads.json` pins the Anthropic named-limit
repair to parent `05b50e0d7bc996d38d5c825d0db4358200e315f3` and reference
`43d978e80dfaad08d33f2b763f92ac0b4fb12001`. Only `worker/provider-quota.ts` and
`worker/proxy.ts` are editable. An explicit native Fable limit must preserve
sibling eligibility while retaining the family-specific rejection deadline.
The task also requires unchanged response forwarding, bounded inspection,
existing grant failover limits, and one usage settlement.

The original visible quota tests pass 10/10 on both revisions. Independent
acceptance adds the historical named-limit tests: the original source fails
4 assertions across 28 tests; the reference passes all 28. No tests
are skipped. The new test file exists only in acceptance sandboxes. It is not
provided to the repair agent. Qualification alone establishes no model capability
or fusion gain.

A later three-block, order-balanced comparison on frozen source
`4ae7a16ea1ce92b2ab63b0adf9f4ff15e4bca89b` stopped during the final arm on an
HTTP 400 reported as a token-limit error. The eight preceding attempts produced
no accepted repair or actual handoff: the cheap model reached its turn limit or
failed, and the strong-model arms exhausted their conservative budget allowance.
All arms used full-source preloading and the same probe-qualified handoff rules
as the Azure comparison. Each allowed 24 calls, 4,096 output tokens, 480 seconds,
and $0.75. The large editable proxy file exposed a source-context limitation.

Retain all 90 attempted calls: 89 settled at an estimated $0.804082, with $0.419508
still reserved for the rejected request. There was no retry. The incomplete
comparison has no aggregate efficacy result; cheaper failed work is not a gain.
The rejected request body has the same digest as two earlier successful initial
calls. The terminal response does not establish a deterministic request-size
ceiling.


### Native Azure speech retirement confirmation task

`benchmarks/fusion/azure-retirement-workloads.json` pins one historical repair
to `655990cdb4c33a148b03425fd6a2c8831c6766ef`, with reference fix
`80ecc42d40619894b10924c772a07a625996029e`. Only
`worker/native-azure-speech.ts` is editable. The task requires a failed or aborted
response to retain its reader and existing memory lease until cancellation
settles, including reentrant abort and cancellation rejection. The original
input-retirement helper is available as context.

Original visible tests pass 9/9 on both revisions. Independent acceptance
replaces the test file with its historical fixed revision: the original source
fails three assertions across 12 tests; the reference passes all 12. No skipped
or cancelled tests contribute to qualification.

#### Three-block matched confirmation

Frozen source `2d5762efdcb80616869724dfbba034061838e6d9` ran three blocks on this
previously unexposed task. Arm offsets 0, 1, and 2 placed each strategy in each
ordinal position once. Both handoff arms used the same source evidence, pinned
regression probes, and probe-qualified transfer gate. The strong control handed
from Sol to Sol; the mixed candidate handed from Sol to Luna. Sol used medium
reasoning and Luna used none. Each attempt allowed 24 calls, 4,096 output tokens
per call, 480 seconds, and $0.75. Independent acceptance stayed hidden from the
agents.

| Strategy | Accepted repairs | Calls | Estimated cost | Agent time |
| --- | ---: | ---: | ---: | ---: |
| Luna only | 3/3 | 59 | $0.059006 | 240.012 s |
| Matched Sol → Sol | 3/3 | 24 | $0.546852 | 205.015 s |
| Sol → Luna | 3/3 | 20 | $0.228175 | 155.950 s |

Costs and times are totals across the three blocks. Agent time excludes final
independent grading and includes agent execution and tool work. Costs use pinned
tariffs and reported usage, rather than a billing statement. All 103 calls
settled, for a total estimated cost of $0.834033. Each submitted repair passed
all 12 independent acceptance tests, with none skipped. Every mixed attempt
called both models and passed the transfer gate.

The mixed candidate cost 58.27% less and used 23.93% less agent time than the
matched Sol control. Luna alone remained cheapest; the mixed candidate was
faster. There were no quality wins over either control. The predeclared pilot
screen **failed** because the candidate rescued no tasks beyond Luna alone.

This is a cost/latency observation on one historical task, repeated three
times, not three independent tasks or a significance test. Rotating order does
not remove every provider-cache or time effect. Keep it separate from earlier
cohorts with different protocols. It does not establish an endpoint-wide or
production gain, and no routing defaults, release, or deployment change.

### Diagnostic-plan development screen, 2026-11-14

A local comparison tested a Qwen3 0.6B planner with a Qwen3 4B Instruct repair
worker on two previously exposed tasks: GMI selectors and literal Responses
paths. It compared worker-only repair, a free-form plan, and a structured
diagnosis requiring unique exact source quotes. Source quotes establish a
location, not whether the proposed diagnosis is correct.

Each arm received at most two calls: two worker attempts, or one planner call
and one worker attempt. All calls allowed 4,096 output tokens within the fixed
32,768-token context. The worker used the existing one-shot edit interface.
Every arm saw the same first 80 lines of visible test examples and the supplied
reproducer; execution still ran the complete tests. Task order rotated the arms.
Independent acceptance ran only after all six arms finished.

| Policy | Accepted repairs | Calls | Input tokens | Output tokens |
| --- | ---: | ---: | ---: | ---: |
| Worker only | 0/2 | 4 | 12,924 | 7,391 |
| Free-form plan → worker | 0/2 | 4 | 9,271 | 3,394 |
| Validated diagnosis → worker | 0/2 | 4 | 9,097 | 3,595 |

All 12 responses completed normally. Every candidate failed independent
acceptance with the original failure counts: 26 of 75 tests for GMI and 17 of
28 for Responses, with none skipped. The structured plans failed source-anchor
validation on both tasks, so their advice was omitted. Free-form plans were
well-formed but did not improve repair correctness. This pool does not justify
adding a diagnostic-planner feature. Lower token use on failed work is not a win.

Two earlier screens stopped before any planner call because worker output
reached the old 1,536-token limit. Their three settled calls are excluded from
the comparison. Across all three screens, 15 local calls used 42,188 input and
18,390 output tokens, with zero API spend. Local compute is not free. Timing is
not compared because the recorded worker duration excludes planner execution.
These exposed development cases do not establish generalization or production
quality; the larger output allowance enabled evaluation, not better answers.


### Edit-interface calibration

`scripts/fusion-edit-calibration.mjs` compares the existing exact search/replace
and guarded line-range executors on six synthetic TypeScript edits. Each task
specifies the requested change; this measures edit execution, not diagnosis.
Both formats receive the same source bytes and instruction. Search/replace gets
plain source, as in the repository executor; line-range gets numbered source.
Expected output stays in the grader. Exact byte equality preserves unrelated
text and formatting.

Call `runCalibration(invoke, { checkpoint, signal })` with a qualified transport.
The injected `invoke(request, { signal, seed, caseId, format })` returns the
`{ result, inputTokens, outputTokens }` shape from `localActionRequest`. The
caller owns model pinning, transport admission, and checkpoint persistence.
The module starts no service and selects no provider.

The default `sourcePresentation: 'format-native'` is recorded in `state.settings`.
Use `runCalibration(invoke, { sourcePresentation: 'numbered' })` to reproduce the
original presentation, which numbered source for both formats. Direct
`calibrationRequest` callers can pass the same option as the third argument.
Compare these presentations as separate protocols; reports from the original
implementation used numbered source even though they lack this setting.

The fixed protocol allows 12 calls, 1,024 output tokens per call, 60 seconds per
request and 15 minutes total. It rotates format order across tasks and pairs
seeds. Truncation, transport failure and incomplete usage stop the run without
retry. Records contain digests and outcome categories, not generated source.
Malformed output, invalid anchors, invalid ranges, unchanged output, and wrong
applied edits remain distinct from exact edits. Range deletion must include
sufficient surrounding lines to remove a newline; an empty replacement leaves
an empty line under the existing executor contract.

At least five exact edits out of six, with no wrong applied edit, qualifies an
interface only for a separate confirmation set. It does not establish repository
repair quality or a Fusion gain. Compare actual acceptance on disjoint repository
tasks before changing production behavior.

The first local calibration used cached Qwen3-4B, greedy decoding, a 32,768-token
context and the fixed 1,024-token output limit. All 12 calls completed normally:

| Format | Exact edits | Rejected anchors | Applied but different from reference | Input / output tokens |
| --- | ---: | ---: | ---: | ---: |
| Search/replace | 0/6 | 5 | 1 | 2,200 / 702 |
| Line range | 1/6 | 0 | 5 | 2,302 / 291 |

Neither format qualified for confirmation. This is a negative result for this
model and prompt, not evidence of a general format ranking. Both received
numbered source in that run. Exact-byte mismatches
can include formatting differences and do not by themselves prove semantic
incorrectness. Content-free receipts cannot diagnose those differences after
the run. No repository acceptance or Fusion gain follows from this screen.
API spend was zero; local compute remains a resource cost.

A subsequent paired presentation check used six new, fully specified edits and
the same local 4B model. Plain search/replace source produced three exact edits,
two applied differences and one unchanged result. Numbered source produced no
exact edits: all six rejected searches included line-number prefixes. This
supports using plain source for this executor, but plain source still failed
the five-of-six, zero-difference qualification rule. Neither result establishes
a capable repository editor or a Fusion gain. No production executor changed.

### Adviser retirement transfer task

`benchmarks/fusion/adviser-retirement-workloads.json` pins the one-file repair
from [PR #1051](https://github.com/openclaw/clawrouter/pull/1051). It exercises
Fusion's own adviser collection: fallback must return without waiting for slow
cleanup, while the existing retention callback owns cancellation until it settles.
Reader locks must remain held through pending reads and cancellation, including
rejected cancellation. Successful readers must release without cancellation.

The supplied reproducer checks retained HTTP-error cancellation. Original
strategy tests remain visible; independent acceptance uses the historical
collector regressions for deadlines, byte limits, late responses and success.
The existing input-retirement interface is source context, not editable output.
Qualification must establish passing original and repaired visible tests, a
failing original reproducer, a passing repaired reproducer, original acceptance
failures and a complete passing repaired acceptance suite before inference.

This is a development transfer case for an already studied cleanup pattern.
It does not establish independent generalization or a Fusion quality gain.
The workload adds no provider calls and changes no production strategy.

### Short-prefix guidance screen

A local screen on 2026-11-14 tested whether a short start from a stronger model
could help a tiny model finish an arithmetic problem. This is a fixed-budget,
zero-shot adaptation of [LLM Shepherding](https://arxiv.org/abs/2601.22132), not a
reproduction of its trained hint-selection policy or few-shot setup.

The student was `qwen3:0.6b` (digest
`7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435`);
the teacher was `qwen3.5:4b` (digest
`7f3251fa6878a78a606bcb3c074283306e5ad2ea411a7774a9dd98a4bc7f2d13`).
Both used Ollama 0.40.11, `think: false`, temperature 0, top-p 1, repeat penalty 1,
seed 20261114, a 4,096-token context, and a 768-token final-output cap. Hints had
a separate 64-token cap. A hint was the beginning of an ordinary answer, not a
separately requested plan. Intentional hint truncation was allowed; final
answers had to finish normally.

The cohort was the first 16 questions in ascending SHA-256 order of UTF-8
`prefix-hint-v1|` followed by the question, from the official
[GSM8K test file](https://github.com/openai/grade-school-math/blob/b0bb162abedc65e1fdd8e93ed090fd7598ee68bc/grade_school_math/data/test.jsonl).
All 1,319 questions were eligible. The source Git blob was
`e4c2ff4942b9a78bd74f04141224c11e28d12dc9`; selection used no model outcomes.
Ground-truth answers were used only by the grader.

Each question had four arms: student alone, teacher alone, teacher prefix then
student, and student prefix then student. Prefixes were generated independently
of the full-answer controls. The four arms rotated execution order by question.
All received the same problem and instruction to show a concise calculation and
end with `#### <numeric answer>`. Continuations also received their prefix as
potentially mistaken context and were asked for a complete solution. The study
completed 96 question calls plus two warmups, with no retries or incomplete
final outputs. Responses and usage were recorded before grading.

| Arm | Frozen strict score | Post-hoc numeric diagnostic | Normalized compute seconds |
| --- | ---: | ---: | ---: |
| Student alone | 1/16 | 9/16 | 5.200 |
| Teacher alone | 12/16 | 13/16 | 11.709 |
| Teacher prefix, student finish | 3/16 | 12/16 | 13.390 |
| Student prefix, student finish | 1/16 | 7/16 | 8.087 |

The frozen grader required exactly one line containing `####` followed only by
a number. The tiny model often copied the literal `<numeric answer>` placeholder
or added currency/LaTeX formatting. Its strict score therefore mixes arithmetic
errors with format failures. The separate, post-hoc diagnostic accepts exactly
one numeric literal after exactly one `####` marker, including formatting or
units. It does not search the preceding reasoning for a correct number and does
not replace the frozen score. Under that diagnostic, teacher hints rescued four
student failures; three hints did not already contain a final-answer marker.

Compute is a local proxy: native prompt-evaluation plus generation duration.
Each ordinary request pays the maximum observed original-prompt prefill for its
model and question; each continuation pays at least that prefill. This limits
benefits from control-warmed prompt caches. Even without that adjustment, mixed
compute was 12.821 seconds versus 11.706 for the teacher alone. Shared-server
wall time was 21.367 versus 20.800 seconds; it is not a deployment latency result.

The predeclared gate required mixed quality within one answer of the teacher,
at least two answers above each student control, at least two student failures
rescued without a final-answer marker in the hint, and compute at most 80% of the
teacher. The recipe failed. Even the more permissive diagnostic leaves it below
the teacher while using 14.35% more normalized compute. No larger confirmation,
production policy, or default change follows from this screen. API spend was
zero; local compute was still consumed. GSM8K arithmetic is a capability screen,
not evidence of repository-repair quality.

### Corrected code-plan development screen, 2026-11-14

A bounded local comparison tested Qwen3-Coder 30B plans with a
Qwen2.5-Coder 3B Instruct Q4_K_M implementation worker. It retained 16 selected
MBPP+ tasks and compared direct generation with both same-model planning
controls. Plans allowed 64 output tokens; implementations allowed 1,024.
Generation was greedy, with thinking disabled and an 8,192-token context.
Both plans were generated before any implementation. The same large-model
plan fed the mixed and large-model self-plan arms, with its cost charged to each.

This is a corrected development study, **not an untouched MBPP+ score**.
The original run stopped after finding an unsound reference for task 620:
its order-dependent algorithm could accept a chain without pairwise divisibility.
A sorted positive-integer oracle, checked against 19,531 exhaustive small cases,
corrected seven expanded expected outputs. Tasks 294 and 305 received explicit
contract clarifications before their first model calls. All 16 tasks remained.
The continuation reused 41 responses only after exact request-body matching,
then made 73 new local calls. Original artifacts were preserved.

| Policy | Value-test acceptance | Normalized native seconds | Native plus grading seconds |
| --- | ---: | ---: | ---: |
| 3B direct | 10/16 | 11.825 | 27.003 |
| 30B direct | 13/16 | 22.124 | 36.973 |
| 30B plan → 3B code | 13/16 | 19.718 | 35.455 |
| 3B plan → 3B code | 10/16 | 12.613 | 26.770 |
| 30B plan → 30B code | 14/16 | 40.074 | 55.073 |

Native time is the server's prompt-evaluation plus generation duration. Each
phase pays at least the largest observed base-prompt prefill for its model and
task, limiting benefits from cache warming by another arm. The final column
also includes isolated executable grading and its container startup. These
are local resource proxies, not production latency or dollar savings. Replayed
responses retain their original timings, so this is not a continuous wall-time
comparison.

The frozen gate **failed**. Mixed planning repaired four failed small-model
value tests, but lost two large-model successes and finished below the
large-model self-plan control. Its native ratio was 0.891; with grading it was
0.959. Both exceed the predeclared 0.8 ceiling. All 114 logical calls have complete
response and usage receipts; none required a paid API call.

Value tests also miss some real defects. A separate, post-hoc mutation check
found that the mixed answer for task 568 repeated one dictionary object rather
than creating independent dictionaries. Changing one element changed another;
the large-model direct answer preserved independence. The frozen table remains
unchanged, but its four scored rescues do not establish four complete repairs.
Reject this recipe without changing production routing.

Protocol SHA-256:
`ff317a7e84b501fa8af12eca97b92ffacb88052f01c88e9576762e79019fe4a4`.
Complete journal SHA-256:
`cff70a2ff1bc295c995b72c74af7d50a4f743195a4ba83915514b06c96cbad70`.

The [November 2026 planning/coding separation study](https://arxiv.org/html/2611.04320v1)
uses three independently sampled plans per task, up to 2,048 plan tokens and
8,192 code tokens, and tests multiple model pairings. This short-plan screen
does not reproduce that protocol. Its negative result does not reject planning
in general. [Planning-Driven Programming](https://aclanthology.org/2025.acl-long.621/)
also checks plans against visible tests before implementation and refinement;
plan validation remains a separate hypothesis to test with matched controls.

## Tiny-first execution: compute savings are not latency savings

A November 14 local comparison used Qwen2.5-Coder 1.5B Q4_K_M and
Qwen3-Coder 30B on 32 MBPP tasks not previously used in the recorded campaign.
The benchmark is public and may overlap model training. Before inference,
reference implementations and input contracts were reviewed; ambiguous tasks
were excluded. Each task had its original public examples, eight additional
public inputs and up to 64 disjoint hidden inputs. Expected results came from
the frozen references. This tests supplied, trusted verification, not automatic
test generation or arbitrary repository repair.

Both models received the same specification with 512 output tokens and a
4,096-token context limit. Each could repair one public-test failure. The
cascade accepted the tiny model's initial public pass, otherwise used the
strong model's initial answer and conditional repair. Hidden results were
withheld until all 78 calls completed. No calls or timings were reused.

| Policy | Public and hidden passes | Model compute seconds | Tokens |
| --- | ---: | ---: | ---: |
| 1.5B single | 21/32 | 8.917 | 6,801 |
| 1.5B with conditional repair | 21/32 | 12.238 | 10,260 |
| 30B single | 29/32 | 37.705 | 7,312 |
| 30B with conditional repair | 30/32 | 43.149 | 8,345 |
| Tiny-first cascade | 30/32 | 29.518 | 10,488 |

The cascade preserved every strong-repair success, had nine accepted mixed-model
cases and no observed false accepts. It passed the frozen gate: at least 27
passes, two more than tiny repair, preservation of strong-repair successes,
at least two accepted mixed-model cases, no false accepts and at least 20%
less model compute than both strong baselines. Compute fell 21.7% against
strong single and 31.6% against strong repair. Tokens increased 43.4% and
25.7%, respectively. These are local compute measurements, not API savings.

Thirty-two tasks are too few for a broad reliability claim. A post-hoc paired
task-bootstrap 95% interval for the compute ratio was [0.506, 1.098] against
strong single and [0.481, 0.865] against strong repair. The observed gate passed;
the advantage against strong single remains uncertain beyond this sample.

A separate timing run selected 18 of those exposed tasks deterministically,
repeated each twice and made fresh calls for all three compared policies.
All six execution orders were balanced across the 36 cases. Every policy
passed all 36 cases, with no false accepts; 115 calls completed. Request time
included model loading and checkpoints. Strong-single time stopped before
its public grading; the other policies included all public checks and repairs.
Hidden grading was excluded from request time.

| Policy | Summed request seconds | Included model-loading seconds |
| --- | ---: | ---: |
| 30B single response | 64.574 | 27.723 |
| 30B with public verification and conditional repair | 89.447 | 24.739 |
| Tiny-first cascade | 84.384 | 40.723 |

The latency gate failed: the cascade was 30.7% slower than strong single and
only 5.7% faster than verified strong repair, below the required 20% reduction
against both. Saving model compute did not save enough request time. This
does not qualify a faster production profile or justify default activation.

A follow-up used a separate local server with both models resident, preserving
the same runtime, weights, task sequence, seeds, policies and timing gate.
Each policy made fresh calls. Two zero-token preloads took 2.062 seconds,
reported separately from steady-state request time. All policies again passed
36/36; the run completed 115 inference calls without skipped repairs.

| Resident-model policy | Summed request seconds | Public-verified seconds |
| --- | ---: | ---: |
| 30B single | 34.385 | 63.040 |
| 30B with public verification and conditional repair | 67.650 | 67.650 |
| Tiny-first cascade | 47.282 | 47.282 |

Model loading within the cascade fell to 0.048 seconds. The cascade was 30.1%
faster than verified strong repair and 25.0% faster than strong single with its
public checks included. These descriptive comparisons suggest a narrower use
case: requests that already require executable verification. The separate
confirmation below rejects that hypothesis for the remaining tasks. Against
strong single returning
before verification, the cascade was 37.5% slower, so the original latency gate
still failed. Neither failed gate is replaced by the secondary comparison.

The resident run reused exposed tasks and repeated each twice. Its paired
task-bootstrap 95% latency-ratio interval was [0.549, 0.874] against verified
strong repair and [1.026, 1.820] against unverified strong single. This is local
timing evidence, not new-task quality evidence or a production latency promise.

The next run used all 14 tasks omitted from the first timing subset, repeated
twice, with a new fixed seed and independent calls for each policy. The new
gate required at least 24/28 passes, preservation of every strong-repair success,
two accepted mixed-model cases, no false accepts and at least 20% less time
than **both verified** strong baselines. Raw strong-single time remained a
reported control. Prior verdicts were unchanged.

| Remaining-task policy | Passes | Request seconds | Public-verified seconds |
| --- | ---: | ---: | ---: |
| 30B single | 22/28 | 31.428 | 50.686 |
| 30B with conditional repair | 24/28 | 68.071 | 68.071 |
| Tiny-first cascade | 24/28 | 68.622 | 68.622 |

All 111 calls settled; there were no false accepts, skipped repairs or lost
strong-repair successes. Both models stayed resident. The cascade was 0.8%
slower than strong repair and 35.4% slower than verified strong single. It
failed the newly declared latency gate. Cold preloads took 3.568 seconds,
excluded from request time for every arm. These tasks had prior quality
observations but no prior timings in this study. The failed confirmation
rules out presenting the first subset's verified-workflow speedup as a
general result. Do not repeat this unchanged cascade on the same tasks to
search for a passing seed.

The compute protocol SHA-256 is
`a1cc2482b403ca47e19fcfd6de4d4117db420aa311c5d71c9ebc38df9b839bd6`;
its result SHA-256 is
`3bf08dca3c6523f19ed3ce9925ea1d9802ece469f0b092f33be7b84f071dca01`.
The timing protocol SHA-256 is
`003b8bdd9b4084e1426bc78ae03a6a917a7c91edcb679963b4b0751ec3d4630b`;
its result SHA-256 is
`48f344ce4fdbd9726f4f314d0dc1418e1aa7aeff5cd5178e1724d8ca0d107925`.
These identify local development receipts, not a bundled reproduction suite.
Independent audits checked source and model pins, prompts, seeds, execution
order, conditional calls, usage, selections and reported totals. All inference
was local, with zero paid API calls.

The resident timing protocol SHA-256 is
`0e9821f95b281f2cd58f0b650657d9bc604aa873ae4bfe2add8fdc455e4ab81b`;
its result SHA-256 is
`4d0e0d573d9216299d47a174b8fd1e4afd5b4e11fcb79514c76aa1144efc5503`.
The remaining-task confirmation protocol SHA-256 is
`eb82ef0696f1a9420d63a676a4c1902fe3df88c3646ea60105dc5b60517cbeb1`;
its result SHA-256 is
`281394cb740f189eeb3eb090f50ba50a4a91b3746dd479625482388e680ab8b1`.

## Native contrastive decoding: positive point estimates, failed admission

A local token-level experiment combined a Qwen3 4B Instruct expert with a
Qwen3 0.6B amateur. It improved observed accuracy in three arithmetic cohorts,
but none passed its frozen admission gate. The final cohort lost two answers
the expert answered correctly. This does not qualify a production profile.

The decoder used the fixed rule from
[Contrastive Decoding Improves Reasoning in Large Language Models](https://arxiv.org/html/2309.09117v2):
discard tokens whose expert probability is below 0.1 times its maximum, then
greedily maximize `1.5 * expert_logit - 0.5 * amateur_logit`. Both models receive
the selected token at each step. Vocabulary entries, token attributes and
prompt tokenization were checked for agreement. This needs full local logits;
it is not available through ordinary Chat Completions responses.

The implementation used an isolated native ARM64 Metal build of llama.cpp at
`9ff0d7e90f0faaa7c16017e6dcf9cf91c50a100e`. It did not change the shared model
server. The GGUF SHA-256 pins were:

- Qwen3 4B Instruct: `85e4a5b7b8ef0e48af0e8658f5aaab9c2324c76c1641493f4d1e25fce54b18b9`.
- Qwen3 0.6B: `7f4030143c1c477224c5434f8272c662a8b042079a0a584f0a27a1684fe2e1fa`.

Questions came from the official
[GSM8K test data](https://github.com/openai/grade-school-math/blob/b0bb162abedc65e1fdd8e93ed090fd7598ee68bc/grade_school_math/data/test.jsonl),
whose raw SHA-256 was
`3730d312f6e3440559ace48831e51066acaca737f6eabec99bccb9e4b3c39d14`.
Each cohort used a fixed hash order of questions no longer than 500 characters.
Later cohorts excluded earlier questions and the earlier prefix-hint study.
These are disjoint local evaluation samples, not model-training holdouts.

Every arm received the same zero-shot request for concise working and a final
numeric answer, with a 256-token output cap. An answer counted only if generation
ended and its final `####` number matched the reference. Capped outputs failed.
Arm order alternated by question. All 352 calls completed across the three
cohorts, without retries or paid API calls. The decoding rule and output budget
were unchanged. This differs from the paper's eight-shot prompting setup.

| Cohort | Expert correct | Fusion correct | Gains / losses | Expert / fusion output tokens | Expert / fusion wall seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development, 16 questions | 13 | 14 | 1 / 0 | 2,045 / 2,036 | 22.600 / 22.328 |
| Disjoint confirmation, 32 questions | 25 | 26 | 1 / 0 | 4,164 / 4,030 | 66.633 / 78.424 |
| Final confirmation, 128 questions | 101 | 107 | 8 / 2 | 17,598 / 17,175 | 267.426 / 313.938 |

Wall time includes model loading, generation and teardown for each subprocess.
The first development control incurred cold initialization, so its apparent
1.2% timing advantage is not evidence of faster fusion. Final fusion took 17.4%
longer while generating 2.4% fewer output tokens. These measurements do not
establish resident-service latency or throughput.

The first two frozen gates required at least two gains, zero losses, and no more
than 25% extra wall time or output tokens. Both failed the gain requirement.
The final test was declared before its calls, with a stricter requirement of
at least six gains, zero losses and the same cost ceilings. It failed preservation.
Do not pool the earlier exploratory gains to turn any failed gate into a pass.

In the final cohort, four gains corrected completed wrong answers and four
avoided baseline truncation. One loss was a new arithmetic error; the other
misinterpreted a problem and truncated. The exact two-sided paired sign-test
p-value was 0.109375. A post-hoc paired task bootstrap gave a 95% accuracy-difference
interval of [0, 9.375] percentage points. The positive point estimate is not
conclusive evidence of a general improvement. No further sample extension or
parameter search is admitted for this candidate.

Independent recomputation checked all question identities, reference answers,
call ordering, grades, gains, losses, totals and receipt hashes. Final protocol
SHA-256:
`89fe4f6fba0145f6a107be91ecd9bac5b7f92bf42a2fcac06026a790ee62e43d`.
Final calls SHA-256:
`882fb43e8a7bc4ce0b3b908c647ce0eac6f88fe35543c7594489e011cb5c28c0`.
Final result SHA-256:
`757125cbf3105f9a60b5b5ad0b9b14fb3b514ba96bbddf944ced25717070536d`.
These identify local research receipts, not a bundled reproduction suite.
The experiment adds no Worker route, deployment or default activation.


## Asymmetric reader/reasoner screening

The local [PAIR-style](https://arxiv.org/html/2610.16003v1) screens did not
qualify a deployment profile. The Reader receives the full document context;
the Reasoner receives only the question and shared generated prefix. Each
step selects one token from `0.7 * reader_logits + 0.3 * reasoner_logits`.
This requires compatible local vocabularies and logits, not ordinary
OpenAI-compatible API responses. No adapters were trained, so these screens
are not a replication of the paper's adapted models.

Each screen used 16 HotpotQA validation questions, retaining the original ten
paragraphs and adding thirty fixed distractors from the same pinned source
page. Question and paragraph order came from fixed hashes. All four arms used
balanced execution order. Scoring required a completed response ending in a
separate `####` answer line, with normalized exact match (EM); token F1 was a
secondary metric. Each complete screen made 64 logical requests across 80 model
branches. All inference was local, with zero paid API calls.

| Screen | Full-context Reasoner EM | Reader EM | Question-only Reasoner EM | Fusion EM |
| --- | ---: | ---: | ---: | ---: |
| 0.6B Reader / 4B Reasoner, 128-token cap | 7/16 | 0/16 | 1/16 | 2/16 |
| 4B Reader / 30B Reasoner, 128-token cap | 0/16 | 7/16 | 1/16 | 9/16 |
| 4B Reader / 30B Reasoner, calibrated prompt and 512-token cap | 9/16 | 9/16 | 1/16 | 9/16 |

The first screen lost five full-context Reasoner successes. The second used
disjoint question IDs, but its apparent gain was invalid: eleven full-context
Reasoner responses hit the output cap, and the other five omitted the required
answer marker. Even a numerical gate pass cannot establish improvement over
that broken control.

The calibration kept the second screen's questions and models. It repeated
the answer-format instruction after the question and raised the cap to 512
for every arm. This is exposed-cohort development, not independent confirmation.
Before inference, baseline qualification required at least 15 valid completed
answers and eight exact answers. All 16 full-context Reasoner responses then
completed with the required marker; none hit the cap.

| Calibrated arm | EM | Mean token F1 | Output tokens | Subprocess seconds |
| --- | ---: | ---: | ---: | ---: |
| Full-context Qwen3-Coder 30B | 9/16 | 0.6982 | 1,007 | 133.372 |
| Full-context Qwen3 4B Instruct | 9/16 | 0.7190 | 1,155 | 79.983 |
| Question-only Qwen3-Coder 30B | 1/16 | 0.1739 | 1,538 | 31.765 |
| Fused 4B Reader / 30B Reasoner | 9/16 | 0.7692 | 1,157 | 104.718 |

The frozen gate required no lost full-context Reasoner successes, at least as
many exact answers as that Reasoner, two more exact answers than both the
Reader and question-only controls, at most 80% of full-context Reasoner wall
time, and at most 125% of its output tokens. Fusion took 78.52% of that wall
time and 114.90% of its tokens, but lost one officially scored success and
added no net exact answers. It failed the quality gate. It was also 30.9% slower
than the Reader alone. Timing includes model loading, prefill, decoding and
teardown on one shared host; it is not a production latency claim.

The two EM disagreements also limit the semantic interpretation. Fusion's
only official gain shortened a correct song name with an alias to the exact
reference name. Its official loss rejected a false premise: the question
places the English Electric Canberra in World War II, while the supplied
paragraph dates its service entry to May 1951. The supporting squadron paragraph
assigns Canberra service to later conflicts. The [RAF Museum's historical
account](https://www.rafmuseum.org.uk/documents/Research/RAF-Historical-Society-Journals/Journal_43a_Seminar_The_Canberra_in_the_RAF.pdf)
independently dates the first RAF delivery to 25 May 1951. The full-context
Reasoner repeated the incorrect premise and matched the reference. Keep the
official scores unchanged; neither disagreement proves a capability gain or
regression. Future quality studies need fresh, semantically qualified tasks.

Smaller parameter count also did not mean smaller KV memory. The cached Reader
has 36 layers and eight KV heads; the sparse Reasoner has 48 layers and four KV
heads. Both use 128-wide keys and values. At F16, their KV storage is 144 KiB and
96 KiB per context token, respectively. The full-context Reader therefore needs
1.5 times the Reasoner's KV storage, before adding the short-context Reasoner
state. This pair cannot support a KV-memory-saving claim.

The calibrated protocol SHA-256 is
`0fd21cc78581e398e4d4fa651a407096de09c2bdef166897ff40a9044c50b96e`;
its result SHA-256 is
`1a945f31890c2ff3236d8f9911f11c5285b67da81bb9def1677d9bdf31a42074`.
Audits reconstructed source questions, answers, document text, execution order,
prompt-length equality, scores and timing totals. The full-context Reader and
Reasoner used identical prompts; the pair reused the matching full-context
Reader and question-only Reasoner prompts. These hashes identify private local
receipts, not a bundled reproduction suite. No runtime, deployment or default
policy changed.

### Optional action-budget feedback

Custom runners calling `runAgent` can pass `{ showActionBudget: true }` in the
options argument. Each worker request then includes the remaining action turns,
including the current turn. This counts worker action turns, not every planner
or panel API call. The default is off, and enforcement limits do not change.

Record this option in the experiment protocol and use the same value for every
comparison arm. Budget disclosure is an experimental prompt intervention, not
a demonstrated quality improvement. Keep the static task and system prompt
unchanged when comparing it with the default.


### Named fixture probes

Callers can use `check(box, paths, timeout, { testNamePrefix })` to run top-level tests
whose names start with a literal prefix. For example, `{ testNamePrefix: "fusion probe: " }` selects appended probe tests while preserving the original
fixture imports and hooks. Regex metacharacters in the prefix are escaped.

A passing test-file wrapper without a matching named test does not pass this
check. The result includes `matchedTestPrefix` when selection is requested.
`checkAcceptance` accepts the same options as its fifth argument and retains
its protected-file checks. Default calls continue to run all tests.

For trusted fixtures that require `globalThis.gc`, pass `{ exposeGc: true }` to
`check` or `checkAcceptance`. This adds only Node's `--expose-gc` flag; the default
is off. Invalid option values fail before execution or acceptance snapshots.
Predeclare this runtime option for every comparison arm and pin it with the
fixture. Requalify both baseline and reference under that same runtime before
using it in a new study. It does not repair or replace previous results.

For replayable feedback, callers can also set `normalizeFeedbackTimings: true`.
This replaces TAP test durations and the final duration summary with `<elapsed>`
before the 12,000-character feedback limit is applied. Normalizing after clipping
cannot recover characters displaced by longer timing values. The default
preserves timing text. Raw output digests, test counts and verdicts remain
unchanged; the option does not normalize other variable diagnostics or repair
previously clipped receipts.

Set `normalizeFeedbackProcessIds: true` to replace the numeric process ID in
top-level Node warning headers with `<pid>` before clipping feedback. This
preserves warning codes, messages, stacks, indented assertion values, raw output
digests, and verdicts. The default retains the original text. This only handles
warning-header process IDs; it does not make arbitrary diagnostics deterministic
or qualify a previously failed replay. Freeze the option before new model calls.

Name selection checks execution evidence. It does not establish assertion
quality or complete requirement coverage, and it is not a substitute for the
independent full acceptance suite. TAP output is generated by the tested code
and is not an adversarial attestation.

## Three fresh cheap-first checks, 2026-11-24

A checked cheap-first policy passed three newly selected repository tasks at lower
model cost than direct strong controls. All three tasks were solved by the cheap
model alone. These observations support skipping unnecessary planning on these
tasks; they do not establish complementary model capability or a production
quality guarantee.

The controls used `openai/gpt-6.2-sol` and `openai/gpt-6-luna` with identical
public requests except for model identity. The policy checked the Luna result
first. A passing public suite and compiler stopped inference. A failing draft
would have gone to a strong planner, then Luna implementation and at most one
Luna correction, preserving the checked draft and its public failures. None of
the tasks exercised that escalation branch. Every model call would count toward the
policy cost; full acceptance ran after inference ended.

| Task and published contract | Full / public tests | Strong cost | Cheap-first cost | Strong / cheap model seconds |
| --- | ---: | ---: | ---: | ---: |
| [Reject oversized adviser proposals](https://github.com/openclaw/clawrouter/pull/1101) | 35 / 31 | $0.022976 | $0.001197 | 2.935 / 3.224 |
| [Expose music and image integration seams](https://github.com/openclaw/clawrouter/pull/821) | 45 / 43 | $0.058536 | $0.003147 | 16.720 / 11.775 |
| [Canonicalize Bedrock query signing](https://github.com/openclaw/clawrouter/pull/152) | 12 / 10 | $0.036966 | $0.001904 | 4.538 / 4.881 |

Strong, Luna and the policy each passed every full and public test, the compiler,
and zero-skip checks. The policy reused the accepted Luna candidate; it did not
make another paid call. Across these three tasks, billed model cost was $0.006248
versus $0.118478, a **94.73% reduction**. The first and third tasks' cheap calls
were slower.
Model seconds exclude checks and orchestration, so this is not an end-to-end
latency comparison. Costs include billed cache writes; none of the tasks used
cache reads. They exclude local validation compute.

Selection used changed-file metadata, prior exposure records, a 32 KB source
limit and already cached dependency images. Test partitions and published
behavior contracts were frozen before model calls. The first task was the only
eligible case in a 200-commit scan across eight cached dependency locks; the
second was the only eligible case in the next 400 commits. The third came from
the remaining 359 older commits, using an additional cached dependency lock.
Its four literal table cases were split by a fixed hash: two stayed public and
two were held out, with the shared test body unchanged. The original baseline
executed all 12 full and 10 public tests, failing three and two respectively;
the reference passed both suites and the compiler. Many other cases
were excluded for prior exposure or failed qualification, size, changed-surface
coverage or unavailable matching runtimes. This convenience sample does not
represent the repository or a random task distribution. An immediately prior
Copilot repair remained incorrect for every arm; its best full result was
42/43. Keep that negative result separate rather than replacing it with these
successful tasks.

The music/image baseline initially ran only 28 full tests because a declared
new export blocked one file from loading. Standard admission rejected it. An
explicit amendment verified the exact missing-export diagnostic, complete
counts in the other file, per-file totals matching the aggregate, all 40
pre-change tests passing, and both functions absent before and present after
with matching module hashes. Candidate acceptance still required all 45 full
and 43 public tests. No truncated baseline counted as a complete candidate.

All three terminal audits replayed requests, selected files, public feedback,
compiler outcomes, full grades and cost accounting without new model calls.
The protocol and audit SHA-256 values identify private research receipts, not
an independently reproducible bundled dataset:

| Task | Protocol SHA-256 | Terminal audit SHA-256 |
| --- | --- | --- |
| Adviser proposals | `26bcdabd600c7549ab49888c2d4384e42a180bcd3ca8532ce7810cdad712ac55` | `6b63453ac8ebddb6629fa88ea5221ae92c50d0809101b61a17c037b7231058e6` |
| Music/image seams | `59f34b6f837754f0955deda3d1d455204976b04b5f18e78249224b52ee4cbad2` | `33e35cc0098b68c7ce7f3ef04f8b1df20c2909c2a8f94116c0599b395ec7538a` |
| Bedrock query signing | `1b39d98800a3e99bbc5de75b3578aca403c7bcedbece42d8ba62ecf691cb06d8` | `9c49dc44e9e2282da1045c8a0fc7db8428d70e1243bdeb9dc985931597b301d0` |

No routing default, runtime or deployment changes follow from these three results.
The next capability claim needs fresh tasks where a cheap draft actually fails
and collaboration repairs it, with matched single-model repair controls and all
calls charged. These passing drafts leave that question unanswered.


## Construction-task false acceptance, 2026-11-24

Two later construction tasks expose a limitation of the public-test gate.
Every candidate below passed its public tests and compiler, but none passed
all held-out tests. These are failed tasks, not additional cost wins.

| Published contract | Full / public tests | Strong full passes / cost | Luna full passes / cost | Policy full passes / cost |
| --- | ---: | ---: | ---: | ---: |
| [Radius codecs](https://github.com/openclaw/clawrouter/pull/422) | 6 / 3 | 3 / $0.055061 | 3 / $0.002059 | 3 / $0.002059 |
| [Ollama codecs](https://github.com/openclaw/clawrouter/pull/416) | 9 / 5 | 7 / $0.035266 | 6 / $0.002407 | 6 / $0.024170 |

The Radius policy accepted the public-passing Luna draft without escalation.
For the next, previously unexposed Ollama task, the protocol prospectively
required a strong review of that draft against every published contract
obligation. The reviewer could preserve it unchanged or supply a plan for
incremental Luna edits. A public-test regression after the bounded correction
would retain the original passing draft, while charging all attempted calls.
The reviewer and implementer received no held-out results. This trial escalated
and still failed three full tests: review increased policy model cost without
improving the full-test pass count. Equal counts do not imply identical failures.
Neither trial justifies enabling this policy by default.

Both tasks came from the same bounded local-history search using cached exact
dependency images. Each introduced one source module and one test module.
Before inference, their explicit construction admission required complete
reference suites, compiler success, and an exact missing-named-export error
from each empty-module baseline. Separate probes verified the blank/reference
source hashes and imported export types. The baseline could not execute the
suite and is explicitly labeled incomplete; it is not a complete failing
baseline. Every generated candidate still had to execute every full and public
test with zero skips. Timeouts and unrelated loader failures remained rejected.

The controls used the same strong and Luna models and identical public request
bodies apart from model identity. Radius supplied 8,068-byte bodies and Ollama
9,294-byte bodies. All model calls count; local validation compute is excluded.
The policy reuses the Luna control call, so that call is included in policy cost
but is not billed twice. Total new billed spend for both trials was $0.116556.
The result is exploratory: there is no matched Luna-only review or equal-budget
sampling control, so even an improved result would not isolate the value of
cross-model collaboration.

| Task | Protocol SHA-256 | Terminal audit SHA-256 |
| --- | --- | --- |
| Radius | `a9284997516a81a6c556cab0d6dc2ae6c48e0cb08163bb6938702b738f3ea004` | `dccb28fa13f25a04cfaf8fe5839370236ea9fa9c6832d87c8f1931551766a738` |
| Ollama | `0d1ca1443d7bd8070e9581d46b66ace7c4ba7908b1d30ea219854603c2f14cdf` | `3301cbd34e20a72f14566c8256d1b5bcdaea1cbce095fd7f6e6633789c353d11` |

The audits replayed public decisions, complete candidate grading and accounting
without new inference. These hashes identify private receipts, not a bundled
reproduction suite. Do not use these held-out failures to repair and rescore the
same tasks as fresh evidence. The earlier three-task cost result remains valid
for its stated sample; these construction failures prevent generalizing it to
new-module correctness or claiming a demonstrated fusion capability gain.


### Structured edit rejection details

Custom benchmark runners can call `editFailureDetail(error)` after `replaceEdits`
rejects a search that does not match exactly once. The helper returns a frozen
copy containing the one-based edit ordinal within the submitted batch, the
editable file path, and either `no match` or `multiple matches`. It returns
`undefined` for other errors, including errors with forged detail properties.
The original batch remains unapplied; this helper does not loosen matching or
include source snippets, replacement text, or raw exception messages.

## Matched planner control, 2026-11-24

A subsequent [managed-prediction state task](https://github.com/openclaw/clawrouter/pull/404)
compared strong and cheap planners from the same Luna draft. Neither policy nor
either direct model passed acceptance. This is a negative result, not a fusion
capability gain or cost-saving success.

| Arm | Full tests passed | Public tests passed | Compiler | Model cost |
| --- | ---: | ---: | --- | ---: |
| Direct strong | 1/9 | 1/6 | Pass | $0.117991 |
| Direct Luna | 0/9 | 0/6 | Fail | $0.004717 |
| Strong planner, Luna implementation | 1/9 | 1/6 | Fail | $0.098575 |
| Luna planner, Luna implementation | 0/9 | 0/6 | Pass | $0.017599 |

Both planner branches started from the identical original Luna candidate and
public feedback. Their planner request bodies differed only in model identity;
each could supply a plan, receive one Luna implementation and take at most one
Luna correction. Both used all three calls. Neither branch received the other's
plan or edits. All inference completed before any full-suite grading. This
controls the additional planning opportunity, not equal dollars, random seeds
or repeated samples. A one-test difference on one failed task cannot establish
complementarity.

The six-module task came from the existing fixed local-history discovery order.
Its complete reference passed all nine full and six public tests and the
compiler. Its complete baseline failed eight full and five public tests. One
new module was explicitly declared; the normal complete-baseline admission
passed without a construction exception. The dependency image was already
cached. No runtime download or live provider integration was involved.

All candidate suites completed with zero skips. Policy costs include the shared
initial Luna draft; it was billed once across the experiment. Total new model
spend was $0.229448. The terminal audit replayed requests, decisions, complete
grades and accounting without new inference. Protocol SHA-256:
`85bdee644677e7c160d249826b80741cf3c6a57d94ad724910c6196085eef7ce`;
audit SHA-256:
`8d5c410079a6c58514bc58c623d1fd5f9b5dd1dc24f93a7371666d8a52f29253`.
These identify private receipts, not a bundled independent reproduction suite.

Public failures included continuation/recovery interface misuse and type
narrowing errors. These motivate testing bounded context from unchanged
imported modules; they do not prove missing context caused the result. Any
subsequent diagnostic on this exposed task must be reported separately from
fresh-task evidence. No routing default or deployment changed.

## Access repair and verifier diagnostics, 2026-11-24

A historical [Access application-selection repair](https://github.com/openclaw/clawrouter/pull/174)
produced no accepted solution. Strong and small planners improved public-test
results from the same Luna draft, but neither passed the complete suite.

| Arm | Full tests passed | Public tests passed | Model cost |
| --- | ---: | ---: | ---: |
| Direct strong | 13/16 | 9/9 | $0.052994 |
| Direct Luna | 9/16 | 7/9 | $0.003318 |
| Strong planner, Luna implementation | 13/16 | 9/9 | $0.040859 |
| Luna planner, Luna implementation | 13/16 | 9/9 | $0.007258 |

Every suite completed with zero skips; Node syntax checks passed. The reference
passed 16/16 full and 9/9 public tests. Policy costs include the shared initial
draft, which was billed once. Total new spend was $0.097793. Equal final pass
counts do not establish identical failed tests or successful collaboration.

A separate, explicitly exposed diagnostic asked strong and small models to
generate declarative mock scenarios. They received the same original source,
public tests and contract, without the reference implementation, candidate
draft or held-out tests. Trusted code owned the assertions. Each entire batch
had to pass the reference and reject the same public-passing Luna candidate
before it could guide one small-model repair.

Both models generated nine cases. The strong batch passed 15/18 reference tests
and 18/18 candidate tests; the small batch passed 16/18 reference tests and
17/18 candidate tests. Both batches were rejected, so neither triggered a
repair call. Generation cost $0.052747. A later model-free analysis retained
every individually reference-valid case before checking the candidate. All
six retained strong cases and all seven retained small cases passed on the
candidate too. Filtering therefore found no useful discriminator.

This exposed a fixture and wording defect: the initial generator treated an
empty array as an absent field. Cloudflare documents that provided
`destinations` supersede `self_hosted_domains`; `domain` remains a separate
field. The corrected fixture format uses `null` to omit an optional array and
preserves `[]` as explicitly present. It also names `self_hosted_domains` in
the contract instead of the ambiguous phrase “legacy domain.” A real CLI
reference smoke passed all 11 tests, including the distinct absent/empty cases.
See the [Cloudflare application contract](https://developers.cloudflare.com/api/typescript/resources/zero_trust/subresources/access/subresources/applications/methods/get/).

The corrected diagnostic produced reference-valid, discriminating batches from
both models. Each batch then guided one Luna repair from the same saved
candidate. Both repairs passed their expanded public suites and syntax checks,
but neither passed full acceptance.

| Verifier | Generated cases | Reference tests passed | Starting candidate tests passed | Repaired full tests passed | Incremental model cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Strong | 12 | 21/21 | 18/21 | 14/16 | $0.058491 |
| Luna | 7 | 16/16 | 14/16 | 14/16 | $0.004750 |

Incremental costs include generation and repair, excluding the already-paid
saved candidate. All suites completed without skips. The new total was
$0.063241. Moving from 13/16 to 14/16 is an incomplete repair, not a successful
fusion result. The strong verifier did not produce a better final pass count.
The original failed results remain closed. A clarification-only control was
frozen before these full results existed. It gave each direct model the same
saved candidate and clarified contract, with the original public tests and no
generated probes. Direct strong and direct Luna each remained at 13/16 full
tests while passing all nine public tests and syntax checks. Their incremental
costs were $0.028901 and $0.001600, respectively.

Clarification alone therefore did not reproduce the one-test improvement in
this run. The verifier paths also had an additional model call, so the result
does not isolate test feedback from an extra repair opportunity. Every arm
still failed acceptance, and this exposed task cannot qualify a deployment or
generalized capability gain.

| Experiment | Protocol SHA-256 | Terminal audit SHA-256 |
| --- | --- | --- |
| Access repair | `e82469b8ad511eada707ff1d2e1954387f6c5cace54baa97fb35c34a89a31771` | `db69842acfadf154cf092a6372c64f44a15419604a86695f04833a4ddb0097f5` |
| Initial verifier diagnostic | `4288605099edff9825ca0e3c923eb03e64a72c10e930d3a4771e5366a9250e49` | `b23c1f66ce89d015fe8a29db77470530974225ddf318facb7010c0b7ba4ed443` |
| Corrected verifier diagnostic | `0304c9bee41b50c2eb7a69d961f3514fc42b895d00bc21591f34ccd14dd121ad` | `8f3378c2aa45a35d9b3be298f44ee8a1acef3b533127411e855157acc09cbb0f` |
| Clarification-only control | `689aeb2eb1fef5776ed5343ad2e1ca939b37167a2da5d07ac66453b033bc40b5` | `55be5f78cb91d236a52fe2cb66b8c06df6d7b111390fe396f43eadb1d9ba40ea` |

These identify private receipts, not an independently reproducible bundled
benchmark. No production routing, model selection or deployment changed.

## Node-only cheap-first check, 2026-11-24

A subsequent [Cloudflare KV provisioning repair](https://github.com/openclaw/clawrouter/pull/219)
passed all 32 final tests with both GPT-6.2 Sol and GPT-6 Luna. The checked
cheap-first policy retained the Luna draft and used **94.88% less model cost**
than the direct strong control on this task. No planner or correction ran, so
this is another cheap-sufficient result, not a collaboration capability gain.

| Arm | Full tests passed | Public tests passed | Node syntax | Model cost | Model seconds |
| --- | ---: | ---: | --- | ---: | ---: |
| Direct GPT-6.2 Sol | 32/32 | 31/31 | Pass | $0.031546 | 9.527 |
| Checked GPT-6 Luna | 32/32 | 31/31 | Pass | $0.001616 | 7.927 |

The task was selected from a fixed local-history discovery order after excluding
prior model-request exposure and unsuitable runtime candidates. The reference
passed all 32 full and 31 public tests. The unchanged baseline executed the same
counts, failing 22 full and 21 public tests. All suites had zero skips. One new
test group was held out by the existing deterministic hash split before model
calls; unchanged groups and two changed groups remained public.

This used the existing cached Node 24.22.1 image with its entire source/dependency
seed masked. Only two original script modules and one original JSON configuration
file were copied in. The sandbox had no external network or host mounts, and
candidate execution could not modify the protected tests. The original fixtures
mocked child-process commands and Cloudflare fetches; no cloud resource was
created. Node syntax checks do not constitute TypeScript type checking.

Direct controls received identical public request bodies except model identity.
The policy reused the Luna call, charged once across the experiment. Total new
model spend was **$0.033162**. Model seconds exclude local verification and are
not end-to-end latency. The planned strong/Luna planner comparison did not run
because the cheap draft passed its public gate; duplicate policy result rows
are not additional independent trials.

The terminal audit replayed all requests, public decisions, full grades and
accounting without new inference. Protocol SHA-256:
`7d9569ab7a8f793a3dedcdcf76acb23903c718dd9486b1bba8ba3ed4a18d7c39`;
audit SHA-256:
`21c05d50b291cdf5706ad85569b25d3173ea4e7979ea7d8df2b73f87be2d281b`.
These identify private receipts, not a bundled independent reproduction suite.
This single convenience-sampled historical task does not establish statistical
reliability, independence from model training, production savings or a routing
default. It also did not exercise the new invalid-edit preservation behavior.

## Fresh public-controller routing pilot

The [six-task routing pilot](fusion-public-repair-pilot.md) uses the public
cheap-repair controller on locally unexposed cases. It matches strong-only
quality at 26.4% lower model cost and 18.3% more workflow time, while cheap-only
solves four of six tasks. All outcomes and replay-audit evidence are retained.
This passes the declared pilot screen; it does not qualify production routing
or demonstrate a cross-model rescue.

## Native three-attempt confirmation

The [30-task native confirmation](fusion-native-three-attempt-study.md) matched
strong-only at 90/90 samples, versus 85/90 cheap-only, with 52.71% lower model
cost and 15.80% more mean workflow time. Its three-call opt-in passes the frozen
point-estimate screen; the latency interval crosses that screen's 20% limit.
The report retains the failed two-call predecessor and a separate cheap-sufficient
transfer smoke check. Previously exposed tasks and limited held-out preservation
checks prevent production qualification.

## Public repair repeatability

The [three-repeat study](fusion-public-repair-repeats.md) keeps the first fresh
six-task pilot separate and reports 54 new outcomes on those same six exposed
tasks. Its aggregate passes the frozen cost, time and quality screen, with one
failed repeat retained. This supports broader testing of the opt-in workflow;
it does not change routing defaults or qualify a production gain.

`summarizeRepeatability(records, taskIds)` retains the six-task default. Declare
a different cohort size before collecting results with `{ expectedTasks: 12 }`.
The helper still requires every task and all three strategies in each of three
repeats; 12 tasks produce 36 paired samples, not 36 independent tasks.

For `{ costBasis: 'invoice-and-cache-neutral-v1' }`, every record must include
`normalizedMicros`. Both invoice and cache-neutral cost ratios must pass the
20% savings gate, alongside the existing quality and workflow-time checks.
Missing normalized costs fail validation rather than falling back to invoices.

## Twelve-task routing pilot

The [combined cohort pilot](fusion-cross-cohort-pilot.md) matched strong quality
on twelve repairs while cheap alone passed six. Its 19.51% model-cost saving
missed the fixed 20% gate; workflow time increased 14.06%. All 36 outcomes and both
original screening shortfalls are retained. This is not a production qualification.

## One-cheap-attempt repeatability

The [three-draw development report](fusion-one-cheap-repeats.md) compares one
cheap attempt followed by verified fresh strong fallback against both controls.
On twelve exposed tasks sampled three times, cascade and strong each pass
36/36 while cheap passes 24/36. Cascade model cost falls 50.92%, with 8.06% more
workflow time. All three draws pass the declared efficiency screen; these are
twelve tasks, not thirty-six independent examples. The report includes the
caller-side recipe, every outcome and the failed earlier policy for context.
It does not change production routing or qualify the Worker ensemble endpoint.

## Thirty-task development transfer

The [complete thirty-task follow-up](fusion-transfer30-baseline.md) fails the
quality-preservation and time gates despite 40.18% lower model cost. Cascade and
strong each solve 27/30, but the cascade loses one strong-only success and solves
a different task; workflow time rises 28.06%. Cheap-only solves 24/30. These are
thirty exposed tasks in one repository, divided into accounting batches, not
three repeated draws. The report retains every outcome and all three terminal replay audits; it does
not qualify production routing.

The [anchored-edit follow-up](fusion-anchored-transfer30.md) retains the same
thirty tasks and original fixtures. Cascade and strong each solve 29/30 with
zero lost strong successes, while cheap solves 22/30. Model cost falls 27.41%,
but workflow time rises 77.86%, failing the time gate. These are new draws on
exposed tasks, not causal evidence that anchors fixed the prior quality loss.

The [first-failure feedback follow-up](fusion-first-failure-transfer30.md)
passes the complete development screen: cascade and strong both solve 29/30,
with 38.84% lower model cost and 2.35% less workflow time for the cascade.
All ninety outcomes and three exact replay audits are retained. This remains
one draw on the same exposed repository, not production qualification.

The [exact-anchor recovery repeat](fusion-hard-anchor-study.md) also scores
29/30 for cascade and strong-only, with 23/30 for cheap-only. Estimated model
cost falls 41.65%, but workflow time rises 13.97%, failing its stricter
no-slowdown gate. All thirty tasks, ninety outcomes and 118 calls passed replay
audits. The report retains the failed recovery candidates and shows that three
recovered final outputs helped the cheap-only control; no recovered cascade
draft directly completed a task in this draw.

## SemVer task-transfer smoke

The [SemVer pilot and transfer report](fusion-semver-transfer.md) retains a
cost-increasing initial policy, an exposed development repeat and two new
same-package tasks. On the two admitted transfer tasks, cascade and strong
both solve 2/2 while cheap solves 1/2; replayed model cost falls 43.42%, or
44.17% without cache discounts. Two other candidates failed model-free
qualification and received no model calls. This small paired replay does not
qualify production behavior or live workflow latency.


## Exact-anchor recovery check

The [recovery-enabled LRU development check](fusion-anchor-recovery-study.md)
scored 9/9 for cascade and strong-only, versus 7/9 for independent cheap-only.
The cascade used 68.61% less estimated model cost and 15.71% less aggregate
workflow time. Its repeated-development gate still failed: one round was
slower, and another tied cheap-only quality. Three already exposed tasks were
sampled three times; no production or routing-default change is qualified.

## Fresh-package cost and latency check

The [six-task fresh-package comparison](fusion-fresh-package-study.md) matched
strong-only at 6/6, versus independent cheap-only at 4/6. Estimated model cost
fell 55.88%, but workflow time increased 24.68%, failing the frozen no-slowdown
gate. All 18 arms, 20 calls and ten candidate qualifications are retained. The
result supports a cost/latency tradeoff, not an overall or production gain.

The [repair-fallback follow-up](fusion-repair-latency-study.md) reduced paired
fallback API time by 24.19%, but failed its component cost gate. A complete
six-task development replay then scored 6/6 in every arm: cascade used 70.12%
less model cost than strong-only but took 3.40% longer, while cheap-only was
both cheaper and faster. Neither experiment qualifies an overall gain.

The [three-round LRU-cache comparison](fusion-lru-repeat-study.md) scored 9/9
for cascade and strong-only, versus 5/9 for independent cheap-only. Aggregate
model cost fell 51.92% and workflow time fell 3.31%, but two rounds were slower
than strong-only. The stricter repeated-development gate failed. These are
three independent tasks sampled three times, not nine independent tasks.
A zero-call follow-up recovered every rejected cheap edit through a unique
exact-source match, and all seven recovered batches passed the original tests.
The observed quality gap reflects edit-format rejection on this sample;
prospective decoder validation is still required.


## Fresh URI transfer check

The [four-task URI comparison](fusion-uri-transfer-study.md) passed 4/4 in all
three arms. Cascade cost 66.60% less and took 8.04% less workflow time than
strong-only, but independent cheap-only matched quality at 80.39% less cost
and 25.59% less time than cascade. The fusion-value gate failed. All six
candidate qualifications, twelve arms and thirteen calls are retained.
## Cheap-repair policy follow-up

The [matched cheap-repair study](fusion-native-cheap-repair-study.md) rejects replacing
the first strong fallback with another cheap attempt: 29/30 passes versus
30/30 for the current cascade, with 17.12% savings and 11.05% more workflow time.
It does not change the opt-in serving policy or qualify production defaults.
