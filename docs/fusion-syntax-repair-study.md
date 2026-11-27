# Retaining a rejected draft for cheap repair

One exposed development task passed all 48 full-suite tests after a cheap model
repaired its syntax-invalid draft. Estimated model cost was $0.003890, compared
with $0.016048 for the recorded direct strong-model control: 75.76% lower.
This is a single-task adapter diagnostic, not population or production evidence.
The successful path used the cheap model twice; it does not establish a benefit
from different models collaborating.

| Variant | Calls | Full tests passed | Model cost | Workflow time |
| --- | --- | ---: | ---: | ---: |
| Original cascade | Luna, Terra | 48/48 | $0.018032 | 16.798 s |
| Direct strong control | Terra | 48/48 | $0.016048 | 9.115 s |
| Retained draft and compact feedback | Luna, Luna | 48/48 | $0.003890 | Not comparable |

The original cascade cost 12.36% more and took 84.30% longer than its control.
Keep that negative result alongside the later improvement. The repair replay
reused the original initial draft and direct control, so it has no comparable
end-to-end latency measurement. It cannot pass a latency qualification gate.

## What changed

The initial draft decoded into source edits but had an extra closing brace.
The original adapter discarded the artifact after syntax verification failed.
That classified an editable draft as missing and skipped the cheap repair path.
Its feedback could also lose useful diagnostics when the previous full source
exceeded the feedback limit.

The corrected adapter retained the decoded artifact with a failed verification
verdict and supplied compact public diagnostics and previous edit operations.
This lets the existing caller-side controller attempt one cheap repair. A
failed repair can still escalate; an unreadable artifact or infrastructure
failure must not be treated as a verified source-level rejection.

The [compact feedback helper](https://github.com/openclaw/clawrouter/pull/1491)
preserves diagnostics before optional edits and bounds the serialized payload.
It does not make repair decisions or change Worker routing defaults.

## Evidence and accounting

The [sanitized records](fusion-syntax-repair-study.json) contain four distinct
model-call receipts and three policy variants. The replay made only one new
call, costing $0.002053. Its policy cost still includes the reused $0.001837
initial draft. The direct $0.016048 control was reused without another charge.
Do not sum variant costs to calculate actual spend: variants share calls.
The four unique recorded calls total $0.036133 across both experiments.

The task is the historical
[pair-analysis fix](https://github.com/openclaw/clawrouter/commit/020fbdbf8304c37029bdf5bebaac4dcdb67e55ff).
Native qualification required complete reference passes and parent failures in
the full, public and hidden views, with exact counts of 48, 47 and 1. The public
tests and source were visible during generation; hidden grading followed the
repair. The same fixed task and test views were retained across the experiments.
Protocol, result and test-view hashes identify the saved evidence; the hashes
alone are not an independent audit of private call artifacts.

The repair was designed after observing this task's failure. It is neither a
fresh task nor an independent repeat. Artifact retention and feedback compaction
changed together, so this trial does not isolate their individual effects.
Costs use frozen tariffs and recorded usage, not invoice reconciliation. A
larger distinct cohort, independent repeats and comparable end-to-end timing
remain necessary before promoting the policy.
