# Frozen three-arm repository repair confirmation

The cheap-first cascade saved 23.0% in model charges but passed fewer repairs
than the strong-only control: 81/90 versus 85/90. Cheap-only passed 70/90.
The cascade lost a strong-control success in four paired trials across three
tasks. This is a failed quality-preserving confirmation, not a production
routing qualification.

## Results

| Arm | Full successes | Model charges | Cache-neutral charges | Mean live time per run |
| --- | ---: | ---: | ---: | ---: |
| Strong-only | 85/90 (94.4%) | $0.949173 | $0.949179 | 15.69 s |
| Verified cascade | 81/90 (90.0%) | $0.731083 | $0.731093 | 16.60 s |
| Cheap-only | 70/90 (77.8%) | $0.124083 | $0.124088 | 19.28 s |

All 270 observations remain in the report, including failed artifacts. Each
success requires both the public check and full grading. The cascade's total
live time was 5.8% higher than strong-only; the cheaper model was not uniformly
the faster workflow.

Compared with cheap-only, the cascade gained 11 successful runs at 5.89 times
the model cost. Compared with strong-only, the absolute saving was $0.218090
across 90 runs, with four lost successes. Neither comparison justifies changing
a production default.

The fixed admission rule separates two materially different comparisons:

| Predeclared stratum | Tasks / paired trials | Strong successes | Cascade successes | Cheap successes | Strong / cascade charges |
| --- | ---: | ---: | ---: | ---: | ---: |
| Admitted to cheap-first | 20 / 60 | 60/60 | 57/60 | 51/60 | $0.489112 / $0.288799 |
| Bypass to strong-only | 10 / 30 | 25/30 | 24/30 | 19/30 | $0.460061 / $0.442284 |

The admitted stratum saved 41.0% but lost three strong successes across two
tasks. Its 19 successful escalations show that a strong repair can recover a
failed cheap draft; they do not establish 19 gains over the independent cheap
control. The bypass stratum contributes one lost strong success from two
independent executions of the same strong-only workflow.

The lost-success pairs are `undici-0160a719063f` in trials 1 and 3,
`undici-f36ea9cab02a` in trial 2, and bypass task `undici-5e6e0e96e86f` in
trial 3. Successes in other trials do not erase these losses. There were no
public-check false accepts in this study; failures remain important even when
the verifier rejects them correctly.

Thirteen runs produced no usable final artifact. One additional cheap-only run
(`undici-0160a719063f`, trial 1) had an incomplete full test result with exit code
137; this does not establish an out-of-memory cause. All fourteen remain
zero-score rows with their model charges. The replay retained the same outcomes;
they were not replaced with successful retries.

The 95% paired source-cluster bootstrap intervals resample 20 source groups
with 2,000 draws and seed 42. Score changes are percentage points; cost and
latency ratios below 1 favor the cascade. These intervals describe sampling
uncertainty in this cohort, not generalization to other repositories.

| Cascade comparison | Score change (95% interval) | Cost ratio (95% interval) | Live-time ratio (95% interval) |
| --- | ---: | ---: | ---: |
| Versus strong-only | −4.44 pp [−9.80, 0.00] | 0.770 [0.589, 0.888] | 1.058 [0.971, 1.157] |
| Versus cheap-only | +12.22 pp [4.00, 20.00] | 5.892 [4.476, 6.743] | 0.861 [0.590, 1.242] |

Three of 30 tasks lost at least one strong success. The one-sided 95% exact
binomial upper bound is 23.86%, even before accounting for source correlation;
it does not support a 5% loss tolerance. The cascade also lost one cheap-control
success despite its higher aggregate score. Cost superiority is visible, but
quality preservation and a reliable latency improvement are not established.

## Design

The protocol freezes 30 repository tasks from 20 source-file groups, three
trials per task, and three arms per trial. Each task contributes equally after
averaging its trials. Source-clustered intervals treat tasks touching the same
source file as a group. Repeated trials are not 90 independent tasks. Nine
serial ten-task batches and their settings were frozen before the first call;
intermediate grades did not change later tasks, policies or call limits.

Pre-inference qualification selected this subset from a 120-entry roster:
30 entries qualified, 48 were excluded, and 42 remained unattempted. Three of
the unattempted entries were explicitly skipped by the source-family quota.
At most three selected tasks share a source-file group. Results apply to this
prequalified subset, not to all repository changes.

The models are `openai/gpt-6-luna` and `openai/gpt-6.1-terra`, both at low
reasoning effort, with output ceilings of 4,096 and 8,192 tokens respectively.
These are pinned request identifiers and settings, not immutable served-weight
identities. Both models use the same provider; this study does not establish
cross-provider complementarity. All arms receive the same original source, public tests and imported
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
hardware and operations. Campaign accounting retains the prior spent-or-reserved
balance; completed-call costs for this study are listed separately.

This study's completed calls cost $1.804339. The prior campaign balance was
$314.784743 spent or reserved; the cumulative balance after the study was
$316.589082 under the $400 cap. The prior balance is not attributed to these
270 observations.

Per-arm elapsed time is the original live measurement, including admission,
provider calls, decoding, public verification and cleanup. It excludes the final
private grading phase. Offline replay time never replaces live elapsed time.

## Replay and provenance

The report binds the global protocol, each batch protocol/result/audit, and any
replay amendment by SHA-256. Its public data supports recomputing the statistical
analysis; it does not include private test fixtures or model responses. No model call is repeated to repair an audit.

The [machine-readable study](fusion-final-confirmation-study.json) retains every
paired observation, admission assignment, normalized charge and batch proof
hash. To recompute the full cohort and both strata against both baselines:

```sh
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { stratifiedFusionEvaluation } from './scripts/fusion-stratified-evaluation.mjs';
const study = JSON.parse(readFileSync('docs/fusion-final-confirmation-study.json', 'utf8'));
for (const baseline of ['strong', 'cheap']) {
  console.log(JSON.stringify(stratifiedFusionEvaluation(
    study.evaluation, baseline, study.partition), null, 2));
}
JS
```

This reproduces the published statistical analysis, not provider inference or
private grading. The latter require the retained source, fixtures and receipts.

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
