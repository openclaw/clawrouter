# Frozen three-arm repository repair confirmation

This study compares a verified cheap-first cascade with cheap-only and
strong-only repair on real Undici changes. It evaluates a fixed caller-side
policy; it does not qualify a production routing default.

## Design

The protocol freezes 30 repository tasks from 20 source-file groups, three
trials per task, and three arms per trial. Each task contributes equally after
averaging its trials. Source-clustered intervals treat tasks touching the same
source file as a group. Repeated trials are not 90 independent tasks.

The models are `openai/gpt-6-luna` and `openai/gpt-6.1-terra`, both at low
reasoning effort, with output ceilings of 4,096 and 8,192 tokens respectively.
These are pinned request identifiers and settings, not immutable served-weight
identities. All arms receive the same original source, public tests and imported
context. A repair receives only its own previous candidate and public feedback.
Each arm may make at most two calls; private grading starts after all arms in a
batch finish.

The pre-inference `size-and-public-failure-ratio-v1` admission rule admits 20
tasks to cheap-first execution. On the remaining 10 tasks, the cascade uses the
strong-only workflow. Differences between those independent strong samples are
sampling variation, not evidence of multi-model cooperation. The report retains
both strata and the complete cohort. Neither outcomes nor private labels change
the admission rule, task list, model settings or call limits.

A successful public check is not a final success. A submitted artifact must also
pass the full frozen suite. Rejected or unusable artifacts and failed full grades
remain zero-score observations. A task loses a baseline success if any paired
trial succeeds under the baseline but fails under the comparison; successes in
other trials cannot cancel that loss.

## Costs and time

Model cost uses recorded provider usage and tariffs frozen in the protocol:
Luna input/output at $0.10/$0.50 per million tokens, and Terra input/output at
$1/$5 per million tokens. Cached input uses the separately frozen cache tariffs.
A second comparison prices cached input as uncached input. These are usage-based
model charges, not a separately reconciled card invoice, and exclude engineering,
hardware and operations.

Per-arm elapsed time is the original live measurement, including admission,
provider calls, decoding, public verification and cleanup. It excludes the final
private grading phase. Offline replay time never replaces live elapsed time.

## Replay and provenance

The report binds the global protocol, each batch protocol/result/audit, and any
replay amendment by SHA-256. No model call is repeated to repair an audit.

Batch 1 required a replay-only amendment for the numeric process ID in an exact
Node EventSource warning. The auditor compares the entire reconstructed request
outside that recognized warning field before restoring the recorded bytes. It
still reruns public verification and full grading; altered assertions, verdicts,
source, model settings or other diagnostic text remain failures.

Batch 5 initially stopped twice on an unlocalized strict request mismatch.
Independent checks of its ten repair requests, then a full-sequence diagnostic
of all 40 requests, reproduced the recorded bytes. A separately reviewed and
pinned auditor added first-mismatch capture without relaxing equality. Its
subsequent complete audit matched every request and full grade with zero
substitutions. The earlier failures remain a reproducibility limitation; their
cause was not established.

## Limits

The task list was frozen before inference, but recent public commit dates do not
prove absence from model training. Repository, language, runtime and task-family
coverage are narrow. Thirty tasks cannot establish a 5% upper task-loss rate even
with no observed losses, and source correlation further limits independence.
Cost savings alone do not establish acceptable quality or latency. Keep the
cheap-only comparison, lost strong successes and actual escalation rescues
visible alongside aggregate results.

This study changes no Worker route, production default or deployment.
