# Kie Market jobs

`worker/kie-jobs.ts` is the focused protocol adapter. The executable synthetic
wire/result fixture is `providers/_fixtures/kie/jobs.json`. No provider manifest or
raw task-ID route is enabled by this slice. Run
`node --test worker/test/kie-jobs.test.mjs` without dependencies.

Use bearer auth at `https://api.kie.ai`: submit `/api/v1/jobs/createTask`, then read
`/api/v1/jobs/recordInfo?taskId=...`. Reject callbacks for this polling slice.
Bind the returned task ID to the original caller, policy, credential and selected
model before returning it. Resolve that binding before polling; never select a
different credential or replay an uncertain create. The runtime owns bounded
response reads, retry/backoff, read deadlines and one immutable terminal receipt.

HTTP 200 alone is insufficient: the envelope must contain numeric `code: 200`.
Authentication and unknown/foreign-task errors can arrive inside HTTP 200. They
do not establish terminal job failure. `waiting`, `queuing` and `generating` stay
open even with partial output. `success` and `fail` are terminal. A malformed
result does not undo a known terminal status; it prevents output qualification.
See [task details](https://docs.kie.ai/market/common/get-task-detail).

The adapter bounds envelopes to 1 MiB, IDs to 128 ASCII characters and output
lists to 64 URLs of at most 8192 characters each. These are router limits. Output
URLs are transient data and never authenticated control destinations. Downloaders
must enforce their own SSRF, origin and byte limits without forwarding provider
credentials. Do not persist input, param, resultJson, failure text or media URLs
in scoped ownership/accounting records.

No scoped cancellation endpoint is qualified here. Caller disconnect and a local
timeout do not stop upstream work. Native `creditsConsumed` is credit usage, not
dollars; missing credits do not imply zero. Hard budgets require a frozen model
tariff and whole-job bound or explicit `policy_fixed` pricing before dispatch.
Generated files are documented as retained for 14 days; that is independent of
router ownership and accounting retention. Real Worker lifecycle integration,
model-specific tariffs and consumer acceptance remain required.
