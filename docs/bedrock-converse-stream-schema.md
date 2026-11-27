# Buffered Bedrock ConverseStream schema

The exact native request/response formats are `aws_bedrock.converse_stream`
and `aws_bedrock.converse_eventstream`. The route is POST
`/model/${model}/converse-stream`, with one `model` path parameter using
`opaque_segment`. Explicit `llm.chat` capability binds the selected registered
model. Existing Invoke eligibility does not imply Chat eligibility.

The compiler permits one unary Converse endpoint and one ConverseStream endpoint
with distinct native formats. It rejects mixed pairs, duplicate transports,
SSE/WebSocket aliases, query/header or origin overrides, model passthrough,
lifecycle links and unqualified tariffs. The original regional Bedrock SigV4
service and credential selection remain authoritative. Model preparation must
finish before exact payload serialization and signing.

`streaming` remains unset. This matches the actual
`prepareNativeBedrockConverseStream(selection, { origin })` leaf published in
[PR763](https://github.com/openclaw/clawrouter/pull/763) at
`ef4e62c4ab9be34a0640d6a5f70cc77d935da92a`: the native EventStream response is
quarantined until complete bounded EOF, frame validation and successful codec
inspection. It does not promise incremental delivery. The leaf owns its 2 MiB
wire/decoded bounds and response lease; common runtime owns intake, original
region, signing order, deadlines, admission and lifetime accounting.

Focused compiler cases use the landed `decodeBedrockEventFrame`, existing frame
fixture, `prepareBedrockConverseRequest` and `createBedrockConverseDecoder`.
They check native/manifest selection, opaque declared IDs, pre-signing payload
identity, complete usage evidence, invalid declarations and unknown-dollar
admission. They do not substitute for the separately owned wrapper's complete
quarantine, cancellation or modeled-error tests.

No AWS YAML or generated snapshot is activated. No ARN/profile discovery,
new model universe, OpenAI alias, tariff, common factory or client streaming
claim is introduced. Source-owned runtime qualification and actual consumer
proof remain separate. Explicit policy-fixed costs stay distinct from unknown
upstream dollar prices.
