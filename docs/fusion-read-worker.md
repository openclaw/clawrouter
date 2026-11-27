# Read-only Fusion research helper

`scripts/fusion-read-worker.mjs` exports `runReadWorker` for opt-in experiments.
It does not activate a route or change production inference. The caller provides
a source snapshot, a short investigation brief, and an async `invoke` callback.
The callback receives chat messages, a JSON response schema, an abort signal,
and the one-based call number. It returns the parsed action object.

The helper permits literal search, line-range reads, and an evidence report.
The provider schema restricts selectors and citations to admitted file paths.
Only caller-admitted source is visible. It cannot load files, edit code, run
tests, or call a provider by itself. The caller owns source admission, provider
credentials, pricing, spend reservation, timeouts, and refusal handling.
Provider errors propagate without retry.

Calls are bounded to one through four; the default is three. The last call's
schema permits only a report, and every call includes the remaining budget.
With one call, no source can be read: the worker must report insufficient
evidence. Context and excerpt sizes have separate hard limits. Excerpts that cannot fit
are omitted and the next call is restricted to reporting; omitted lines never
count as observed.

A successful result contains an untrusted summary and literal excerpts, with
source and snapshot hashes. Every cited line must have been observed. This
checks provenance, not whether the summary is true, complete, or useful. An
insufficient result or exhausted call budget does not count as acceptance.
The parent must verify findings and retain ownership of edits and validation.

This primitive has no demonstrated quality or cost advantage over a single
model. Evaluate any orchestration against direct and instruction-matched
controls, charging every call and measuring end-to-end latency.

Run the isolated contract tests with:

```sh
node --test test/fusion-read-worker.test.mjs
```
