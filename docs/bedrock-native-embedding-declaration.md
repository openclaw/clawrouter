# Bedrock text embedding declaration

The existing AWS provider adds `embed_text` using the qualified
[native embedding contract](bedrock-embedding-schema.md), the landed native
codec/response wrapper and the existing signed runtime. Generic Invoke and
eventstream declarations remain unchanged. No new auth mode, region selector,
OpenAI wire alias or model-profile grammar is introduced.

The first declaration includes nine frozen identities. Titan Multimodal
`amazon.titan-embed-image-v1` remains excluded until its complete native response
qualifies the documented `message` error signal. The compiler still recognizes
its frozen compatibility fixture; that does not publish an executable card.

Primary model cards checked 2026-11-04:

| Exact registered upstream | Primary model card |
| --- | --- |
| `amazon.titan-embed-text-v2:0` | [Titan V2](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-titan-text-embeddings-v2.html) |
| `amazon.titan-embed-text-v1` | [Titan G1](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-titan-embeddings-g1---text.html) |
| `amazon.titan-embed-g1-text-02` | [Titan G1 Text v2](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-titan-text-embeddings-v2-2.html) |
| `cohere.embed-english-v3` | [Embed English](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-cohere-embed-english.html) |
| `cohere.embed-multilingual-v3` | [Embed Multilingual](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-cohere-embed-multilingual.html) |
| `cohere.embed-v4:0` | [Embed v4](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-cohere-embed-v4.html) |
| `amazon.nova-2-multimodal-embeddings-v1:0` | [Nova Multimodal Embeddings](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-amazon-nova-multimodal-embeddings.html) |
| `us.twelvelabs.marengo-embed-2-7-v1:0` | [Marengo 2.7, explicit US inference profile](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-twelvelabs-marengo-embed-v2-7.html) |
| `twelvelabs.marengo-embed-3-0-v1:0` | [Marengo 3.0](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-twelvelabs-marengo-embed-3-0.html) |

These sources qualify the selected identities and text-input modality. They do
not grant account access or promise every Region. Marengo 3.0 is Legacy in
`ap-northeast-2`, with a regional EOL date of 2027-03-22; its card describes other
Regions as Active. No global retirement or alias is inferred. Marengo 2.7 Invoke
uses an inference profile; this slice registers only the exact US profile from
the native fixture. The common runtime keeps original credential and signed
region/origin binding; regional availability and account authorization remain
upstream facts, not inferred entitlement.

Only text input is advertised, including for the multimodal families. Context
limits, dimensions and batch bounds are not copied into token-pricing fields.
Prices remain absent/unknown. Both caller and provider hard-dollar budgets deny
these offers; explicit `policy_fixed` stays separately labeled. No live calls,
credential provisioning or dollar charge probes are part of qualification.

Declaration cases compose the actual YAML, model matcher, codec wrapper,
complete vector replies and budget admission. Signed Worker fixtures consume
the generated declaration to exercise credentials, dispatch, response bounds,
usage and cancellation. These deterministic tests do not establish actual
OpenClaw memory-client or live account parity.
