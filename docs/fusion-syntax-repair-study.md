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

## Follow-up: two cheap repairs failed

A bounded follow-up on the original 30-task cohort did not reproduce the
single-task repair success. It selected both initially null artifacts before
the new calls: one syntax failure and one source exception. Both had saved
decoded source edits. Each received one new Luna repair with the retained edits
and compact public diagnostics. Both repairs became syntactically valid but
failed public tests. Each path then used its original, single-call, public-passing
fresh Terra control. Full tests confirmed both selected final artifacts.

The new calls cost $0.001226 combined. All policy totals below include reused
initial and strong calls at their original costs. The other 28 candidate
outcomes and both control arms are reused. The controller replay checks the
two modified paths, with public-only routing before full grading.

| Policy on the original cohort | Full-suite passes | Model cost, USD |
| --- | ---: | ---: |
| Original cheap-repair candidate | 29/30 | 0.063159 |
| Retained cheap repair, then cached fresh strong control | 30/30 | 0.060184 |
| Skip cheap repair, same cached controls (retrospective) | 30/30 | 0.058958 |
| Paired baseline | 30/30 | 0.076203 |
| Direct strong control | 30/30 | 0.217653 |

The reconstructed repaired policy is 21.02% below baseline, but **neither cheap
repair passed**. Omitting those failed calls would be 22.63% below baseline with
the same selected strong artifacts. That omission is a retrospective accounting
comparison, not another prospectively tested policy. This result supports
neither general cheap-repair promotion nor a cross-model collaboration claim.

Control reuse matters: the earlier [missing-draft escalation study](fusion-missing-draft-study.md)
made two new strong calls and reached 30/30 at $0.061164, only 19.74% below
baseline, failing the frozen 20% savings gate. Substituting different recorded
strong draws changes which side of that threshold the result falls on. The
current arithmetic pass does not establish a robust cost advantage.

The [sanitized follow-up records](fusion-retained-repair-followup.json) identify
the six distinct calls, their reuse and the private receipt hashes. These are
previously exposed tasks, not independent confirmation. There is no comparable
end-to-end timing. The expanded semantic audit was not rerun for these selected
artifacts; the full-suite score cannot replace it. Production qualification and
Worker routing defaults remain unchanged.
