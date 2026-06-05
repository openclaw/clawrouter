# ClawRouter

ClawRouter is a high-throughput API gateway and provider router for OpenClaw services.

It brokers proxy keys, service identities, provider credentials, OAuth grants, budgets, and metered usage across model providers, search APIs, tool APIs, and future service providers.

Current implementation target:

- Rust/Wasm data plane on Cloudflare Workers
- Durable Object budget ledgers
- TypeScript admin/control UI
- declarative service provider manifests
- OpenClaw-native `clawrouter-` key routing
- Cloudflare KV-backed key policy and revocation

## Provider Registry

Provider support is data-driven. Most integrations are added by creating one file:

```text
providers/<service>.provider.yaml
```

That file declares the service id, auth scheme, OAuth platform mapping when needed,
base URLs, route templates, adapter family, model/capability mapping, and billing
meters. The Rust compiler turns those files into a provider snapshot consumed by
the edge runtime and admin UI.

Built-in starter coverage:

- model APIs: OpenAI, Anthropic, Google Gemini, Azure OpenAI, AWS Bedrock,
  MiniMax, Mistral, Cohere, xAI, Groq, Perplexity, DeepSeek, Together, Fireworks,
  Hugging Face, Replicate
- gateway APIs: OpenRouter, Cloudflare AI Gateway
- tool/API platforms: Tavily, GitHub, Slack, Linear, Notion

Validate the catalog with:

```sh
cargo run -p clawrouter -- provider compile providers/*.provider.yaml
```

## Edge Proxy

The Worker currently exposes:

- `GET /v1/health`
- `GET /v1/providers`
- `GET /v1/key/inspect`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`

OpenAI-compatible proxy requests route by the request body `model` field, for
example `openai/gpt-5.5-mini`. Before an upstream provider secret is used, the
Worker checks `POLICY_KV` at `keys/<kid>` for:

```json
{
  "enabled": true,
  "secretSha256": "<sha256 of key secret>",
  "providers": ["openai"]
}
```

Flip `enabled` to `false` to revoke a key without rotating upstream provider
credentials. See `docs/deploy-cloudflare.md` for Cloudflare provisioning,
deployment, key registration, and smoke commands.
