# Fusion on repository work

The BBH pilot is a transport/composition smoke test. It does not justify a
product-quality claim. This development corpus measures whether an agent can
repair real repository regressions while preserving existing behavior.

## Task contract

`benchmarks/fusion/workloads.json` pins each broken parent and its known repaired
child. The agent receives the problem statement, parent source and existing
tests. It does not receive the fix revision, fixed source, or new regression
tests. These recent public tasks are development data, not a private holdout.

The first corpus covers catalog protocol validation, native model identity,
streaming response ownership, and Copilot catalog/request identity. Only the
declared source files are writable. Source dependencies remain readable.

## Qualification

Use a Node 24.22.1 slim image pinned by its pulled manifest digest:

```sh
node scripts/qualify-fusion-workloads.mjs node@sha256:<digest> /tmp/qualification.json
```

The command builds frozen dependency images from Git blobs, without installing
into the checkout. Each task must satisfy all three checks:

1. The parent's visible tests pass.
2. The parent fails the fixed revision's regression tests.
3. Replacing only the permitted source files with the known repair passes both.

All three use the same container image and test commands. A test process that
does not produce a complete, nonempty TAP summary does not qualify. A failed
qualification must be repaired or excluded before model inference.

Containers run as an unprivileged user with CPU, memory and process limits, a
read-only root, no network, no credentials and no host bind mounts. Each trial
gets a fresh writable work directory. Final verification runs in another fresh
container; only permitted source files cross that boundary. The known repair
and hidden tests never enter the agent's container. Builds can access package
registries to install the repository's frozen trusted dependencies.

The receipt stores revision/task/image identities, pass/fail counts and output
hashes, not test logs or model content. Task-owned image tags remain available
for the subsequent agent run. Do not remove images or containers from unrelated
sessions. Container isolation and hidden tests do not make arbitrary generated
code tamper-proof; inspect suspicious solutions and verifier behavior before
any quality claim.

## Experimental controls

Compare cheap and strong single agents with the same tools, source, test
feedback, dollar ceiling and wall-clock deadline. A strong baseline can revise
its patch using the remaining budget. Compare the existing Panel separately
from a test-gated cheap-to-strong cascade. Later, test cheap planning support
with a strong implementer; do not assume cheap implementation is equivalent.

Charge every model turn, rejected draft and checker. Preserve unknown charges
as reservations. Report completed tasks within budget, regression preservation,
latency, spend, escalation and harmful advice. Do not pool development and
holdout results or count failed/incomplete trials as missing data.

Freeze strategies on development data before a broader private evaluation.
An efficacy claim needs repeated unseen tasks, a predeclared comparison and
uncertainty clustered by task. Product rollout remains gated on those results.

## Research basis

- [GitHub Fusion](https://docs.github.com/en/copilot/concepts/models/copilot-fusion)
  uses Single, Cascade and Critique, selected at runtime.
- [Coding-agent allocation study](https://arxiv.org/abs/2610.17471) motivates
  testing planning, implementation and verification separately. Its reported
  configurations are not matched-budget experiments.
- [Terminal-Bench 2.1](https://www.tbench.ai/news/terminal-bench-2-1) repaired 28
  tasks, showing why environment and oracle qualification matter.
- [Harbor's separate verifier](https://docs.harborframework.com/tasks/separate-verifier)
  is the interoperability target for a later full agent benchmark adapter.

## Agent comparison

The credential-free `Benchmark Fusion` package-only workflow also produces
`fusion-agent-benchmark.mjs`. Run that artifact from this repository checkout
with the qualified local task images and `GITHUB_SHA` set to the packaging SHA.
Inject existing `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` only into the host process;
they never enter the execution containers. Use the selected network proxy for
Node explicitly when required by the local connection.

```sh
node /path/to/fusion-agent-benchmark.mjs /path/to/qualification.json /path/to/fresh-results
node scripts/evaluate-fusion.mjs /path/to/fresh-results/runs.json --baseline strong --development
```

The initial calibration is four tasks, four strategies and one trial per pair:
Luna, Sol, the existing Luna/Sol/Claude Panel, and a test-gated cascade. Every
agent can inspect source, apply exact search/replace edits, and run the same
visible tests. Sol is a multi-turn baseline with repair opportunities, not a
one-shot answer. All agents get ten turns, a three-minute agent deadline and a
$0.20 inference ceiling. Panel spends its extra calls within that same ceiling.
The campaign also carries the previous $0.190914 usage/uncertainty ledger and
has a $5 combined ceiling. Known settled savings may be used; unknown costs
remain reserved and block more inference. An interrupted trial is recorded with
error status and zero score; the campaign remains incomplete. Do not treat a
reservation as a confirmed charge or silently start a replacement campaign.

Cascade gives Luna two turns. Passing the visible tests accepts that result;
otherwise Sol continues in the same workspace. Hidden tests then measure false
acceptance. This rule is deliberately inspectable, not a learned router or a
claim that visible tests fully prove correctness.

Records remain labeled `development`, and the evaluator requires an explicit
`--development` flag. Results include final hidden-test success, all model
charges, full trial wall time, tool time, escalation, invalid actions, failed
advisers, public-test false acceptance and source hashes. Bounded action/error labels and model finish reasons explain failed trials.
Source and model responses are not saved. Exact private-test counts must match the known repair.
No trained router, product strategy or deployment is enabled by this harness.
