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
