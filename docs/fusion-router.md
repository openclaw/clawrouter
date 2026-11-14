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
policy, then replay separate evaluation traces. Live pricing, cache behavior,
model changes, and latency require their own evaluation.
