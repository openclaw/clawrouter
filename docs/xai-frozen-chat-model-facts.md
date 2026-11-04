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

## Serialized integration and actual-client scope

Original source `a99fc89075b560e78c643d414f9e2b96e744a41c` is composed
onto qualified `65358a7750e4bd05236ed3849b4d41fa7dfe8b1a` with source
authorship and exact model declarations preserved. All 87 manifests compile.
Generated snapshot SHA256:
`848a410099984b199f34b26df1f4837d52435f4c0e48068f7785107e1caf76ec`.

Local proof passes all eight focused cases, Worker types and 1,072 compiler,
Chat-matrix and consumer-selection cases. A real workerd JSON test exercises all
five models through native and manifest routes, exact original credentials,
seven-micro policy-fixed receipts with 11/3/14 observed usage, and caller/provider
hard-dollar rejection before egress. One source fixture assertion was corrected:
xAI's qualified local error is HTTP400 with `error.code: pricing_required`;
the separate native-error header is specific to OpenAI/Anthropic envelopes.
The exact body and zero-egress assertions remain intact; no runtime changed.

Fifteen actual registered xAI client cases are enrolled against public source
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb`. They import the actual static
catalog, registered stream hook, replay sanitizer and Chat serializer. Cases
cover all five identities, inline image bytes, low/xhigh efforts on Grok 4.6,
ordinary client function `x_search`, tool history, fragmented SSE, terminal
usage, proxy-key/model/budget denials, embedded errors and post-delivery
cancellation. Final-head hosted execution and outer SQLite accounting are
required; authored cases alone are not proof.

The client is explicitly configured for the proxy Chat route. Its default
Responses route, hosted search, OAuth/subscription discovery and manifest-client
selection remain separate. A function name is not hosted-tool authority. Frozen
client tariff/limit hints do not qualify server billing; all five server prices
remain unknown and hard-dollar admission stays closed. No new SDK report, local
install, live request, account change or deployment is performed.

The first actual run passed all fifteen client cases but exposed an integration
fixture mismatch: the xhigh case selected Grok 4.5. Both frozen `31ad71a8` and
pinned `d8bb9394` use identical model-ID rules and runtime compatibility code
that map Grok 4.5 xhigh requests to high; Grok 4.6 preserves xhigh. The fixture
now selects Grok 4.6 for the unchanged positive xhigh wire assertion. This
consumer does not certify Grok 4.5 xhigh delivery, regardless of the separate
server declaration. No client, runtime, provider declaration or snapshot changes.
