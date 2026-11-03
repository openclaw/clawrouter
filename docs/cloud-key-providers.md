# Cloud and subscription API-key routes

These experimental manifests expose only documented Chat Completions/SSE
contracts. References were checked on 2026-11-03. They do not implement identity
onboarding, token refresh, resource provisioning or native agent runtimes.

| ID | Credential binding | Endpoint | Bundled model |
| --- | --- | --- | --- |
| `amazon-bedrock-mantle` | `BEDROCK_MANTLE_API_KEY` | `https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions` | `openai.gpt-oss-120b` |
| `microsoft-foundry` | `MICROSOFT_FOUNDRY_API_KEY` | `${MICROSOFT_FOUNDRY_ENDPOINT}/openai/v1/chat/completions` | Operator's `MICROSOFT_FOUNDRY_DEPLOYMENT` |
| `kimi` | `KIMI_CODING_API_KEY` | `https://api.kimi.ai/coding/v1/chat/completions` | `k3.1-pro` |

Unified models prepend the provider ID. Foundry's bundled catalog alias is
`microsoft-foundry/deployment`; it resolves to the configured deployment name.
Use the resource root without a trailing slash or `/openai/v1` suffix for
`MICROSOFT_FOUNDRY_ENDPOINT`. Native `/v1/native/<id>/chat/completions` callers
supply upstream model/deployment IDs. Other names pass through unpriced.

## Boundaries

- **Bedrock Mantle:** uses a Bedrock API key as Bearer auth in the fixed US East
  region. Configure that credential explicitly; neither `OPENAI_API_KEY` nor
  `AWS_BEARER_TOKEN_BEDROCK` is an implicit fallback. Mantle is distinct from the
  existing `aws-bedrock` SigV4 Invoke/EventStream routes. IAM credential discovery,
  bearer-token generation/expiry refresh and regional discovery are unimplemented.
  AWS recommends bedrock-runtime for new applications; this family preserves
  Mantle's separate compatibility contract. Some models use `/openai/v1` instead
  of `/v1`; the bundled example uses the documented `/v1` Chat route. Responses,
  Messages, alternate-prefix models and guardrail-header binding need separate
  qualification.
- **Microsoft Foundry:** uses the resource's `api-key` header. The operator must
  name the deployed model; a public model name is not deployment discovery.
  Azure OpenAI keys from another resource are not read automatically. Entra ID,
  Azure CLI refresh, tenant/audience selection, deployment discovery, Anthropic
  and MAI image endpoints are separate contracts. Missing endpoint or deployment
  bindings fail closed rather than selecting a default resource.
- **Kimi Coding:** `kimi` is the coding-plan family, distinct from the `moonshot`
  standard API. This manifest uses the overseas endpoint and a dedicated coding
  key binding; mainland `.com`, generic `KIMI_API_KEY`, membership login and plan
  upgrades are not selected automatically. The documented `k3.1-pro` model needs
  an eligible plan and thinking enabled. No client identity is impersonated and
  no upstream restriction is bypassed. A provider entitlement or client rejection
  remains an error. Native Responses, Anthropic Messages and CLI sessions are
  not supplied by this Chat route.

No price or capability facts are inferred from static OpenClaw declarations.
Hard-budget calls require explicit policy fixed request pricing; unmetered
policies can use these routes. A policy charge does not prove upstream cost or
subscription quota usage. Live entitlement, tools/reasoning, terminal stream
usage, cancellation and monetary settlement remain unqualified.

## Primary references

- [AWS Chat APIs and Mantle prefixes](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html)
- [Foundry deployment endpoint and API-key example](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/hugging-face-models)
- [Foundry Chat authentication](https://learn.microsoft.com/en-us/azure/foundry/openai/latest)
- [Kimi Coding models, endpoints and plan requirements](https://www.kimi.com/code/docs/en/kimi-code/models)
