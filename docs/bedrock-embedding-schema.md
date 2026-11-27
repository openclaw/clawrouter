# Finite Bedrock native embedding declarations

The existing schema fields express the landed
[native embedding runtime](bedrock-embedding-runtime.md). No new format,
metadata field, ARN grammar or model-profile alias is introduced.

One embedding endpoint has capability `llm.embeddings`, request and response
format `aws_bedrock.invoke`, and POST `/model/${model}/invoke`. Its sole path
parameter is `model`, using `opaque_segment`. No query, streaming, model
passthrough, mapped path, caller header, request transform or tariff is qualified.
The original provider keeps its regional base template and Bedrock SigV4 scheme;
the runtime resolves and checks the exact signed region/origin after selecting
the original credential. The compiler does not select or authorize a region.

The finite registered identities are the ten actual codec/runtime fixture rows:

- `amazon.titan-embed-text-v2:0`, `amazon.titan-embed-text-v1`,
  `amazon.titan-embed-g1-text-02`, `amazon.titan-embed-image-v1`.
- `cohere.embed-english-v3`, `cohere.embed-multilingual-v3`, `cohere.embed-v4:0`.
- `amazon.nova-2-multimodal-embeddings-v1:0`.
- `us.twelvelabs.marengo-embed-2-7-v1:0`, `twelvelabs.marengo-embed-3-0-v1:0`.

Each card uses `bedrock/<exact upstream identity>`, only `llm.embeddings`, and
unknown pricing. The US Marengo 2.7 profile is explicit; it does not authorize a
bare model or other regional profiles. `isBedrockEmbeddingModel` recognizes more
native family/profile shapes to prevent generic Invoke bypasses. Recognition
does not make those identities eligible for registration, account access or
this finite declaration.

The shared capability-aware matcher resolves the Invoke path by the selected
registered model. Existing generic Invoke and eventstream rows remain unchanged.
The native body is never treated as an OpenAI embedding request. Text-only
Cohere v4 keeps qualified dimensions and LEFT/RIGHT/NONE truncation; Marengo 2.7
keeps flat `inputText`, while 3.0 uses nested `text.inputText`. The existing codec
and wrapper own those family shapes, batch limits and complete ordered vectors.

Upload/response bytes, vector dimensions and batch counts are not token ceilings.
Only the wrapper's qualified Titan input token observation survives as usage;
it does not establish a tariff. Both hard-dollar budgets reject unknown costs,
and explicit `policy_fixed` remains separate. No defaults, dollar prices,
regional entitlement or current availability are inferred from synthetic rows.

Seven composed tests use the actual compiler, shared model predicate/matcher,
native selection, source codec and wrapper. They preserve original native JSON,
all vector observations and existing Invoke cards. Source1 already owns signed
dispatch and real Worker admission/accounting proof; this foundation does not
duplicate that controller. Existing-provider YAML activation needs its runtime
fixture to tolerate the declared endpoint and model rows, followed by source6's
serialized snapshot and source2's actual native memory consumer. No YAML,
generated snapshot, shared runtime, credential or live request changes here.
