# Baseten SystemOne schema contract

This contract consumes landed [codec PR616](https://github.com/openclaw/clawrouter/pull/616),
source head `c59d924cf64a8d7a826eb0036017e58d6193e68c`, and its
[native contract](baseten-systemone-contract.md). It registers schema/compiler
validation only. Source4 retains provider declarations and the separately held
wrapper; source1 retains shared types, dispatch, admission and accounting.

## Native declaration

Keep the existing base `https://inference.baseten.co/v1`. The endpoint is POST
`/systemone`, yielding `https://inference.baseten.co/v1/systemone`. Both
`requestFormat` and `responseFormat` are `baseten.systemone`; the sole endpoint
capability is `llm.decisions`. Use the original selected Baseten Bearer API key.
No URL, path, credential or query overrides are qualified. Do not duplicate `/v1`
in the endpoint or introduce an OpenAI/Liquid/TypeSafe format alias.

Only these native model IDs may have decision cards:

- `decision-models/baseten-elephant-9b-latest`
- `decision-models/baseten-mammoth-27b-latest`
- `decision-models/baseten-joey-2b-latest`

Each card has only `llm.decisions`, endpoint-specific native metadata and no
price, pricing reference, Codex mapping or generic reasoning effort. Existing
Chat cards and their transport remain unchanged. Selected identity is not the
backend model returned by the native response; do not rewrite one into the other.

## Exact decision metadata

Inside `nativeCapabilities.endpoints.<endpoint>.inference.decision`:

```yaml
protocol: baseten-systemone
questions:
  boolean: { probabilities: boolean, abstention: false }
  choice: { probabilities: provider-defined, abstention: false, minOptions: 2, maxOptions: 255 }
  score: { probabilities: provider-defined, abstention: false, minOptions: 2, maxOptions: 10 }
reasoning: { modes: [auto] }
confidence: provider-specific
outputTokensPerQuestion: 1
limits:
  maxTotalOptions: 512
  maxStateAndQuestionTokens: 16384
```

Boolean is the logical DecisionV2 question kind; the native wire uses Noul and
counts it as two options. Source2's frozen codec encodes JSON state/criteria and
boolean instructions before calling the native route. The Worker codec accepts
that already encoded text; it does not introduce a second DecisionV2 API.
`input` may declare text/JSON logical inputs, with `inference.chat: false`.
Images, sorting, tags, abstention and explicit on/off reasoning are outside this
finite codec. Provider-defined probabilities do not promise normalization or
equate confidence with the chosen option's probability.

The 16,384-token bound applies to each complete encoded question, including
shared state, criteria and formatting. It is not an aggregate request context
window or a tokenizer estimate. Do not replace it with `contextWindow`,
`contextTokens` or a fixed `maxOutputTokens`. The response must actually report
one output token per question; missing/mismatched usage is rejected, not filled
from metadata. Shared input is counted once by the native usage receipt.

These fields have a closed schema specific to `baseten-systemone`. Source1 must
project the same discriminator and fields through its shared TypeScript types;
the existing OpenAI-only type cannot be widened by casting to an unrelated
protocol. Source4 must consume this exact declaration before its wrapper is
released under the coordinator's recorded handoff.

## Evidence and activation

Primary [System One reference](https://docs.baseten.co/reference/inference-api/system-one)
and [decision model cards](https://docs.baseten.co/inference/model-apis/decision-models)
support the published source contract, checked 2026-11-03 UTC. The codec's frozen
two-option minimum is narrower than later native one-option support; newer image,
service-tier and unencoded structured-state modes are not added here.

Six tests compose the compiled metadata with the landed codec and typed fixture:
all three identities, exact URL, 512-option boundary, native answer/usage,
separate backend model, unknown-dollar admission and invalid declarations.
Native duration/option/token facts do not create a tariff. Hard upstream-dollar
budgets remain closed without qualified prices; policy-fixed accounting remains
separate. No YAML, snapshot, wrapper, runtime or actual-client activation occurs
in this change. Real dispatch and DecisionV2 acceptance remain required.
