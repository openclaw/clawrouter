# Fusion routing

ClawRouter can expose `clawrouter/fusion` as a selectable OpenAI-compatible
chat model. It spends extra inference only for requests that explicitly choose
that model: up to four adviser models run concurrently, then one configured
synthesizer produces the response.

The configuration's `strategy` selects `ensemble` (the default for existing
profiles) or `single`. Single sends the original request to the configured final
model without adviser calls or proposal reservation. Stored adviser choices stay
available for switching back, but do not affect single-mode model validation,
readiness, discovery, or charges. Every response reports the selected strategy in
`x-clawrouter-fusion-strategy`. This is an explicit execution choice, not a
learned router or a guarantee of better answers.

```text
request model=clawrouter/fusion
        |
        +--> adviser A (local or hosted) --+
        +--> adviser B (local or hosted) --+--> final synthesizer --> response
        +--> adviser C (optional) ---------+
```

This is a sparse, single-layer mixture-of-agents design. It combines ideas from
[Mixture-of-Agents](https://arxiv.org/abs/2406.04692) and
[LLM-Blender](https://arxiv.org/abs/2306.02561), while keeping activation as an
explicit virtual model like the model-selection interfaces used by
[RouteLLM](https://github.com/lm-sys/RouteLLM) and
[BEST-Route](https://github.com/microsoft/best-route-llm). The bounded topology
is deliberate: it avoids recursive debate, makes latency predictable, and
keeps every call visible to existing ClawRouter controls.

Related systems use three main cost/quality patterns:

- Cascades such as [FrugalGPT](https://arxiv.org/abs/2305.05176) try a cheaper
  model first and escalate when a learned policy predicts that more quality is
  needed.
- Selectors such as RouteLLM, BEST-Route, and
  [MixLLM](https://arxiv.org/abs/2502.18482) learn which single model should
  handle each request.
- Ensembles such as Mixture-of-Agents and LLM-Blender gather multiple candidate
  answers, then aggregate or rank them.

ClawRouter's first fusion model uses the ensemble pattern behind an explicit
model id. It needs no training set, works with registered OpenAI-compatible
chat-completion models, and lets clients decide when the extra call is
worthwhile. The local advisers plus one cloud synthesizer make the
API-spend/quality tradeoff directly configurable; an automatic learned selector
can remain a separate future activation policy.

## Configure

Open the admin console, select **Access**, then **Fusion**. Configure:

Choose **Single** for one final-model call or **Panel** for independent adviser
proposals followed by synthesis. The cards show maximum call counts, not a
quality prediction. Switching modes preserves your model choices and invalidates
the previous readiness check. Single mode can be saved with no advisers. The
model and resource controls below the cards configure the selected workflow.

- one to four adviser model ids;
- one final synthesizer model id;
- adviser timeout and output-token limits;
- input and injected-proposal character limits; and
- adviser temperature preference.

The adviser input limit counts text across the most recent messages. When a
message exceeds the remaining budget, Fusion keeps its beginning and end and
marks the omitted middle. This preserves the task instruction before a long
source excerpt as well as its closing context. Very small remaining budgets
keep only the tail. The synthesizer still receives the original conversation.

Every selected model must expose OpenAI chat-completions request and response
formats. Provider-native chat routes without that wire contract are rejected.
Advisers receive the temperature preference only when that model and endpoint
document support for it. Otherwise Fusion omits it and the readiness preview
explains that the provider default applies. Local and opaque model names do not
imply sampling or reasoning support; Fusion does not inject a reasoning effort.

A cost-oriented starting point is one or two `local/*` advisers with
`openai/gpt-4.1-mini` as the synthesizer. Use a stronger synthesizer only for a
fusion profile where its quality justifies the added token price.

Enable the configuration to advertise `clawrouter/fusion` through `/v1/models`,
`/v1/catalog`, and the Playground. The synthesizer provider must be allowed and
its chat-completions route must be executable for the caller; otherwise the
virtual model stays hidden. Discovery uses the same selected-policy Chat
eligibility as concrete models, including policy and provider budget caps,
available pricing, grant restrictions, cooldowns, and transport support. This
also applies to configured prefix-routed models: an unpriced model requires
unmetered policy and provider limits, or a fixed per-request policy price.
Session entitlements and key-based model catalogs share this projection and
emit an exact HTTP Chat offer with the synthesizer's selected policy and
generation. Discovery observes current scoped balances without reserving budget,
selecting credentials, or calling providers. Fixed-price observations account
for synthesis before advisers; variable prices and uncertain compound admission
remain request-dependent.
ClawRouter preflights that final route before it
starts advisers, so a denied or unavailable synthesizer cannot spend adviser
budget. It also reserves the final model's worst-case configured proposal input
before advisers run, so an unfunded final answer fails without adviser spend.
Unavailable advisers fail open; if every adviser fails, the synthesizer
answers the original request by itself.

The web console checks an unsaved profile against one selected policy before
enabling it. `POST /v1/admin/fusion/preview` accepts a policy id and draft
configuration, then reports every adviser and synthesizer route, policy access,
executable and recently verified state, maximum call count, and a reservation
estimate. The preflight also rejects deterministic pricing, exhausted-budget,
and synthesizer-reservation failures before adviser fan-out. Fixed per-request
policy pricing makes each eligible call's configured price exact, although
fail-open adviser reservations can still be lower. Otherwise adviser bounds are
exact while the synthesizer uses the manifest maximum input and default output;
live request preflight remains authoritative when callers request more output.

Each adviser and the synthesizer is a separate normal ClawRouter request. The
caller's policy must grant all providers that should participate. Budgets are
reserved and usage is recorded per subrequest, so a two-adviser fusion request
can account for three model calls. A failed adviser can still consume upstream
tokens before its failure becomes visible. Discarded HTTP-error responses and responses arriving after the
adviser deadline are canceled so their upstream resources are released and
accounting completes. HTTP errors release the adviser reservation; incomplete
successful responses keep the conservative reservation.
Only drafts with an explicit `stop` completion reason enter synthesis. Truncated,
filtered, refused, and tool-calling drafts are omitted; normal subrequest accounting
still applies. Other completed advisers remain available to the synthesizer.
Completed drafts exceeding the proposal character limit are also omitted in full.
Fusion never cuts off an adviser's conclusion to fit that limit. If no drafts remain,
the synthesizer answers the original request without adviser text.
Adviser failures remain contained even when an invocation or body read rejects
after its deadline has already elapsed.

Usage events retain their individual request ids and also carry a shared
`compound_request_id`, stage, and adviser index. The Usage console groups those calls into one expandable Fusion request
with aggregate spend and end-to-end latency measured from Fusion entry; opening
it preserves the billable subrequest detail. A request rejected during final
route preflight or budget reservation appears as a one-call failed Fusion group
because adviser fan-out never began.

## Ollama and LM Studio

The bundled `local-openai` provider accepts arbitrary `local/<model>` ids. Set
the endpoint root without `/v1`:

```sh
# Ollama's default OpenAI-compatible listener
LOCAL_OPENAI_BASE_URL=http://127.0.0.1:11434

# LM Studio's default local server
LOCAL_OPENAI_BASE_URL=http://127.0.0.1:1234
```

For example, `local/qwen3:8b` is forwarded upstream as `qwen3:8b`. An optional
`LOCAL_OPENAI_API_KEY` supplies a bearer credential. Ollama and LM Studio both
document OpenAI-compatible chat-completion endpoints:
[Ollama compatibility](https://docs.ollama.com/api/openai-compatibility),
[LM Studio compatibility](https://lmstudio.ai/docs/developer/openai-compat).

A deployed Cloudflare Worker cannot reach `127.0.0.1` on an operator's laptop.
Either run ClawRouter locally beside the model server, or give the Worker a
secure, network-reachable OpenAI-compatible endpoint. Do not expose an
unauthenticated local model server to the public internet.

The local manifest uses zero API price because there is no metered upstream
API charge. Hardware, electricity, hosting, and operational cost remain real
and are outside ClawRouter's token-price ledger.

## Request behavior

```sh
curl "$CLAWROUTER_BASE_URL/v1/chat/completions" \
  -H "authorization: Bearer $CLAWROUTER_KEY" \
  -H "content-type: application/json" \
  --data '{
    "model":"clawrouter/fusion",
    "messages":[{"role":"user","content":"Design a robust retry queue."}]
  }'
```

The final upstream response body is preserved, including streaming and tool
calls. Diagnostic response headers report the synthesizer, successful and
failed adviser counts, successful adviser ids, and adviser-layer latency.
The synthesizer preserves caller-supplied sampling, reasoning, and tool fields.
Documented model/endpoint conflicts return `model_parameter_unsupported` before
any reservation or adviser dispatch. For example, Astra Chat tool calls and
temperature fields are rejected; GPT-5.4 sampling requires its documented
`none` effort. Unknown parameter support remains subject to upstream validation.
An empty assessment is not a guarantee that the provider accepts the full request.
Direct public, native, and manifest routes retain their protocol passthrough.

## Security and privacy boundaries

- The text conversation is disclosed to every participating adviser and the
  synthesizer. Configure models accordingly for sensitive data.
- Images and tool definitions are not sent to advisers. Text tool results in
  existing history are labeled and included; the synthesizer retains the
  original tools and multimodal request.
- Adviser outputs are inserted as delimited, untrusted evidence. The
  synthesizer is told to verify drafts and ignore embedded instructions.
- Adviser input, output, timeout, count, and injected size are bounded.
- Content retention and usage auditing apply independently to every subrequest.
  Raw prompt and completion bodies still never enter the usage ledger.
- Fusion cannot select itself as an adviser or synthesizer.

Fusion can provide multiple perspectives; measured quality or cost gains depend
on the task and configuration. The final synthesizer remains responsible for
the answer, and all models can share the same blind spot. The Worker does not
execute client tools or repository regression checks. Executable repair policies
in the benchmark require a caller-side agent and are not deployed by selecting
`clawrouter/fusion`.

## Body-budget development workload

`benchmarks/fusion/body-budget-workloads.json` provides one pinned method-addition
workload for caller-side coding evaluations. Only `worker/body-budget.ts` is
editable. The original ten tests cover atomic transfers, competing leases,
invalid charges, successor ownership, repeated release, and legacy behavior.

The test file is supplied to the initial candidate and reused for acceptance.
This is development data with no hidden-test claim. The base must fail the
supplied tests and the reference must pass them; a passing reference alone does
not qualify the workload. Model results depend on the chosen caller and policy.
Declared public test files can be new or replace existing files. Their parent
directory must already exist in the base; linked files and parents are rejected.
Installation changes only the disposable sandbox, not the source image.

To qualify it without model calls, set `FUSION_NODE_IMAGE` to a pinned
`node@sha256:...` image and run:

```sh
node scripts/qualify-fusion-workloads.mjs "$FUSION_NODE_IMAGE" \
  /tmp/body-budget-qualification.json benchmarks/fusion/body-budget-workloads.json
```

Qualification builds the task's frozen dependencies. Reuse an existing qualified
runtime during local research when downloads or new builds are constrained.

## Verified regression development workload

`benchmarks/fusion/verified-regression-workloads.json` pins four historical
regressions for caller-side coding evaluations:

| Task | Original tests | Editable source |
| --- | ---: | --- |
| Native music MIME fields | 9 | `worker/fal-music.ts` |
| Manifest route discovery | 20 | `worker/discovery.ts` |
| Missing managed native ID | 12 + 3 preservation tests | `worker/managed-predictions.ts`, `worker/proxy.ts` |
| Cancellation acknowledgement | 21 | `worker/background-store.ts`, `worker/managed-lifecycle-types.ts`, `worker/managed-predictions.ts`, `worker/response-controls.ts` |

Each task supplies the original test files from its pinned reference revision.
The managed-ID file retains those bytes and appends one preservation test with
two subtests. Its 34 requests check status codes, error codes, upstream calls,
and budget calls across declared and undeclared lifecycles. These guards catch
fixes that pass the original examples but change other request behavior.

All supplied tests are visible before generation and reused for acceptance;
the manifest's `hiddenTests` field does not imply independent hidden tests.
Acceptance retains appended public guards when the supplied file starts with
the exact oracle test bytes. Other public replacements do not override oracle
tests.
Only the listed source files are editable. Qualification must confirm that the
base fails and the reference passes the complete supplied suite.

Use the same model-free qualification command as above, with
`benchmarks/fusion/verified-regression-workloads.json` as the manifest. This
separate development cohort does not replace existing workloads or qualify a
model, routing policy, or production deployment. A model comparison must freeze
its models, prompts, effort, call limits and acceptance rules, and include all
attempts in cost and latency totals.

## Review a supplied candidate with separate model roles

Use `runFinalReviewedModelTrajectory` when a candidate already exists in the
caller's isolated workspace. A review model can diagnose problems while a
separate, smaller model owns corrections. This is an opt-in caller workflow;
it does not change the Worker chat model or routing defaults.

```js
import { runFinalReviewedModelTrajectory } from './scripts/fusion-trajectory-models.mjs';

export function reviewCandidate({ task, tools, invoke, readSnapshot, checkpoint, signal }) {
  return runFinalReviewedModelTrajectory({
    task,
    tools, // Include a read-only `check` tool returning { passed: boolean }.
    invoke,
    runId: 'candidate-review',
    draftModel: 'provider/small-model',
    reviewModel: 'provider/review-model',
    repairModel: 'provider/small-model',
    reviewCanReplace: false,
    reviewAfterCorrection: true,
    initialFinalAnswer: 'The supplied candidate is ready for review.',
    reviewSnapshot: readSnapshot,
    onCheckpoint: checkpoint,
    finalCheckTool: 'check',
    maxModelCalls: 8,
    maxToolCalls: 8,
    maxContextBytes: 131_072,
    deadlineMs: 120_000,
    signal,
  });
}
```

Install the candidate before calling this function. `readSnapshot` must return
a plain JSON object containing the current task-relevant source and evidence.
It must read the corrected workspace on each review. Do not include held-out
grading results in the snapshot or model input.

The first call reviews the supplied candidate without generating another draft.
`reviewCanReplace: false` prevents the reviewer from supplying a replacement
action. On rejection, the repair model receives the reason and committed
history. After a corrective write and its checkpoint, `reviewAfterCorrection`
sends the current snapshot back to the reviewer. Reviewer acceptance still
requires the caller's `check` tool to pass. A failed check can continue only
within the remaining shared limits; it cannot return a successful completion.

`invoke(runId, model, body, signal)` must reserve each request's conservative
cost before dispatch, record every attempt's cost, and honor cancellation.
The workspace, tools, snapshots, checkpoints, and final check belong to the
caller. Tool effects can occur before final acceptance, so keep them isolated
from production state. Callback and provider errors stop execution without
an automatic retry.

Measure this role split against a matched single-model repair. Include the
original candidate, diagnosis, failed attempts, correction, and re-review in
cost and latency totals. Smaller corrective models are a configuration option,
not a guarantee of equivalent quality or lower total cost.

## Caller-side verified repair

`scripts/fusion-verified-workflow.mjs` exports `runVerifiedWorkflow`. Use it in
a caller that can generate repair artifacts and verify them in an isolated
environment. It is separate from the Worker chat model described above.

```js
import { runVerifiedWorkflow } from './scripts/fusion-verified-workflow.mjs';

export function repairTask({ invoke, verify, signal }) {
  return runVerifiedWorkflow({
    models: {
      draft: 'provider/draft-model',
      repair: 'provider/strong-model',
      compiler: 'provider/small-model',
    },
    invoke,
    verify,
    signal,
    deadlineMs: 900_000,
  });
}
```

The caller supplies two adapters:

- `invoke({ stage, model, draft, feedback, signal })` reserves a conservative
  budget before dispatch and returns `{ artifact, costMicros }`, with optional
  `feedback` describing an unusable draft. Use `null`
  for an unusable artifact. Report the full attempt cost, including failed
  attempts. Model identifiers are passed through to this adapter.
- `verify({ artifact, stage, model, signal })` returns boolean `runtimePassed`
  and `compilerPassed` fields, plus optional `feedback` for the next repair.
  Both checks must pass before the workflow accepts an artifact. The caller
  defines and isolates these checks; the module does not execute code itself.

Artifacts and feedback must support `structuredClone`. Each adapter receives a
copy so a failed repair cannot mutate the saved draft. Both adapters must honor
the abort signal and clean up their own resources. A callback error, invalid
receipt, or cancellation stops execution without trying another model. Work
already dispatched can still incur charges after cancellation; its adapter
must settle those charges even if the workflow has stopped waiting.

The workflow keeps a passing draft. A draft that passes runtime checks but
fails compilation gets one compiler-model repair. Otherwise, or if that repair
fails, the strong model repairs the saved original draft. A strong repair with
only compiler failures also gets one compiler-model pass. If this sequence
fails, the strong model starts again from the original task and can make one
final repair. The maximum is six model calls. Set `strategy: 'strong'` for a
two-call control using only the repair model.

Set `strategy: 'cascade'` for a verified draft followed by at most one fresh
fallback. This mode requires only `models.draft` and `models.repair`. It keeps
a draft only when both verification checks pass. Otherwise it calls the repair
model with the original task context supplied by your adapter, with `draft`
and `feedback` set to `null`, then verifies that answer. It does not call the
compiler or specialist models. Both attempts count toward cost and elapsed
time, including a draft explicitly returned as `artifact: null`.

```js
const result = await runVerifiedWorkflow({
  strategy: 'cascade',
  models: { draft: 'provider/cheap-model', repair: 'provider/fallback-model' },
  invoke,
  verify,
  signal,
});
if (!result.passed) {
  // Handle the failed verification; no further model call is automatic.
}
```

The verifier defines what this cascade can safely accept. Public examples alone
can miss incorrect answers. Supply checks appropriate to your task and isolate
execution of generated code. Adapter errors, malformed receipts, deadlines and
cancellation stop the workflow rather than triggering fallback. This caller-side
mode does not enable a Worker routing policy or establish a model-quality gain.

For selector repairs, include preservation checks for inputs that must remain
unselected. Build these checks from the baseline contract before generating a
candidate, and run them for both strong controls and cheap drafts. Keep the
original tests and check that the reference implementation passes the complete
suite without skips. A dependency graph alone does not establish that every
unreachable path should be excluded; qualify that invariant for the task.

The [selector preservation study](fusion-selector-preservation-study.json)
records a concrete failure: three cheap drafts passed the public tests but
selected an unrelated provider operation. Five baseline-derived negative checks
rejected all three saved drafts and retained all three correct strong answers.
With the checks visible in a separate retest, both strategies passed all three
repetitions. The cascade cost 53.7% less after cache normalization but took
81.1% longer. This exposed-task result improved the verifier and met the cost
screen; it failed the latency gate and does not establish a general model gain. A
follow-up with lower draft reasoning lost one correct strong answer because it
omitted required helpers while passing all negative checks. Include positive
dependency coverage as well; passing exclusion checks alone is insufficient.

For an informed fallback, set `fallbackMode: 'repair'` with `strategy: 'cascade'`.
The second invocation receives a clone of the rejected artifact and its verifier
receipt in `draft` and `feedback`. A missing artifact stays `null`. This mode still
allows at most two calls by default, counts both costs, and verifies the fallback before
acceptance. The default `fallbackMode: 'fresh'` sends neither artifact nor feedback.
Only include feedback that the fallback is allowed to see. Keep evaluation-only
held-out cases outside this receipt, and treat generated artifacts as untrusted
data in the provider adapter. No quality or cost improvement is implied by this
option; validate it on the intended workload.

Set `draftAttempts: 2` with `strategy: 'cascade'` to give the draft model
one repair attempt before using the strong fallback. Handle the `draft-repair`
stage in the caller's adapter: it uses `models.draft` and receives the rejected
draft plus cloned verifier feedback. Each draft attempt uses the same
verification gate. A passing repair ends the workflow without a strong call.

If both drafts fail, `fallbackMode: 'fresh'` keeps the strong request isolated
from them. With `fallbackMode: 'repair'`, the strong model receives the latest
rejected draft and its feedback. The existing deadline covers every attempt;
provider and verifier errors stop the workflow instead of triggering fallback.

The default `draftAttempts: 1` preserves the current sequence. Only 1 and 2
are accepted, and only cascades may use 2. Combining `draftAttempts: 2` with
`fallbackAttempts: 2` permits at most four calls. Reserve for every allowed
attempt before dispatch and retain every charge, including failed drafts.
This caller-side option does not enable a routing default or establish a
quality or cost advantage for a workload.

Set `fallbackAttempts: 2` with `strategy: 'cascade'` to allow one repair of a
failed strong fallback. The maximum then becomes three calls: cheap draft,
strong fallback, and `strong-fallback-repair`. The third call receives the
failed strong artifact and its verification feedback, regardless of whether
the first fallback used fresh or repair mode. It runs only when the fallback
fails at least one verification check; acceptance at either earlier stage stops the
workflow. A missing artifact remains `null` and retains its adapter feedback.

The default `fallbackAttempts: 1` keeps the two-call limit. Only values 1 and 2
are accepted; other strategies cannot request a second fallback attempt.
Reserve for all three possible calls when enabling the option. Each attempted
call is charged and verified, and adapter errors, invalid receipts, cancellation
or deadline expiry stop execution. This option changes no Worker defaults and
does not establish a quality or cost gain.

Optionally set `models.runtimeRepair` to a specialist model identifier. When
the original draft fails runtime checks but passes compilation, the workflow
calls that model once with the saved draft and verification feedback, using
the `draft-runtime` stage. Both checks must pass to accept its repair. If they
do not, the strong model receives the original draft and feedback, not the
failed specialist output. The specialist is skipped for compiler failures,
unusable drafts, and the strong control. Omitting it preserves the default
sequence. The maximum remains six calls; failed specialist attempts count
toward total cost and elapsed time.

Optionally set `models.admissionRepair` for a draft that has no usable artifact.
The `draft-admission` stage receives `draft: null` and the original admission
feedback. The adapter can use that feedback or make a fresh attempt against the
original task. Both verification checks must pass. A failed attempt leaves the
original feedback intact for strong-model fallback. This option is skipped for
usable drafts and the strong control. It adds at most one attempt and preserves
the six-call bound; its cost and elapsed time are included in the result.

The result includes `passed`, the final `artifact` and `verification`, all
attempt costs, and elapsed time including callbacks. Optional `onStep` receives
only stage, model, cost, check verdicts, and timing; it receives no artifact or
feedback content. The default deadline is 15 minutes and the maximum is 30.
This opt-in workflow does not establish quality, cost, or latency gains for a
model configuration; measure those against a matched control on your tasks.

### Constrain region edit targets

For adapters that request region replacements as structured output,
`scripts/fusion-region-schema.mjs` exports `createRegionEditSchema(files)`.
Supply the current inventory's file paths and region IDs:

```js
import { createRegionEditSchema } from './scripts/fusion-region-schema.mjs';

const schema = createRegionEditSchema([
  { path: 'src/handler.ts', ids: ['r0', 'r1'] },
  { path: 'src/client.ts', ids: ['r0', 'r2'] },
]);
```

Use the returned schema in your adapter's strict structured-output request.
It describes `{ edits: [{ path, id, code }] }`, with one to 24 replacements.
Each replacement's ID is bound to its file; shared local IDs are allowed.
The adapter must support nested `anyOf` for multiple files. A single-file
schema uses direct enums without `anyOf`.

The helper rejects empty or duplicate targets and limits the inventory to
64 files, 1,000 total enum values, and 100,000 target characters. File paths
count as enum values. ID enums above 250 values allow at most 15,000 ID
characters per file. Oversized inputs fail rather than dropping constraints.
Keep the inventory tied to the current source and validate returned edits
against it, including duplicate replacements, before applying them. The
schema does not verify replacement code, prevent stale-source edits, or
replace runtime and compiler checks. This helper makes no model calls and
does not change Worker routing.

### Include files referenced by tests

A visible test can still depend on data the model cannot see. For example,
it can load a JSON fixture and build a selection from a provider manifest.
`scripts/fusion-test-context.mjs` exports `collectTestContext` to find direct,
literal references and collect their source as read-only context:

```js
import { collectTestContext } from './scripts/fusion-test-context.mjs';

const context = collectTestContext({
  tests: [{ path: 'test/handler.test.mjs', content: testSource }],
  editPaths: ['src/handler.ts'],
  parse: parseModule,
  readSource: path => readAtRevision(baseRevision, path),
});
// Add context.files to the model's read-only source context.
// Inspect context.omitted before deciding whether the request has enough context.
```

Supply a Babel- or ESTree-style parser and a bounded source reader for the
original repository revision. The reader returns a string or `null` for an
unavailable file; errors propagate. The collector has no filesystem access
and does not execute test or dependency code. It excludes the supplied tests
and editable paths before calling the reader.

Supported references are relative static imports, literal dynamic imports,
re-exports, and `readFile` or `readFileSync` calls imported from `node:fs` or
`node:fs/promises` (including aliases and namespace imports). File reads must
use `new URL('relative-path', import.meta.url)`. Package imports, computed
paths, binary files and paths outside the repository are not collected.
It does not follow dependencies recursively or resolve extensionless imports.

The defaults allow 16 collected files and 128 KiB of source. Oversized,
excluded, unavailable, unsupported and file-limit omissions are reported;
source is never truncated. At most 32 tests, 256 distinct references and
250,000 AST objects are accepted. The result always has `complete: false`:
literal references cannot establish a complete dependency graph. Retain
normal edit validation, input budgets and full test/compiler verification.

### Select optional supporting source

Callers can opt into `selectSourceContext` from the same module after collecting
supporting source. It retains direct imports and re-exports of editable files,
declaration files and named fragments, non-code resources, and test helpers. It reports other
whole-file omissions with content hashes. Editable source and acceptance tests
remain separate inputs and are never removed by this function.

```js
import { selectSourceContext } from './scripts/fusion-test-context.mjs';

const selected = selectSourceContext({
  sources: editableFiles,
  context: supportingFiles,
  parse: parseModule,
});
// Inspect selected.omitted, then explicitly use selected.files in the request.
```

This is an experimental prompt policy, not a complete dependency resolver.
Unresolved dynamic imports and package or alias imports preserve all supplied
context. Extension and directory-index variants are retained conservatively.
The function does not read files, invoke models, or change benchmark defaults.
Keep full test and compiler gates; a smaller request does not prove equal quality.

Inputs are bounded to 32 editable files, 256 context entries, 256 KiB per file,
4 MiB of combined content, and 250,000 AST objects. `bytes` and `originalBytes`
count UTF-8 supporting content, excluding request formatting. The result always
has `complete: false`; inspect omissions before using it.

### Scoped compiler repair context

For TypeScript drafts that pass runtime checks but fail compilation,
`scripts/fusion-compiler-context.mjs` builds a small data payload from located
compiler errors and the current source. Supply any required type declarations
as explicit read-only `referenceFiles`.

```js
import {
  createCompilerRepairContext,
  applyCompilerRepairs,
} from './scripts/fusion-compiler-context.mjs';

const context = createCompilerRepairContext({
  files: draft.files,
  diagnostics: compiler.diagnostics,
  referenceFiles: typeDeclarations,
});
// The caller's model adapter returns [{ path, content }] replacements.
const files = applyCompilerRepairs({ context, files: draft.files, replacements });
```

The immutable payload contains only diagnosed editable files, diagnostics and
explicit references. It excludes unrelated source files. Paths must be relative
`.ts` paths; relative Windows separators are normalized. Unlocated errors,
unknown paths, invalid line positions and oversized inputs are rejected. The
limits are 64 source files, 256 KiB per file, 1 MiB total source, 32 reference
files with 48 KiB total, 12 KiB of diagnostics, and eight diagnosed files.

The merge rejects edits outside the diagnosed files and rejects a repair if
those files changed after the context was created. It preserves all unrelated
source. The caller must reserve model costs, apply its cancellation policy, and
run the complete original runtime suite and compiler on the merged artifact.
The helper does not validate generated code or establish model quality, cost,
or latency gains.

For small corrections, `applyCompilerTextEdits({ context, files, edits })`
accepts `{ path, oldText, newText }` entries. Each nonempty `oldText` must occur
exactly once in its diagnosed file. All entries match the original saved source;
edits cannot overlap. Unchanged bytes, including line endings, are preserved.
An empty `newText` deletes the matched text. A missing or ambiguous match,
stale source, or invalid entry rejects the entire batch without changing inputs.
The limits are 32 edits, 16 KiB per text field and 64 KiB of text per batch.
The same full-suite and compiler verification requirements apply.

## Fixed-choice voting experiments

`scripts/fusion-exact-vote.mjs` exports `runExactVote(panel, invoke)`. It calls
workers sequentially and stops when the leading answer's weight exceeds every
competitor even if all remaining workers vote against it. A rounding margin
makes near ties continue. This certificate preserves the full panel's chosen
answer; it does not estimate correctness or repair correlated model errors.

```js
import { runExactVote } from './scripts/fusion-exact-vote.mjs';

const panel = {
  version: 1,
  choices: ['A', 'B', 'C', 'D'],
  workers: [
    { id: 'worker-a', weight: 3, priority: 0 },
    { id: 'worker-b', weight: 1, priority: 1 },
    { id: 'worker-c', weight: 1, priority: 2 },
  ],
};
const result = await runExactVote(panel, async id => invokeAndParseChoice(id));
```

Freeze weights, canonical worker order, and unique nonnegative integer priorities before
evaluation. Lower priority numbers break final ties between supported answers.
The panel accepts 2–32 distinct choices and 1–64 distinct workers. Weights must
be finite and nonnegative, with a finite positive sum. The callback returns an
exact choice label or `null` for an abstention. Invalid answers and callback
errors stop the run. If all workers abstain, the answer is `null`.

An optional third argument, `{ selectNext }`, changes call order. The synchronous
selector receives a frozen snapshot with `observed` (`{ id, answer }` pairs in
call order) and `remaining` (worker IDs in canonical order). It returns one
remaining ID. Unknown or repeated IDs stop execution before another call.
Freeze the selector before evaluation and fit it on training data only; the
runner cannot enforce the data used by a caller's closure. Scores always sum
in canonical panel order so floating-point ties do not depend on scheduling.
The default remains sequential panel order. Programmatic
`replayFusionVote(input, { selectNext })` compares the scheduled run against
the canonical full panel; the replay CLI uses the default order.

The callback owns provider admission, deadlines, cancellation, usage settlement,
and response parsing. This experimental runner does not connect to the Worker
request path. Free-form prose is not an interchangeable choice label.

For an offline replay, add `cases` to the panel. Each case contains `answers`
and nonnegative finite `costs` arrays in worker order. Run:

```sh
node scripts/replay-fusion-vote.mjs replay.json
node --test test/fusion-exact-vote.test.mjs
```

The replay accepts a regular JSON file up to 4 MiB and at most 10,000 cases.
It checks every answer, compares early-stop answers with full-panel answers,
and reports aggregate calls and historical costs without making model calls.
Training and selection costs, present-day pricing, latency, and answer accuracy
require separate measurements. Use training data to select call order and an
independent evaluation to qualify any quality or cost claim.

### Run a panel against an endpoint

`scripts/run-fusion-vote.mjs` connects the fixed-choice runner to a Chat
Completions endpoint. Each worker adds a `model` field to the panel above, and
the input adds a `prompt` string. For example:

```json
{
  "version": 1,
  "prompt": "Which choice satisfies the supplied problem: A or B?",
  "choices": ["A", "B"],
  "workers": [
    { "id": "first", "model": "provider/model-a", "weight": 1, "priority": 0 },
    { "id": "second", "model": "provider/model-b", "weight": 1, "priority": 1 },
    { "id": "third", "model": "provider/model-c", "weight": 1, "priority": 2 }
  ]
}
```

Set `CLAWROUTER_API_KEY` for the selected endpoint, then run:

```sh
node scripts/run-fusion-vote.mjs https://router.example/v1/chat/completions panel.json
```

The endpoint must support strict JSON-schema responses and the selected models.
Workers run sequentially; mathematically unnecessary calls are skipped. Each
request allows 256 output tokens. The default request timeout is 30 seconds,
within a two-minute panel deadline. Programmatic callers can use
`runFusionVote(input, { endpoint, apiKey, signal, deadlineMs, requestTimeoutMs, selectNext })`;
deadlines are capped at five minutes. HTTPS is required except on loopback.
Redirects are rejected. The optional synchronous `selectNext` uses the same
frozen snapshot contract as `runExactVote`. Preflight validates the panel
without invoking the selector. An invalid selection or selector exception
returns `vote_selection_failed` and preserves earlier call receipts. The CLI
uses the default panel order unless an explicit policy file is supplied.

The result contains the selected answer, called workers, and reported token
usage. Missing or malformed usage stays `null`, and `usageComplete` is false.
The client does not estimate monetary cost or replace the endpoint's admission,
quota, or billing checks. HTTP errors, incomplete responses, cancellation and
invalid answers stop the panel without retries. Failure results retain prior
call status and known usage; the CLI exits nonzero. Prompts, raw completions,
keys, and provider error bodies are omitted from results.

This is an explicit caller-side experiment. It neither activates a Worker
routing strategy nor establishes that the selected panel improves quality.


### Load a data-only scheduling policy

Pass an optional policy file to the CLI:

```sh
node scripts/run-fusion-vote.mjs https://router.example/v1/chat/completions panel.json policy.json
```

A version-1 policy contains `panel` and `entries`. Copy the panel's `version`,
`choices`, and `workers` into `panel`; omit the prompt. Worker IDs, weights,
priorities, order, and any model IDs must match. For example, one entry is:

```json
{ "answers": [-2, -2, -2], "next": "third" }
```

The `answers` array follows canonical worker order: `-2` means unobserved,
`-1` means abstained, and `0` through `choices.length - 1` identify observed
choices. `next` must name an unobserved worker. Duplicate states and malformed
entries fail before dispatch. Missing states fall back to the first remaining
worker in canonical order. Policy files allow at most 20,000 entries and 4 MiB.
No policy code is evaluated.

Programmatic callers can use `await createVotePolicy(input, policy)` from
`scripts/fusion-vote-policy.mjs` and pass the returned `selectNext` to
`runFusionVote` or `replayFusionVote`. The table cannot alter vote weights or
bypass the exact stopping certificate. It only changes call order. Freeze the
table using training data and evaluate separately before claiming savings;
loading a table does not qualify its training procedure or cost estimates.

### Train call order offline

Create a training file with the same `version`, `choices`, `workers`, and
`cases` fields used by the replay tool. Each case contains complete `answers`
and nonnegative `costs` arrays in canonical worker order. Model IDs are optional
for offline replay; include them when binding the policy to an endpoint panel.

```sh
node scripts/train-fusion-vote-policy.mjs training.json policy.json
```

The trainer uses observed answer patterns and recorded costs to minimize
expected remaining call cost. It never reads correctness labels or changes
vote weights. Every stopping decision uses the existing exact-vote certificate.
Equal-cost choices follow canonical worker order. The output contains a bound
policy and training-only cost statistics, and an existing output file is never
overwritten.

Training is limited to eight workers, 10,000 cases, 50,000 explored states,
20,000 policy entries, and 5,000,000 row visits. Input and output files are each
limited to 4 MiB. Exceeding a limit fails without writing a partial policy.
These limits bound offline search; there are no model calls.

Recorded costs are assumed independent of call order. Training statistics omit
training cost and do not prove savings on future requests. Freeze the trained
policy, then replay separate evaluation traces:

```sh
node scripts/replay-fusion-vote.mjs evaluation.json
node scripts/replay-fusion-vote.mjs evaluation.json policy.json
```

Compare the reported mean costs and calls. Both commands verify the full-panel
answer for every case. The optional policy file has the same 4 MiB limit and
panel binding as live execution. Live pricing, cache behavior,
model changes, and latency require their own evaluation.
