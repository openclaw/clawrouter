# Frozen xAI Chat model facts

E01 adds exactly five frozen identities to the existing global xAI Chat route.
The default remains `grok-4.3`. No Responses endpoint, multi-agent model, regional
endpoint, alias, hosted-tool admission flag or new media operation is added.

Primary model pages checked 2026-11-04:

| Selected identity | Context tokens | Input | Configurable reasoning efforts / default |
| --- | ---: | --- | --- |
| [grok-4.6](https://docs.x.ai/developers/models/grok-4.6) | 500,000 | Text, image | low, medium, high, xhigh / high |
| [grok-4.5](https://docs.x.ai/developers/models/grok-4.5) | 500,000 | Text, image | low, medium, high, xhigh / high |
| [grok-build-0.1](https://docs.x.ai/developers/models/grok-build-0.1) | 256,000 | Text, image | No configurable list qualified |
| [grok-4.20-0309-reasoning](https://docs.x.ai/developers/models/grok-4.20-0309-reasoning) | 1,000,000 | Text, image | No configurable list qualified |
| [grok-4.20-0309-non-reasoning](https://docs.x.ai/developers/models/grok-4.20-0309-non-reasoning) | 1,000,000 | Text, image | Non-reasoning model; no effort list added |

All five pages document client function calling and text output. The existing
[legacy Chat transport](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions)
remains available. Model identity and caller content are preserved; the published
aliases do not authorize silent rewrites. Input facts neither fetch remote assets
nor prove a live model or actual-client capability.

## Cost qualification remains separate

The [pricing table](https://docs.x.ai/developers/pricing) publishes these USD
rates per million tokens, with the higher rates applying to every token once
prompt length reaches 200,000:

| Identity | Short input / cached / output | Long input / cached / output |
| --- | --- | --- |
| grok-4.6 | 2 / 0.50 / 6 | 4 / 1 / 12 |
| grok-4.5 | 2 / 0.30 / 6 | 4 / 0.60 / 12 |
| grok-build-0.1 | 1 / 0.20 / 2 | 2 / 0.40 / 4 |
| Both frozen 4.20 variants | 1.25 / 0.20 / 2.50 | 2.50 / 0.40 / 5 |

The US regional endpoint has a separate 1.1x token premium. None of these unit
rates, context facts or account rate limits establish an output-token reservation
contract, a caller-selected tier tariff or a whole-request hard-dollar bound.
No output maximum is advertised or invented from another model. These rows
therefore remain explicitly unpriced until those contracts are qualified.

Both caller and provider hard-dollar budgets reject them before upstream fetch.
Authorized `policy_fixed` accounting remains distinct from upstream billing.
Ordinary client functions are not classified as hosted execution merely by name.
The independent Responses violation fee, hosted-tool charges, retained-file and
ancestry bounds remain in their existing request-tariff/runtime work; this Chat
card change does not clear any of them or activate the pending Responses YAML.

Focused tests compose the actual compiler and existing model selector, preserve
original global credentials, and exercise real Worker zero-egress budget denial
plus explicitly fixed native/manifest JSON/SSE accounting. These are deterministic
fixtures, not live inference or actual downstream-client proof. Source6 owns
serialized snapshot integration and source2/6 own actual-client acceptance.
