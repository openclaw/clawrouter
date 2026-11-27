# Hosted model catalogs

These experimental manifests implement API-key Chat Completions and SSE only.
Endpoint and example-model references were checked on 2026-11-03; no live
upstream qualification is claimed.

| Provider | Credential binding | Base URL | Initial upstream model |
| --- | --- | --- | --- |
| `arcee` | `ARCEEAI_API_KEY` | `https://api.arcee.ai/api/v1` | `trinity-mini` |
| `chutes` | `CHUTES_API_KEY` | `https://llm.chutes.ai/v1` | `deepseek-ai/DeepSeek-V4-Flash-0731-TEE` |
| `featherless` | `FEATHERLESS_API_KEY` | `https://api.featherless.ai/v1` | `GalrionSoftworks/Margnum-12B-v1` |
| `venice` | `VENICE_API_KEY` | `https://api.venice.ai/api/v1` | `zai-org-glm-5-2` |

Each request appends `/chat/completions` to the base URL and uses Bearer auth.
Use a provider-scoped stored API-key grant or the named environment binding.
Unified model IDs prepend the provider; native requests preserve the full opaque
upstream ID at `/v1/native/<provider>/chat/completions`.

Model passthrough does not invent catalog entries, capability facts, entitlement,
or pricing. No rate cards are bundled. Hard-budget requests require an explicit
policy fixed request price; unmetered policies can use these routes. Fixed router
charges are not measured upstream costs. Live model access, tool/reasoning replay,
stream usage completeness, and monetary accounting remain qualification gates.

## Separate products and contracts

- Arcee Platform API keys and `trinity-mini` are distinct from Conductor routing
  endpoints and OpenRouter-hosted Arcee models. No routing fallback substitutes
  another provider's credential.
- Chutes API keys use the hosted inference endpoint. Sign-in-with-Chutes OAuth
  requires a separate authorization/refresh contract. Public model discovery
  does not prove key validity or model entitlement. A `TEE` model suffix alone
  does not establish attestation; no confidentiality badge is emitted.
- Featherless plans can use subscription capacity or request pricing. Model
  access can also require Hugging Face gating approval. An HF token is not the
  Featherless API key. Its current documentation shows terminal SSE usage and
  a plan-dependent `usage.cost`; neither is assumed to be a qualified USD rate
  card or guaranteed account entitlement.
- Venice API-key inference is separate from DIEM allowances, wallet/x402 payments,
  balance APIs, Responses, Decisions and media. No wallet signing, staking or
  account changes are performed. Historical client metadata marked streaming
  usage unsupported; live terminal-usage evidence is required before promising
  metered streaming parity.

## Primary references

- [Arcee first call](https://docs.arcee.ai/api-reference/your-first-api-call)
- [Arcee streaming](https://docs.arcee.ai/capabilities/streaming-messages)
- [Chutes hosted API](https://www.chutes.ai/docs/help/faq)
- [Chutes catalog and TEE selection](https://www.chutes.ai/integrations)
- [Featherless completions and streaming](https://featherless.ai/docs/completions)
- [Featherless catalog and gating](https://featherless.ai/docs/api-reference-models)
- [Venice API and model catalog](https://docs.venice.ai/overview/about-venice)
