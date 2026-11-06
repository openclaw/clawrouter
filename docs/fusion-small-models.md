# Low-cost Fusion research and screening

Research reviewed on 2026-11-05. Keep production Fusion opt-in. This plan tests
the mechanism before paying for another frontier-model comparison.

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
their digests again afterward. It never invokes a paid provider. Role labels
inside the reused harness map explicitly to these local model pins.

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
