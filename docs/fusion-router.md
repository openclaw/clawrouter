# Fusion routing

ClawRouter can expose `clawrouter/fusion` as a selectable OpenAI-compatible
chat model. It spends extra inference only for requests that explicitly choose
that model: up to four adviser models run concurrently, then one configured
synthesizer produces the response.

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

- one to four adviser model ids;
- one final synthesizer model id;
- adviser timeout and output-token limits;
- input and injected-proposal character limits; and
- adviser temperature.

Every selected model must expose OpenAI chat-completions request and response
formats. Provider-native chat routes without that wire contract are rejected.

A cost-oriented starting point is one or two `local/*` advisers with
`openai/gpt-4.1-mini` as the synthesizer. Use a stronger synthesizer only for a
fusion profile where its quality justifies the added token price.

Enable the configuration to advertise `clawrouter/fusion` through `/v1/models`,
`/v1/catalog`, and the Playground. The synthesizer provider must be allowed and
its chat-completions route must be executable for the caller; otherwise the
virtual model stays hidden. ClawRouter preflights that final route before it
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
tokens before its failure becomes visible. Usage events retain their individual
request ids and also carry a shared `compound_request_id`, stage, and adviser
index. The Usage console groups those calls into one expandable Fusion request
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

Fusion improves diversity and review, not correctness guarantees. The final
synthesizer remains responsible for the answer, and all models can share the
same blind spot.
