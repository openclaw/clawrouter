# Sequential workflow timing

Model calls can become faster while the complete workflow slows down. Use
`summarizeSequentialTiming` to report both. This offline helper subtracts summed
recorded call durations from each complete workflow's wall time. It does not
change routing, verification, budgets or production defaults.

```js
import { summarizeSequentialTiming } from '../scripts/fusion-sequential-timing.mjs';

const report = summarizeSequentialTiming(records, declaredTaskIds, {
  execution: 'sequential',
});
console.log(report.totals.cascade);
// { calls, workflowMs, recordedCallMs, otherWorkflowMs }
```

Supply exactly one row per declared task for each of `strong`, `cascade` and
`cheap`. Each row has these fields:

| Field | Meaning |
| --- | --- |
| `caseId`, `strategy` | The declared task and measured arm. |
| `complete: true` | The original workflow finished, including unsuccessful outcomes. |
| `timingReplayed: false` | This is original complete timing, not reconstructed interrupted timing. |
| `elapsedMs` | Complete workflow wall time, including its calls and public verification. |
| `attempts` | Number of invoked model calls, including rejected drafts and unsuccessful repairs. |
| `callElapsedMs` | One duration per invoked call, in the same wall-clock time domain. |

The helper requires explicit sequential execution. Summing parallel call times
and subtracting them from wall time is invalid even when that sum happens to fit
within the workflow duration. Missing calls, duplicate arms, unknown tasks,
replayed or incomplete timing, invalid durations and call sums larger than the
workflow fail validation. Preserve completed failures and their calls; do not
omit them to improve a report.

Callers own provenance: verify terminal evidence, call identity, completeness,
non-overlap and clock consistency before creating the rows. These assertions
cannot prove that externally supplied measurements are authentic. A terminal
audit may authenticate an original measurement without replacing its duration
with replay time. An interrupted run reconstructed from partial measurements
is ineligible here.

`otherWorkflowMs` is a residual, not CPU time or a verifier bill. It can contain
verification, orchestration, local setup and any waiting outside the recorded
model-call intervals. API call durations can themselves include network and
provider queue time. Later hidden grading, audit replay and unrelated work must
be excluded from both the workflow and its call durations. The report does not
establish quality, model-cost savings, service latency or production readiness.
