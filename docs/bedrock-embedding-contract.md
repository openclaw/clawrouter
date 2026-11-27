# Native Bedrock embedding contract

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/amazon-bedrock/embedding-provider.ts` and
`memory-embedding-adapter.ts`. This is the text memory-embedding surface,
including text input to multimodal models. Audio/video/S3 async embedding,
arbitrary model families and OpenAI-format translation are outside this slice.

The finite IDs are exported by `worker/provider-bedrock-embeddings.ts`:

- `amazon.titan-embed-text-v2:0`, `amazon.titan-embed-text-v1`,
  `amazon.titan-embed-g1-text-02`, `amazon.titan-embed-image-v1`.
- `cohere.embed-english-v3`, `cohere.embed-multilingual-v3`,
  `cohere.embed-v4:0`.
- `amazon.nova-2-multimodal-embeddings-v1:0`.
- `twelvelabs.marengo-embed-2-7-v1:0`,
  `twelvelabs.marengo-embed-3-0-v1:0`.

## Wire and result

`prepareBedrockEmbedding(modelId, body)` validates the native family shape
and returns the unchanged body, dimensions/count contract, non-secret JSON
headers and encoded `/model/{modelId}/invoke` path. Existing runtime owns
credential selection, region/origin qualification and authentication/signing.
Model identity remains exact through profile/throughput suffixes; resolving
a family never authorizes another profile or region. Unknown models and ARNs
are rejected instead of defaulting to a Titan wire.

| Family | Native input | Native vector |
| --- | --- | --- |
| Titan v1 / image text mode | inputText | embedding |
| Titan v2 | inputText, dimensions, normalize | embedding |
| Cohere v3 | texts, input_type, truncate | embeddings[] |
| Cohere v4 | texts, input_type, float type, output_dimension | embeddings[] or embeddings.float[] |
| Nova | SINGLE_EMBEDDING, singleEmbeddingParams.text | embeddings[0].embedding |
| Marengo 2.7 | inputType:text, inputText | data.embedding / single data entry |
| Marengo 3.0 | inputType:text, text.inputText | data.embedding / single data entry |

The request envelope is bounded to 2 MiB and Cohere batches to 96 texts.
These are byte/item limits, not token or monetary bounds. Float vectors only;
binary/quantized responses cannot masquerade as numeric float memory vectors.
The runtime must bound native response bytes (at most 8 MiB for this slice)
before parsing and pass complete EOF evidence to
`observeBedrockEmbedding(value, request, complete)`.

Observation validates the entire batch, ordered count, exact requested/default
dimensions and finite numbers before returning any vectors. It never normalizes
or rewrites native vectors. The memory consumer owns normalization. API errors,
partial EOF and malformed later rows invalidate the full observation.
Only valid Titan `inputTextTokenCount` is reported as input-token evidence.
Vector size, truncation diagnostics and unrelated usage fields are not tokens.

## Frozen-client corrections

Primary AWS documentation exposes concrete mismatches in the frozen client:

- Marengo 2.7 requires flat `inputText`; the frozen shared TwelveLabs builder
  emits the 3.0 nested shape for both. Keep version-specific codecs.
- Cohere v4 documents dimensions 256/512/1024/1536, excluding the frozen 384/768
  choices. Its AWS parameter page lists NONE/LEFT/RIGHT truncation, while the
  frozen client emits END for both Cohere versions. This adapter follows the
  documented v4 shape and keeps v3 NONE/START/END. Native live acceptance remains
  an integration proof boundary, not a reason to guess a cross-family rewrite.
- Marengo 2.7 synchronous Invoke requires a qualified inference profile, and its
  documented text limit differs from the frozen generic token metadata. Regional
  availability and model facts belong to existing manifest/client owners.

The ten sanitized wire/result rows in
`providers/_fixtures/amazon-bedrock/embeddings.json` contain full synthetic
vectors at valid dimensions. Seven tests cover each model, input differences,
profile identity, dimensions, full-batch rejection and conservative token evidence.

## Integration owners and billing

Existing Bedrock YAML/model facts belong to the manifest owner; the common
runtime owns dispatch and usage integration. Route by exact selected model
family through existing Invoke infrastructure, retaining policy/grant/credential
lineage. Do not change Converse or existing common files for this slice.
The memory client owner must consume these native fixtures and correct the
version-specific builders. Actual Worker and frozen-client tests remain required.

This PR adds no provider activation, snapshot, live credential use or deployment.
No whole-request USD tariff/bound is qualified. Native token counts do not prove
a monetary rate, and absent counts are unknown. Upstream-dollar hard budgets stay
closed until the selected model's admission and tariff are qualified;
`policy_fixed` remains a separate charge basis.

Primary evidence checked 2026-11-03:

- [Titan request and token counter](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-titan-embed-text.html)
- [Cohere v3](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-embed-v3.html)
- [Cohere v4](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-embed-v4.html)
- [Nova synchronous schema](https://docs.aws.amazon.com/nova/latest/userguide/embeddings-schema.html)
- [Marengo 2.7](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-marengo.html)
- [Marengo 3.0 migration](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-marengo-3.html)
