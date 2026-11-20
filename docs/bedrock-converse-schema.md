# Unary Bedrock Converse declarations

This bounded E02 compiler contract consumes the landed Converse codec from
[PR467](https://github.com/openclaw/clawrouter/pull/467), commit
`3c88fe9d027e1e7c0e74e2c78e873f10d82c7116`. The native request and response
format is exactly `aws_bedrock.converse`.

```yaml
capabilities:
  - id: llm.chat
    endpoint: converse
    methods: [POST]
endpoints:
  converse:
    method: POST
    path: /model/${model}/converse
    pathParams: [model]
    pathParamStyles: { model: opaque_segment }
    headers: { content-type: application/json, accept: application/json }
    requestFormat: aws_bedrock.converse
    responseFormat: aws_bedrock.converse
```

This is a compiler fixture, not bundled YAML activation. A model must explicitly
have `llm.chat`; existing `llm.invoke` and `llm.stream` cards do not inherit the
operation. There is no model passthrough, body-selected upstream alias or new
model catalog. A declared model or synthetic test ARN uses the existing opaque
path segment machinery. That encoding does not establish AWS entitlement,
region compatibility or approval of an arbitrary caller-supplied resource.

The provider remains `aws-bedrock`, class `custom_adapter`, with the existing
regional origin template `https://bedrock-runtime.${region}.amazonaws.com` and
original SigV4 service `bedrock`, region parameter `region`. The compiler rejects
origin/service overrides, extra credential schemes, query/header injection,
field renames, mapped paths and lifecycle controls. Converse does not add an
OpenAI-compatible route. Existing Invoke and InvokeStream declarations remain
unchanged.

## Actual codec and shared wiring boundary

The native and manifest compiler cases call
`prepareBedrockConverseRequest(value, selectedUpstream, false)`. Its validated
payload removes `modelId` and `stream` before serialization. The signing case
hashes that exact prepared payload with the existing SigV4 helper. Source1 must
attach source4's future `prepareNativeBedrockConverse(selection, { origin })`
**before** serialization/signing, using the original selected server-owned
regional origin. Compiler tests do not prove this production call order.

`decodeBedrockConverseResponse` validates unary content, signed reasoning and
all tool argument siblings before returning them. A decoded refusal suppresses
content while retaining validated native usage. Cache reads/writes are counted
once, TTL buckets remain separate, and missing required usage stays unknown.
Source4 owns complete bounded HTTP/JSON delivery, sanitized failure responses,
cancellation and lease tests; this slice neither copies nor registers its leaf.

No token, cache, request or account tariff is qualified here. Declared Chat
cards must remain unpriced in this slice; hard upstream-dollar admission denies
unknown cost. Explicit policy-fixed charging remains separately labeled.

## Closed continuations

ConverseStream is not registered. Stream format aliases, EventStream/SSE,
WebSocket and the `/converse-stream` endpoint are rejected. The CRC-validated
complete-frame seam remains a separate source1 contract.

Common dispatch, original credential/region binding, fresh admission,
uncertain-outcome accounting and no-replay proof remain source1-owned. Source2
owns actual repaired native-client replay and source6 owns composed snapshot
qualification. No YAML, snapshots, shared runtime, source4 leaf, live call or
deployment is changed.

Primary wire reference, checked 2026-11-04:
[AWS Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html).
The reference documents the operation; it does not expand the frozen codec's
qualified content surface.
