# Live Fusion pilot

Manually dispatch `Benchmark Fusion` on the reviewed named branch and supply its
full commit SHA as `expected_sha`. The workflow rejects a different checkout.
Select `native` for the existing OpenAI and Anthropic repository test keys, or
`openrouter` for the existing OpenRouter key. Routes never fall back automatically.
It does not deploy or change production configuration.

`package_only` builds and tests a standalone Node runner without accessing keys.
Download `fusion-runner-<sha>` within one day, set `GITHUB_SHA` to that verified
workflow SHA, select the transport and inject credentials into its process.
The bundle includes the actual composition module and frozen dependencies;
no local dependency installation or shared-secret replacement is required.

The runner imports the real Fusion composition module. It compares GPT-6 Luna
alone, GPT-6.1 Sol alone, Claude Sonnet 5.5 alone, and Luna synthesizing independent
Sol and Sonnet proposals. Every pool member has its own baseline. All calls use
medium reasoning and a 4,096-token output cap.
Advisers have a 120-second deadline; individual HTTP requests have a 90-second
deadline. No tools, retries, fallback models or model-generated graders run.

Twenty-four BIG-Bench Hard tasks come from three domains at a pinned dataset commit.
A fixed hash selects eight examples per domain without looking at answers. Each
strategy sees the same tasks. Execution order rotates between cases. Final JSON
answers are scored by exact match against the dataset's answer key. This is a
small public-task pilot: model training contamination is unknown, and one trial
per task cannot establish robust frontier performance or production latency.

The whole-run cost preflight uses conservative input byte bounds, full output
allowances and the largest applicable published input/output price tiers. An
input-byte upper bound rules out long-context tiers only when it is below their
token threshold. A second guard
reserves each call before dispatch and caps total reservations at $5. Set
`prior_reservation_micros` to carry uncertain spend from a previous attempt into
that same ceiling; an unknown charge must not be treated as zero. This is an
application-side bound based on provider pricing and token-limit compliance,
not an account-level spending limit. Missing usage cost, transport uncertainty,
or a reported cost above its reservation stops further calls. Incomplete runs
remain incomplete and must not be compared as if missing pairs scored zero.

Native calls use published standard-tier tariffs and measured token usage,
including reasoning output and cache reads/writes. These are tariff estimates,
not invoice totals. OpenRouter calls require its reported dollar cost. Native
model discovery must succeed before inference, and unsupported usage or service
tiers stop measurement. Pricing sources and the transport are recorded.

Artifacts contain only score records, costs with their measurement basis, timings, call
counts, serving model/provider IDs, configuration and dataset provenance, and
the paired evaluator's report. Prompts, answers, reasoning and credentials are
never written or logged. Atomic checkpoints preserve completed records and
unknown in-flight costs on cancellation; only a completed run is comparable.
Download artifacts before the 14-day retention expires.

This measures the composition algorithm. It does not exercise the gateway's
credential authority, budget ledgers, transport adapters or production traffic.
Those remain separate integration and load-test obligations. Model aliases and
catalog slugs record declared identity, not proof of a provider's hidden weights.

## Original source context

Repair tasks may declare up to four `sourceContext` entries, each with a source
`path` and a unique literal `query`. The harness supplies eight surrounding lines
on each side from the original repository, capped at 24 KB total. Test files and
editable files cannot be context sources. Qualification rejects missing or
ambiguous selectors before inference. This helps workers use actual internal
identifiers instead of guessing them; it grants no additional edit permission.

For example, a pricing task can select `function validateGroqMistralTranscription(`
in `scripts/compile-providers.mjs`. Every comparison arm must receive the same
context. Changing a selector changes the task digest and requires qualification
again. Context is input evidence, not an acceptance test or a known repair.

## Analyze paired repair results

Run `node scripts/fusion-pair-analysis.mjs <pair.json>` on a complete native
repair comparison. It checks that each qualified task has every arm and that
row costs and call counts reconcile with settled attempts. Incomplete runs,
unknown charges and duplicate or missing outcomes are rejected.

The summary reports per-task wins and losses against each fixed control, total
cost, and the number of extra repairs available from choosing correctly between
the controls. It also compares the candidate with a task-independent random
mixture of the two controls at the candidate's observed cost, when that cost is
inside the control range. This mixture is a computed expectation from the
control observations, not an additional executed benchmark.

Equal aggregate scores can conceal regressions on different tasks. The reported
cost-saving flag therefore requires no lost strong-model repair. These are
observations from the supplied run, not statistical significance, a signed
attestation, or approval to change production routing. Prior campaign expenses
remain in the spending ledger but are excluded from per-arm comparisons.

### Declared-scope routing experiment

Set `FUSION_PAIR_POLICY=scope` on the native paired repair runner to replace
the architect arm with a deterministic selection: one editable source file uses
the cheap model, while multiple editable files use the strong model. All arms
receive initial editable source and the same call, time, and spending limits.
The report records the selected model and charges only calls actually made.

This is a benchmark hypothesis, not a production classifier. It requires the
caller to provide a trustworthy repair scope before inference; it cannot infer
that scope from an arbitrary prompt. Freeze the rule before evaluating unseen
tasks, and compare complete paired cohorts. Passing visible tests or receiving
a model's approval does not establish correctness; isolated acceptance decides
the score. The scope policy does not use acceptance outcomes to select models.

`benchmarks/fusion/scope-workloads.json` declares a separate prospective cohort.
Its `development` schema label does not prove it is unseen: report exposure
history and source revisions with each run. Qualify all four baseline/oracle
checks before inference. This option does not change production routing.

### Small-model evidence, 2026-11-07

These are single-trial repository repairs with isolated acceptance tests. The
controls receive the same initial editable source, and execution order rotates.
Do not combine cohorts or interpret a passing visible test as a correct repair.

| Cohort and limits | Cheap only | Strong only | Review cascade |
| --- | --- | --- | --- |
| Four development repairs; 12 calls, 300 seconds | 3/4; $0.054320 | 3/4; $0.543629 | Not matched at these limits |
| Two prospectively frozen repairs; 24 calls, 600 seconds | 1/2; $0.019827 | 2/2; $0.518835 | 1/2; $0.065743 |

Cheap is GPT-6 Luna with no reasoning; strong is GPT-6.1 Sol with medium
reasoning. Both use an 8192 output-token ceiling. Costs are published-tariff
estimates applied to reported usage, not invoice totals. The development tasks
are `gmi-unified-selectors`, `bedrock-error-message`, `responses-literal-path`,
and `unpriced-native-speech`. The prospective tasks are
`sigv4-encoded-query` and `opaque-responses-input`.

The development result is a 90.0% cost reduction at the same observed score.
The holdout shows why that is not evidence of general quality parity: the
strong control solved an accounting repair that the cheap control missed.
A strong textual reviewer also accepted a cheap accounting candidate with two
failing acceptance tests. Those independent test results were recorded only
for diagnosis and were never shown to the policy. Textual approval is not a
validated substitute for execution.

The review policy was frozen at source `c8cb06187aabe7d261cd4deba74acd2b87d5cdce`
before holdout exposure. It permits up to 12 cheap-author calls, one strong
review, and strong revision after rejection, all within the 24-call total.
The equal-source development controls used source
`eb03ad5` and the same agent implementation; source preloading is the explicit
configuration difference from earlier controls without it.

The declared-scope experiment uses `scope-workloads.json`. All three fixtures
pass original-visible and oracle-visible checks; broken acceptance fails in
3, 4 and 10 tests respectively, and each oracle passes its full acceptance
suite. The completed HTTP/1.1 campaign at source `df967b4` gave every arm
24 calls and 600 seconds. Cheap-only solved 1/3 for $0.095080, strong-only 1/3
for $0.999845, and scope routing 1/3 for $0.433089. Every arm solved Runway and
missed both remaining repairs. Scope added no quality over cheap-only or the
matched-cost random-mixture expectation. Earlier HTTP 503 and transport-failed
attempts remain incomplete; their unknown-call reservations stay in the
campaign spending ledger and are excluded from these per-arm comparisons.

Current recommendation: inexpensive models are useful smoke-test workers, but
keep correctness checks external and measure the quality loss on held-out
repairs. No measured multi-model quality improvement has been established by
these experiments, and no production default changes follow from them.

### Independent check-policy holdout

`benchmarks/fusion/check-holdout-workloads.json` pins three further repairs:
StepFun inclusive cache accounting, Cohere observed versus billed usage, and
scalar fal music MIME validation. Qualify unchanged visible tests, oracle-visible
tests, original acceptance failure and repaired acceptance success before any
model call. Freeze the policy before exposing these instructions to a model.
The schema label `development` is not evidence of exposure history; record
that history with results. Selection and qualification alone do not establish
a performance improvement.

### Executable-check experiment

`FUSION_PAIR_POLICY=contract` replaces the third paired arm with a strong test
author and cheap repair worker. The test author has up to two calls to produce
a probe that fails with an assertion on the original source. The cheap worker
gets at most ten calls and sees the frozen probe. A fresh sandbox checks its
candidate; a failed check or visible suite triggers strong repair from the
original source with the remaining call and time allowance. Invalid probes
also fall back to strong repair. Known-cost truncated or empty test-author
responses consume one of the same two attempts; uncertain charges and refusals
still stop the campaign. Every model call uses the shared trial ledger.

Generated checks can be incomplete or wrong. The fallback's probe result is
reported but does not replace independent acceptance. Reports retain only the
probe digest and finite outcomes, not its source. This experimental option
does not change production routing or claim a quality improvement.

The initial three-task executable-check development run at `694d0f4` solved
1/3 in every arm: cheap-only $0.131493, strong-only $0.897908, generated-check
policy $0.463669. Runway passed after escalation. The pricing candidate passed
its generated check but failed four independent acceptance tests. Native
routing failed when test generation exceeded its output limit. This is no
quality gain and no reason to activate the policy. Subsequent fallback changes
are a new policy revision and need their own evaluation.


### Context and independent contract results

At source `fc759001d012cd9f5e0aa3274ddb83424d275d1e`, an exposed pricing
repair received the same original compiler declarations and accounting consumer
excerpt in every arm. Cheap-only failed; strong-only and contract each passed
all 76 acceptance tests. Contract cost $0.081922 versus $0.266505 for strong,
a 69.26% observed saving. It took 50.9 seconds versus 30.9 seconds. This is one
development task, not evidence of general superiority or model-diversity benefit.

The same policy was then frozen before first model exposure to the three tasks
in `check-holdout-workloads.json`. Every arm had 24 calls, 600 seconds and an
8192 output-token ceiling per trial. Costs include all policy calls and failures.

| Arm | Correct repairs | Cost | Calls | Sum of trial time |
| --- | --- | --- | --- | --- |
| Cheap only | 1/3 | $0.071127 | 31 | 168.6 s |
| Strong only | 2/3 | $1.211077 | 43 | 198.7 s |
| Contract | 2/3 | $1.183577 | 52 | 394.9 s |

Strong and contract both solved StepFun cache accounting and scalar fal MIME;
all arms missed Cohere billed units. Cheap's StepFun trial ended with a
known-cost truncated response and remains a failed trial. Contract's Cohere
candidate passed its generated probe but failed independent acceptance.
The 2.27% aggregate cost saving comes with nearly twice the elapsed time and
no quality gain over strong-only. Three single-trial repairs do not establish
a reliable cost advantage. Same-workflow single-model controls are needed
before attributing any observed benefit to mixing models. These results do not
justify changing production defaults.

### Second independent contract cohort

The same policy at source `3e4f0ad2d2dfa89fa766a207b9b38b131248586e`
was tested on three newly exposed qualified repairs: Titan Multimodal errors,
declared native identity and scalar-only native music response context. The
call, output and time limits matched the first independent cohort.

| Arm | Correct repairs | Cost |
| --- | --- | --- |
| Cheap only | 1/3 | $0.029479 |
| Strong only | 2/3 | $0.403979 |
| Contract | 1/3 | $0.494573 |

All arms passed Titan and missed music. Strong alone passed native identity;
contract accepted an incorrect cheap patch after its generated check passed.
The music fallback also passed its generated check but failed acceptance.

Across both independent cohorts, cheap solved 2/6 for $0.100606, strong 4/6
for $1.615056, and contract 3/6 for $1.678150. Summed trial time was 312.2,
300.0 and 696.1 seconds respectively. The original contract policy fails the
predeclared screen: no strong-model regression, at least 20% cost saving,
and no more than twice strong-model elapsed time. This rules out promoting
that policy based on these experiments. Generated checks remain fallible.

### Private contract checks

Set `FUSION_PAIR_POLICY=contract-private` to keep the generated regression
probe out of the cheap worker's context. The author still writes and qualifies
the probe against original source, then the cheap worker repairs independently.
The coordinator checks the returned patch in a fresh sandbox. On failure, the
strong fallback receives the probe and diagnostic feedback. Call and spending
limits, fixed controls, and final independent acceptance remain unchanged.

This tests whether exposing an incomplete generated check steers the worker
toward that check rather than the full requirement. It does not make generated
checks complete or trustworthy. The report names the policy and records
`contractExposed: false`; no quality or cost improvement is presumed.

The first development ablation with private checks solved 2/3 repairs for
$0.697378 and took 357.2 seconds. It recovered the native-identity failure but
still missed music. The earlier direct strong control solved 2/3 for $0.403979
in 101.3 seconds. These non-contemporaneous observations show no economic
advantage and do not justify promotion.

### Same-workflow contract controls

Set `FUSION_PAIR_POLICY=contract-cheap` or `contract-strong` to run the same
contract workflow with one model handling every role. These controls preserve
test generation, qualification, cheap-stage turn allocation and fallback; only
the model assignment changes. The report names the selected policy and records
the actual model and cost for every call. Fixed cheap-only and strong-only arms
still run alongside each policy.

Compare these controls with `contract` on the same qualified tasks, source and
limits before attributing a benefit to mixed models. Different call counts can
result from different model decisions. A lower price on one exposed task does
not establish general superiority or production readiness.


For a standalone ablation, set `FUSION_PAIR_CONTROLS=0` (or pass
`includeControls: false` to the runner). This runs only the selected contract
policy and labels the report `native-policy-repository`; it is not a complete
paired comparison and the paired analyzer rejects it. Use this to avoid paying
for repeated fixed controls, and disclose any comparison to earlier controls as
non-contemporaneous. The default still runs all three arms. Budget admission
retains the conservative three-arm reservation bound.

### Supplied-reproducer workflow

`contract-provided` evaluates a distinct coding workflow where the request
already contains a regression reproducer. The fixture records the bounded
probe in `reproducer`. Qualification requires it to fail with an assertion on
the original source and pass on the historical repair, alongside all existing
visible and independent acceptance checks. Every baseline receives the same
probe. The cascade executes it against each candidate and escalates after a
failed check; it makes no model call to author a test.

The GMI selectors, literal Responses path and Voyage usage fixtures pin this
input contract. Their supplied reproducers cover an observable reported bug;
the separate acceptance suites cover additional behavior. Do not compare this
workflow with tests-hidden baselines or call its reproducers independent final
acceptance. Generated-check results remain separate and unchanged.

First three-task paired trial: cheap solved 2/3 for $0.041099, strong 3/3
for $0.524965, and supplied-reproducer cascade 3/3 for $0.581189. Summed
elapsed times were 143.635s, 101.497s and 176.300s respectively. The cascade
retained quality but cost 10.71% more than strong, failing the predeclared
20% saving screen. This is a small pilot, not deployment evidence.

`contract-handoff` keeps the supplied-reproducer workflow and call limits but
installs a failed cheap candidate in the strong executor's fresh sandbox. The
strong worker sees the current source and failure feedback, treats the patch as
untrusted, and can repair it. Only allowed source files transfer; tests and
predecessor conversation history do not. The supplied probe and final hidden
acceptance still run independently. `contract-provided` continues to restart
from original source. This opt-in benchmark is a development hypothesis, not a
production routing default or demonstrated improvement.
