# Low-cost Fusion research and screening

Research reviewed on 2026-11-05. Keep production Fusion opt-in. This plan tests
the mechanism before paying for another frontier-model comparison.

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

These are results from different datasets, model pools, graders and budgets.
Their headline improvements are not expected ClawRouter gains. Preprints have
less validation than a reproduced, held-out result in this workload.

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
case: requests that already require executable verification. They need a new,
predeclared confirmation for that workload. Against strong single returning
before verification, the cascade was 37.5% slower, so the original latency gate
still failed. Neither failed gate is replaced by the secondary comparison.

The resident run reused exposed tasks and repeated each twice. Its paired
task-bootstrap 95% latency-ratio interval was [0.549, 0.874] against verified
strong repair and [1.026, 1.820] against unverified strong single. This is local
timing evidence, not new-task quality evidence or a production latency promise.

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
