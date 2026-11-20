# Specialist hosted Chat APIs

These experimental manifests expose Chat Completions and SSE; Synthetic also
declares [native Messages and discovery](synthetic-native-contracts.md). Primary contracts
were checked on 2026-11-03. Live inference, account entitlement and monetary
settlement have not been qualified.

| Provider | Key binding | Chat API base URL | Catalog model → upstream request model |
| --- | --- | --- | --- |
| `abliteration` | `ABLITERATION_API_KEY` | `https://api.abliteration.ai/v1` | `abliteration/abliterated-model-large-v2` → `abliterated-model-large-v2` |
| `meta` | `MODEL_API_KEY` | `https://api.meta.ai/v1` | `meta/muse-spark-1.3` → `muse-spark-1.3` |
| `synthetic` | `SYNTHETIC_API_KEY` | `https://api.synthetic.new/openai/v1` | `synthetic/syn:large:text` → `syn:large:text` |
| `particle` | `PARTICLE_API_KEY` | `https://api.particle.ai/v1` | `particle/particle-ai/particle-1` → `particle-1` |

Each appends `/chat/completions`. Native routes use
`/v1/native/<provider>/chat/completions` and preserve the supplied upstream model
ID. Unified requests resolve bundled IDs using the table. Unknown model IDs pass
through without inferred prices or native facts. Stored API-key grants remain
provider-scoped; another provider's key is never a fallback.

## Product boundaries

- Abliteration accepts canonical `ABLIT_KEY` or legacy `ABLITERATION_API_KEY` as
  alternative server bindings for the same credential. Either satisfies
  readiness; when both are present, the canonical value wins. A malformed
  canonical value fails closed rather than falling back to the legacy value.
  The original selected grant remains authoritative over both server bindings;
  a missing or invalid selected grant credential never borrows either value.
  These aliases do not select a subscription plan or authorize another provider.
  Large v2 is a distinct model from the deprecated Large model. Responses,
  Messages, provider policies and server search are separate contracts.
- Meta uses the Model API key, not a third-party Llama hosting key. Its Chat
  protocol does not replay reasoning across turns. Preserving request fields in
  the router does not change that upstream limitation. Responses state and
  encrypted reasoning, Messages, built-in tools and audio/video need separate
  qualification.
- Synthetic's `syn:large:text` is a provider-managed moving alias. It is not a
  fixed model version or price. One service origin and original grant serve
  distinct OpenAI Chat/model-list and Anthropic Messages dispatch paths. Native
  Messages preserves its own wire format; subscription quota APIs, search and
  embeddings are separate contracts.
- Particle's catalog and responses name `particle-ai/particle-1`; its request
  documentation says to send `particle-1`. The bundled row maps those IDs
  explicitly. Native callers must supply the documented request ID themselves.
  The global endpoint is selected here. The separate US endpoint has its own
  placement contract even though the provider documents the same API key.
  Responses WebSockets, mid-turn steering, files and native runtime behavior are
  not implemented by this Chat manifest.

No rate cards, context limits or modality badges are inferred. Hard-budget calls
need an explicit policy fixed request price; unmetered policies can use these
routes. A fixed router charge is not authoritative upstream cost. Tool/reasoning
behavior, terminal streaming usage, cancellation and whole-request settlement
remain separate end-to-end and live proof gates.

## Primary references

- [Abliteration quickstart](https://docs.abliteration.ai/quickstart)
- [Abliteration models](https://docs.abliteration.ai/models)
- [Meta Chat quickstart](https://dev.meta.ai/docs/cookbook/quickstart-chat-completions)
- [Meta protocols](https://dev.meta.ai/docs/protocols)
- [Synthetic API overview](https://dev.synthetic.new/docs/api/overview)
- [Particle API and model IDs](https://docs.particle.ai/)
