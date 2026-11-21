# Frozen Nova Lite Converse declaration

The existing card `bedrock/amazon.nova-lite-v1:0`, upstream
`amazon.nova-lite-v1:0`, explicitly supports `llm.chat` on two native endpoints:

| Endpoint | Request format | Response format | Path |
| --- | --- | --- | --- |
| `converse` | `aws_bedrock.converse` | `aws_bedrock.converse` | `/model/${model}/converse` |
| `converse_stream` | `aws_bedrock.converse_stream` | `aws_bedrock.converse_eventstream` | `/model/${model}/converse-stream` |

Both use POST, the existing opaque `model` segment, regional origin and SigV4
service. `streaming` remains unset for ConverseStream: the qualified wrapper
quarantines the complete bounded EventStream before delivery. Neither endpoint
uses model passthrough, query overrides, lifecycle links or a request tariff.
The existing Invoke and InvokeStream endpoints and pricing reference stay intact.

## Model-specific provenance

Primary-source verification supplied by the campaign coordinator on
2026-11-04 at 01:18 UTC establishes this exact model's transport support:

- [Amazon Nova Converse guide](https://docs.aws.amazon.com/nova/latest/userguide/using-converse-api.html)
  names Amazon Nova V1 Lite and `amazon.nova-lite-v1:0` for Converse and
  ConverseStream.
- [AWS bare-ID ConverseStream example](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-runtime_example_bedrock-runtime_ConverseStream_AmazonNovaText_section.html)
  selects that exact bare ID in `us-east-1`; no inference-profile alias is needed
  for the scoped fixture.
- [Amazon Nova Lite model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-lite.html)
  identifies the exact active model, Converse, response streaming and in-region
  `us-east-1` support.

These facts qualify transport support, not an account grant, live availability,
regional entitlement, invoice or price. The frozen OpenClaw baseline remains
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`; this change adds no model identity,
profile alias, context limit, image/tool/thinking declaration or tariff. Native
Claude signed-reasoning facts are not assigned to Nova Lite.

## Runtime and proof boundary

The declaration consumes the landed unary/stream wrappers and compiler contracts
from [PR756](https://github.com/openclaw/clawrouter/pull/756),
[PR763](https://github.com/openclaw/clawrouter/pull/763),
[PR757](https://github.com/openclaw/clawrouter/pull/757) and
[PR765](https://github.com/openclaw/clawrouter/pull/765). Actual shared dispatch is the published
[PR776](https://github.com/openclaw/clawrouter/pull/776) contract, qualified at
`415eb1a56ec79bba20d3fa4dd86a8064bbb8d697` and landed as
`ecefad76f02039e57e11967b2e02a9a71483cd12`. This declaration is based on that
actual squash. Generated snapshot activation remains separately serialized.

Prepared declaration tests compile the actual Nova card and select it through
the real Worker on native and manifest unary/stream routes. Synthetic responses
contain native text and token counts, without Claude reasoning fields. Cases
check the selected environment or owner-grant credential, original regional
origin, payload preparation before signing, complete byte delivery, policy-fixed
settlement, unknown-dollar denial and refusal to inherit Chat from Invoke.
The existing protocol/frame/unary tests are not re-run as evidence for this slice.

The nine-model native embedding candidate stays on its separate branch. It does
not inherit `llm.chat`. Actual Pi strict-proxy caller acceptance remains the
client and integration owners' separate requirement. Prepared source is not
hosted execution, live AWS proof or completed end-to-end parity.
