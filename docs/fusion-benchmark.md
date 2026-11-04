# Live Fusion pilot

Manually dispatch `Benchmark Fusion` with the full reviewed commit SHA, using
that exact ref. The workflow uses the existing repository OpenRouter test key.
It does not deploy or change production configuration.

The runner imports the real Fusion composition module. It compares GPT-6 Luna
alone, GPT-6.1 Sol alone, and Luna synthesizing independent Sol and Claude Sonnet
5.5 proposals. All calls use medium reasoning and a 4,096-token output cap.
Advisers have a 120-second deadline; individual HTTP requests have a 90-second
deadline. No tools, retries, fallback models or model-generated graders run.

Thirty BIG-Bench Hard tasks come from three domains at a pinned dataset commit.
A fixed hash selects ten examples per domain without looking at answers. Each
strategy sees the same tasks. Execution order rotates between cases. Final JSON
answers are scored by exact match against the dataset's answer key. This is a
small public-task pilot: model training contamination is unknown, and one trial
per task cannot establish robust frontier performance or production latency.

The whole-run cost preflight uses conservative input byte bounds, full output
allowances and the largest applicable published input/output price tiers. An
input-byte upper bound rules out long-context tiers only when it is below their
token threshold. A second guard
reserves each call before dispatch and caps total reservations at $5. This is an
application-side bound based on provider pricing and token-limit compliance,
not an account-level spending limit. Missing usage cost, transport uncertainty,
or a reported cost above its reservation stops further calls. Incomplete runs
remain incomplete and must not be compared as if missing pairs scored zero.

Artifacts contain only score records, provider-reported costs, timings, call
counts, serving model/provider IDs, configuration and dataset provenance, and
the paired evaluator's report. Prompts, answers, reasoning and credentials are
never written or logged. Atomic checkpoints preserve completed records and
unknown in-flight costs on cancellation; only a completed run is comparable.
Download artifacts before the 14-day retention expires.

This measures the composition algorithm. It does not exercise the gateway's
credential authority, budget ledgers, transport adapters or production traffic.
Those remain separate integration and load-test obligations. Model aliases and
catalog slugs record declared identity, not proof of a provider's hidden weights.
