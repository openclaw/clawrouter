# Native decision providers

The `levanto`, `liquid-ai` and `typesafe` manifests declare native decision
products. They use the codecs in [native-decision-codecs.md](native-decision-codecs.md).
They are not Chat Completions or OpenAI Decisions aliases.

| ID | Endpoint wire | Client protocol | Model binding |
| --- | --- | --- | --- |
| `levanto` | `sage.decide`, `sage.decide_batch` | `levanto-sage` | `levanto-sage-2`, server-selected |
| `liquid-ai` | `systemone.decisions` | `liquid-ai-systemone` | `d1.1` |
| `typesafe` | `systemone.decisions` | `typesafe-systemone` | `jev-latest`, moving alias |

Each product has its own API key and base URL. Prices remain unknown in these
manifests. Published output-free decision pricing does not make input free.
Model enablement, plan limits and live account access remain separate facts.

## Integration requirements

These manifests must not land as activated providers until the shared runtime
dispatches their formats through the native codecs and real Worker/client tests
pass. The schema/compiler owner must qualify the client protocols before adding
native capability facts. Do not fill the gap with `openai-decisions` metadata.

Sage's `llm.decisions.batch` capability selects `/decide/batch`; it is distinct
from the single-question `/decide` operation. Admit the catalog model and policy
first, then remove the router model selector before `prepareSageRequest`: the
Sage wire has no model field. Its batch response observes only top-level usage.
SystemOne binds the selected model through `prepareSystemOneRequest`; the selected
provider determines the Liquid/TypeSafe codec policy.

The current codec slice supports text/JSON SystemOne state and Sage text/list
content. Native model facts must advertise that implemented subset. Images,
additional TypeSafe question types and Sage WebSocket streaming need their own
admission and actual consumer proof. No model lifecycle or host provisioning is
part of these manifests.

`worker/test/native-decision-providers.test.mjs` compiles the manifests and checks
selected credentials, native URLs and typed codec composition. This is a focused
contract check, not an end-to-end Worker or client proof. Shared smoke templates,
runtime dispatch/accounting, catalog metadata, actual DecisionV2 bridge fixtures,
all-manifest validation and serialized snapshot integration remain landing gates.

Primary sources checked on 2026-11-03:
[Sage quickstart](https://docs.levanto.ai/quickstart),
[Sage batch](https://docs.levanto.ai/decision-model/batch),
[Liquid d1](https://docs.liquid.ai/lfm/models/d1), and
[TypeSafe OpenAPI](https://api.typesafe.ai/openapi.json).
