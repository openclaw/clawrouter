# Operator-hosted gateway transport

Bifrost and LiteLLM expose experimental Chat Completions/SSE routes with their
own virtual keys. They need a running, authenticated gateway reachable from the
Worker. A hosted Worker cannot reach a user's loopback address. These manifests
do not install, start, tunnel, manage or authenticate a local gateway runtime.

| ID | Required bindings | Base URL shape | Bundled catalog alias |
| --- | --- | --- | --- |
| `bifrost` | `BIFROST_API_KEY`, `BIFROST_BASE_URL`, `BIFROST_MODEL` | `https://gateway.example.com/openai` | `bifrost/configured` |
| `litellm` | `LITELLM_API_KEY`, `LITELLM_BASE_URL`, `LITELLM_MODEL` | `https://gateway.example.com/v1` | `litellm/configured` |

Set each URL to the selected OpenAI-compatible API base, without a trailing
slash; the route appends `/chat/completions`. Set the model binding to an alias
actually configured on that gateway. The catalog alias resolves that binding;
it does not claim a model is installed. Other unified model names strip only the
gateway prefix. Native `/v1/native/<id>/chat/completions` preserves upstream IDs.
Missing URL, key or configured-model binding fails closed.

Bifrost's primary SDK documentation uses `/openai`, while some deployments use
`/openai/v1`; configure the base for the deployed version. Bind the Bifrost
virtual key explicitly as `BIFROST_API_KEY`. No implicit `BIFROST_VIRTUAL_KEY`,
direct-provider key, or local unauthenticated fallback is read. LiteLLM uses a
gateway virtual key and its deployment's aliases. Administrative master keys,
key creation, JWT/OIDC lifecycle, BYOK management and gateway databases are not
configured by these manifests.

These gateways can call paid providers. They deliberately do not reuse
`local-openai` zero-API-charge pricing. Both the configured model and unknown
aliases remain unpriced: hard budgets need an explicit fixed policy request
price; unmetered policies can use the transport. That price is a router policy,
not proof of gateway spend, subscription quota or upstream cost.

Primary contracts were checked on 2026-11-03. Actual deployment reachability,
gateway version, routing policy, credential scope, tools/reasoning, terminal
stream usage, cancellation and whole-request settlement need end-to-end and
live qualification. Chat transport does not implement Bifrost async jobs,
LiteLLM management, MCP, native runtime or non-Chat API parity.

- [Bifrost OpenAI integration](https://docs.getbifrost.ai/integrations/openai-sdk/overview)
- [LiteLLM gateway quickstart](https://docs.litellm.ai/docs/proxy/docker_quick_start)
